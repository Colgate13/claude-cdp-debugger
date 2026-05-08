import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, dirname, extname, basename, isAbsolute } from 'node:path';
import { SourceMapConsumer } from 'source-map';

/**
 * Resolves source-map translations between a project's local TypeScript paths
 * and the JavaScript paths that Node Inspector reports as script URLs.
 *
 * Strategy:
 * - For each .ts file the user names, find the matching dist/.js + .js.map.
 * - Use SourceMapConsumer.generatedPositionFor(...) to find the JS line.
 * - Reverse direction (js→ts) is used when reporting paused-frame info.
 *
 * Caches consumers per dist/.js path.
 */
export class SourceMapResolver {
  constructor({ projectRoot, distDirs = ['dist'] }) {
    this.projectRoot = projectRoot;
    this.distDirs = distDirs;
    this._consumers = new Map();
    this._tsToJs = new Map();
  }

  candidateJsPaths(absTsPath) {
    const rel = relative(this.projectRoot, absTsPath);
    if (rel.startsWith('..')) return [];
    const noExt = rel.replace(/\.[mc]?ts$/, '');
    const candidates = [];
    for (const dist of this.distDirs) {
      candidates.push(join(this.projectRoot, dist, noExt + '.js'));
      candidates.push(join(this.projectRoot, dist, basename(noExt) + '.js'));
      candidates.push(join(this.projectRoot, dist, 'src', noExt.replace(/^src\//, '') + '.js'));
    }
    return candidates;
  }

  async _consumerFor(absJsPath) {
    if (this._consumers.has(absJsPath)) return this._consumers.get(absJsPath);
    const mapPath = absJsPath + '.map';
    if (!existsSync(mapPath)) {
      this._consumers.set(absJsPath, null);
      return null;
    }
    try {
      const raw = await readFile(mapPath, 'utf8');
      const json = JSON.parse(raw);
      const consumer = await new SourceMapConsumer(json);
      this._consumers.set(absJsPath, { consumer, mapDir: dirname(mapPath), json });
      return this._consumers.get(absJsPath);
    } catch (err) {
      this._consumers.set(absJsPath, null);
      return null;
    }
  }

  /**
   * Translate a TypeScript file:line to a JavaScript file:line.
   * Returns { jsPath, jsLine, jsColumn } or null if it cannot resolve.
   */
  async tsToJs(absTsPath, tsLine, tsColumn = 0) {
    const cached = this._tsToJs.get(`${absTsPath}:${tsLine}:${tsColumn}`);
    if (cached) return cached;
    const candidates = this.candidateJsPaths(absTsPath);
    for (const jsPath of candidates) {
      if (!existsSync(jsPath)) continue;
      const entry = await this._consumerFor(jsPath);
      if (!entry) continue;
      const { consumer, json } = entry;
      const sourceName = pickSourceName(json, absTsPath, dirname(jsPath));
      if (!sourceName) continue;
      const pos = consumer.generatedPositionFor({ source: sourceName, line: tsLine, column: tsColumn, bias: SourceMapConsumer.LEAST_UPPER_BOUND });
      if (pos.line == null) continue;
      const result = { jsPath, jsLine: pos.line, jsColumn: pos.column ?? 0 };
      this._tsToJs.set(`${absTsPath}:${tsLine}:${tsColumn}`, result);
      return result;
    }
    return null;
  }

  /**
   * Translate a JavaScript file:line back to TypeScript file:line.
   * Used when paused events arrive with JS coordinates and we want TS for output.
   */
  async jsToTs(absJsPath, jsLine, jsColumn = 0) {
    const entry = await this._consumerFor(absJsPath);
    if (!entry) return null;
    const { consumer, mapDir } = entry;
    const orig = consumer.originalPositionFor({ line: jsLine, column: jsColumn });
    if (!orig?.source) return null;
    const tsPath = isAbsolute(orig.source) ? orig.source : join(mapDir, orig.source);
    return { tsPath, tsLine: orig.line ?? null, tsColumn: orig.column ?? null, name: orig.name ?? null };
  }

  destroy() {
    for (const entry of this._consumers.values()) {
      try { entry?.consumer?.destroy?.(); } catch { /* ignore */ }
    }
    this._consumers.clear();
  }
}

function pickSourceName(mapJson, absTsPath, mapDir) {
  const sources = mapJson.sources ?? [];
  const sourceRoot = mapJson.sourceRoot ?? '';
  for (const s of sources) {
    const abs = isAbsolute(s) ? s : join(mapDir, sourceRoot, s);
    if (abs === absTsPath) return s;
  }
  // fallback: match by basename
  const base = basename(absTsPath);
  for (const s of sources) {
    if (basename(s) === base) return s;
  }
  return null;
}
