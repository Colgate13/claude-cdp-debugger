import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, dirname, basename, isAbsolute } from 'node:path';
import { SourceMapConsumer } from 'source-map';
import type { RawSourceMap } from 'source-map';

interface ConsumerEntry {
  consumer: SourceMapConsumer;
  mapDir: string;
  json: RawSourceMap;
}

/** Forward translation: TypeScript source position → generated JS position. */
export interface TsToJsResult {
  jsPath: string;
  jsLine: number;
  jsColumn: number;
}

/** Reverse translation: generated JS position → original TS source position. */
export interface JsToTsResult {
  tsPath: string;
  tsLine: number | null;
  tsColumn: number | null;
  name: string | null;
}

/**
 * Resolves source-map translations between a project's TypeScript paths and
 * the JavaScript paths that Node Inspector reports. Caches consumers per
 * `dist/.js` path. Falls through silently when no `.js.map` is found — callers
 * should treat `null` as "no translation available; try fallback".
 */
export class SourceMapResolver {
  readonly projectRoot: string;
  readonly distDirs: string[];
  private _consumers = new Map<string, ConsumerEntry | null>();
  private _tsToJs = new Map<string, TsToJsResult>();

  constructor({ projectRoot, distDirs = ['dist'] }: { projectRoot: string; distDirs?: string[] }) {
    this.projectRoot = projectRoot;
    this.distDirs = distDirs;
  }

  candidateJsPaths(absTsPath: string): string[] {
    const rel = relative(this.projectRoot, absTsPath);
    if (rel.startsWith('..')) return [];
    const noExt = rel.replace(/\.[mc]?ts$/, '');
    const candidates: string[] = [];
    for (const dist of this.distDirs) {
      candidates.push(join(this.projectRoot, dist, noExt + '.js'));
      candidates.push(join(this.projectRoot, dist, basename(noExt) + '.js'));
      candidates.push(join(this.projectRoot, dist, 'src', noExt.replace(/^src\//, '') + '.js'));
    }
    return candidates;
  }

  private async _consumerFor(absJsPath: string): Promise<ConsumerEntry | null> {
    if (this._consumers.has(absJsPath)) return this._consumers.get(absJsPath) ?? null;
    const mapPath = absJsPath + '.map';
    if (!existsSync(mapPath)) {
      this._consumers.set(absJsPath, null);
      return null;
    }
    try {
      const raw = await readFile(mapPath, 'utf8');
      const json = JSON.parse(raw) as RawSourceMap;
      const consumer = await new SourceMapConsumer(json);
      const entry: ConsumerEntry = { consumer, mapDir: dirname(mapPath), json };
      this._consumers.set(absJsPath, entry);
      return entry;
    } catch {
      this._consumers.set(absJsPath, null);
      return null;
    }
  }

  async tsToJs(absTsPath: string, tsLine: number, tsColumn = 0): Promise<TsToJsResult | null> {
    const key = `${absTsPath}:${tsLine}:${tsColumn}`;
    const cached = this._tsToJs.get(key);
    if (cached) return cached;
    const candidates = this.candidateJsPaths(absTsPath);
    for (const jsPath of candidates) {
      if (!existsSync(jsPath)) continue;
      const entry = await this._consumerFor(jsPath);
      if (!entry) continue;
      const { consumer, json } = entry;
      const sourceName = pickSourceName(json, absTsPath, dirname(jsPath));
      if (!sourceName) continue;
      const pos = consumer.generatedPositionFor({
        source: sourceName,
        line: tsLine,
        column: tsColumn,
        bias: SourceMapConsumer.LEAST_UPPER_BOUND,
      });
      if (pos.line == null) continue;
      const result: TsToJsResult = { jsPath, jsLine: pos.line, jsColumn: pos.column ?? 0 };
      this._tsToJs.set(key, result);
      return result;
    }
    return null;
  }

  async jsToTs(absJsPath: string, jsLine: number, jsColumn = 0): Promise<JsToTsResult | null> {
    const entry = await this._consumerFor(absJsPath);
    if (!entry) return null;
    const { consumer, mapDir } = entry;
    const orig = consumer.originalPositionFor({ line: jsLine, column: jsColumn });
    if (!orig.source) return null;
    const tsPath = isAbsolute(orig.source) ? orig.source : join(mapDir, orig.source);
    return { tsPath, tsLine: orig.line ?? null, tsColumn: orig.column ?? null, name: orig.name ?? null };
  }

  destroy(): void {
    for (const entry of this._consumers.values()) {
      try { entry?.consumer.destroy(); } catch { /* ignore */ }
    }
    this._consumers.clear();
  }
}

function pickSourceName(mapJson: RawSourceMap, absTsPath: string, mapDir: string): string | null {
  const sources = mapJson.sources;
  const sourceRoot = mapJson.sourceRoot ?? '';
  for (const s of sources) {
    const abs = isAbsolute(s) ? s : join(mapDir, sourceRoot, s);
    if (abs === absTsPath) return s;
  }
  const base = basename(absTsPath);
  for (const s of sources) {
    if (basename(s) === base) return s;
  }
  return null;
}
