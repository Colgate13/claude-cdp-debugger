/**
 * LLM-friendly formatting of CDP RemoteObject values.
 *
 * Strategy:
 * - Use V8's `preview` when present (it's already truncated by V8)
 * - Recursive expansion via Runtime.getProperties only when depth > 1
 * - Hard caps: depth (default 2), max props per object (50),
 *   string truncate (200 chars), array truncate (10 items),
 *   total payload bytes (8 * 1024)
 * - Detect circular refs via objectId set
 */

const DEFAULT_OPTS = {
  depth: 2,
  maxProps: 50,
  maxArrayItems: 10,
  maxString: 200,
  totalCap: 8 * 1024,
};

export async function formatRemoteObject(remoteObject, getProperties, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const ctx = { bytes: 0, cap: o.totalCap, seen: new Set() };
  const result = await formatNode(remoteObject, getProperties, ctx, o, 0);
  return result;
}

async function formatNode(remote, getProperties, ctx, o, depth) {
  if (remote == null) return null;
  if (ctx.bytes > ctx.cap) return { __truncated: true, reason: 'payload-cap' };
  switch (remote.type) {
    case 'undefined':
      return undefined;
    case 'string':
      return truncateString(remote.value, o.maxString, ctx);
    case 'number':
    case 'boolean':
    case 'bigint':
      return budget(remote.value, ctx);
    case 'symbol':
      return budget(remote.description ?? 'Symbol()', ctx);
    case 'function':
      return budget(`[Function: ${remote.description?.split('\n')[0]?.slice(0, 80) ?? '<fn>'}]`, ctx);
    case 'object':
      return await formatObject(remote, getProperties, ctx, o, depth);
    default:
      return budget(remote.description ?? remote.type, ctx);
  }
}

async function formatObject(remote, getProperties, ctx, o, depth) {
  if (remote.subtype === 'null') return null;
  if (remote.subtype === 'date') return budget({ __date: remote.description }, ctx);
  if (remote.subtype === 'regexp') return budget({ __regexp: remote.description }, ctx);
  if (remote.subtype === 'error') {
    const msg = remote.description?.split('\n')[0] ?? 'Error';
    return budget({ __error: msg }, ctx);
  }
  if (remote.subtype === 'promise') {
    const preview = remote.preview;
    if (preview) {
      const status = preview.properties?.find((p) => p.name === '[[PromiseState]]')?.value ?? 'unknown';
      const value = preview.properties?.find((p) => p.name === '[[PromiseResult]]')?.value;
      return budget({ __promise: { state: status, value } }, ctx);
    }
    return budget({ __promise: 'unknown' }, ctx);
  }

  if (!remote.objectId) {
    return budget(remote.description ?? '[object]', ctx);
  }

  if (ctx.seen.has(remote.objectId)) {
    return { __circular: true };
  }

  if (depth >= o.depth) {
    if (remote.preview) return summarizePreview(remote.preview, o, ctx);
    return budget(remote.description ?? '[object]', ctx);
  }

  ctx.seen.add(remote.objectId);

  let props;
  try {
    const r = await getProperties(remote.objectId);
    props = r.result ?? [];
  } catch (err) {
    ctx.seen.delete(remote.objectId);
    return { __error: `getProperties failed: ${err.message}` };
  }

  // Heuristic: if object is a Mongoose-like document (has `_doc`), prefer `_doc`
  const doc = props.find((p) => p.name === '_doc' && p.value?.type === 'object');
  if (doc?.value && depth + 1 < o.depth) {
    const inner = await formatObject(doc.value, getProperties, ctx, o, depth + 1);
    ctx.seen.delete(remote.objectId);
    return inner;
  }

  if (remote.subtype === 'array') {
    const arr = [];
    let truncatedCount = 0;
    for (const p of props) {
      if (!/^\d+$/.test(p.name)) continue;
      if (arr.length >= o.maxArrayItems) { truncatedCount++; continue; }
      if (ctx.bytes > ctx.cap) { truncatedCount++; continue; }
      arr.push(await formatNode(p.value, getProperties, ctx, o, depth + 1));
    }
    if (truncatedCount > 0) arr.push(`...(+${truncatedCount} more)`);
    ctx.seen.delete(remote.objectId);
    return arr;
  }

  const out = {};
  let count = 0;
  let truncated = 0;
  for (const p of props) {
    if (p.name.startsWith('__') || p.name === 'constructor') continue;
    if (count >= o.maxProps) { truncated++; continue; }
    if (ctx.bytes > ctx.cap) { truncated++; continue; }
    if (p.value === undefined && p.get) {
      out[p.name] = '[Getter]';
      continue;
    }
    if (!p.value) continue;
    out[p.name] = await formatNode(p.value, getProperties, ctx, o, depth + 1);
    count++;
  }
  if (truncated > 0) out['__more'] = `${truncated} more properties`;
  ctx.seen.delete(remote.objectId);
  return out;
}

function summarizePreview(preview, o, ctx) {
  if (preview.subtype === 'array') {
    const items = (preview.properties ?? []).slice(0, o.maxArrayItems).map((p) => p.value ?? p.subtype ?? p.type);
    if (preview.overflow) items.push('...');
    return budget(items, ctx);
  }
  const out = {};
  for (const p of (preview.properties ?? []).slice(0, o.maxProps)) {
    out[p.name] = truncateString(p.value ?? p.description ?? '?', o.maxString, ctx);
  }
  if (preview.overflow) out['__more'] = '...';
  return out;
}

function truncateString(s, max, ctx) {
  if (s == null) return s;
  if (typeof s !== 'string') s = String(s);
  if (s.length > max) {
    const cut = s.slice(0, max);
    return budget(`${cut}...[truncated +${s.length - max} chars]`, ctx);
  }
  return budget(s, ctx);
}

function budget(value, ctx) {
  try {
    ctx.bytes += JSON.stringify(value).length;
  } catch { /* ignore */ }
  return value;
}

export function formatScopeChain(callFrame, getProperties, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  return Promise.all((callFrame.scopeChain ?? [])
    .filter((s) => ['local', 'closure', 'block', 'with', 'catch'].includes(s.type))
    .map(async (scope) => {
      const ctx = { bytes: 0, cap: o.totalCap, seen: new Set() };
      const value = await formatObject(scope.object, getProperties, ctx, o, 0);
      return { type: scope.type, name: scope.name ?? null, value };
    }));
}
