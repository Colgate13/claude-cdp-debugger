import type { Protocol } from 'devtools-protocol';
import type { FormatOpts, GetPropertiesFn } from './types.js';

const DEFAULT_OPTS: Required<FormatOpts> = {
  depth: 2,
  maxProps: 50,
  maxArrayItems: 10,
  maxString: 200,
  totalCap: 8 * 1024,
};

interface Ctx {
  bytes: number;
  cap: number;
  seen: Set<string>;
}

export async function formatRemoteObject(
  remoteObject: Protocol.Runtime.RemoteObject,
  getProperties: GetPropertiesFn,
  opts: FormatOpts = {},
): Promise<unknown> {
  const o = { ...DEFAULT_OPTS, ...opts };
  const ctx: Ctx = { bytes: 0, cap: o.totalCap, seen: new Set() };
  return formatNode(remoteObject, getProperties, ctx, o, 0);
}

async function formatNode(
  remote: Protocol.Runtime.RemoteObject | undefined,
  getProperties: GetPropertiesFn,
  ctx: Ctx,
  o: Required<FormatOpts>,
  depth: number,
): Promise<unknown> {
  if (remote == null) return null;
  if (ctx.bytes > ctx.cap) return { __truncated: true, reason: 'payload-cap' };
  switch (remote.type) {
    case 'undefined':
      return undefined;
    case 'string':
      return truncateString(remote.value as string, o.maxString, ctx);
    case 'number':
    case 'boolean':
    case 'bigint':
      return budget(remote.value, ctx);
    case 'symbol':
      return budget(remote.description ?? 'Symbol()', ctx);
    case 'function':
      return budget(`[Function: ${remote.description?.split('\n')[0]?.slice(0, 80) ?? '<fn>'}]`, ctx);
    case 'object':
      return formatObject(remote, getProperties, ctx, o, depth);
    default:
      return budget(remote.description ?? remote.type, ctx);
  }
}

async function formatObject(
  remote: Protocol.Runtime.RemoteObject,
  getProperties: GetPropertiesFn,
  ctx: Ctx,
  o: Required<FormatOpts>,
  depth: number,
): Promise<unknown> {
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
      const status = preview.properties.find((p) => p.name === '[[PromiseState]]')?.value ?? 'unknown';
      const value = preview.properties.find((p) => p.name === '[[PromiseResult]]')?.value;
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

  let props: Protocol.Runtime.PropertyDescriptor[];
  try {
    const r = await getProperties(remote.objectId);
    props = r.result ?? [];
  } catch (err) {
    ctx.seen.delete(remote.objectId);
    return { __error: `getProperties failed: ${(err as Error).message}` };
  }

  // Heuristic: if object is a Mongoose-like document (has `_doc`), prefer `_doc`
  const doc = props.find((p) => p.name === '_doc' && p.value?.type === 'object');
  if (doc?.value && depth + 1 < o.depth) {
    const inner = await formatObject(doc.value, getProperties, ctx, o, depth + 1);
    ctx.seen.delete(remote.objectId);
    return inner;
  }

  if (remote.subtype === 'array') {
    const arr: unknown[] = [];
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

  const out: Record<string, unknown> = {};
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
  if (truncated > 0) out.__more = `${truncated} more properties`;
  ctx.seen.delete(remote.objectId);
  return out;
}

function summarizePreview(
  preview: Protocol.Runtime.ObjectPreview,
  o: Required<FormatOpts>,
  ctx: Ctx,
): unknown {
  if (preview.subtype === 'array') {
    const items = (preview.properties).slice(0, o.maxArrayItems).map((p) => p.value ?? p.subtype ?? p.type);
    if (preview.overflow) items.push('...');
    return budget(items, ctx);
  }
  const out: Record<string, unknown> = {};
  for (const p of preview.properties.slice(0, o.maxProps)) {
    out[p.name] = truncateString(p.value ?? '?', o.maxString, ctx);
  }
  if (preview.overflow) out.__more = '...';
  return out;
}

function truncateString(s: unknown, max: number, ctx: Ctx): unknown {
  if (s == null) return s;
  let str: string;
  if (typeof s === 'string') str = s;
  else if (typeof s === 'number' || typeof s === 'boolean' || typeof s === 'bigint') str = String(s);
  else str = JSON.stringify(s);
  if (str.length > max) {
    const cut = str.slice(0, max);
    return budget(`${cut}...[truncated +${str.length - max} chars]`, ctx);
  }
  return budget(str, ctx);
}

function budget<T>(value: T, ctx: Ctx): T {
  try {
    ctx.bytes += JSON.stringify(value).length;
  } catch { /* ignore */ }
  return value;
}

export interface ScopeChainEntry {
  type: string;
  name: string | null;
  value: unknown;
}

export function formatScopeChain(
  callFrame: Protocol.Debugger.CallFrame,
  getProperties: GetPropertiesFn,
  opts: FormatOpts = {},
): Promise<ScopeChainEntry[]> {
  const o = { ...DEFAULT_OPTS, ...opts };
  return Promise.all((callFrame.scopeChain)
    .filter((s) => ['local', 'closure', 'block', 'with', 'catch'].includes(s.type))
    .map(async (scope) => {
      const ctx: Ctx = { bytes: 0, cap: o.totalCap, seen: new Set() };
      const value = await formatObject(scope.object, getProperties, ctx, o, 0);
      return { type: scope.type, name: scope.name ?? null, value };
    }));
}
