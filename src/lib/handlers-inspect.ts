import { formatRemoteObject, formatScopeChain } from './format.js';
import type { DaemonContext } from './daemon-context.js';
import type { GetPropertiesFn, IpcResponse } from './types.js';

/**
 * Registers the inspection IPC handlers (`eval`, `locals`, `stack`, `step`,
 * `resume`) on the given {@link DaemonContext}. Eval prefers `evaluateOnCallFrame`
 * when a frame is paused and falls back to `Runtime.evaluate` otherwise.
 */
export function registerInspectHandlers(ctx: DaemonContext): void {
  const session = ctx.session;

  const getProperties: GetPropertiesFn = (objectId, opts) =>
    session.getProperties(objectId, { ownProperties: true, generatePreview: true, ...(opts ?? {}) });

  ctx.handlers.eval = async (req): Promise<IpcResponse> => {
    const expr = req.expr as string | undefined;
    if (!expr) return { ok: false, error: 'eval requires expr' };
    const depth = Number(req.depth ?? 2);
    const frame = ctx.getPausedFrame();
    let evalResult;
    let mode: 'callFrame' | 'runtime';
    if (frame) {
      mode = 'callFrame';
      const callFrames = ctx.getPausedCallFrames() ?? [frame];
      const target = callFrames[Number(req.frame ?? 0)] ?? frame;
      evalResult = await session.evaluateOnCallFrame(target.callFrameId, expr);
    } else {
      mode = 'runtime';
      evalResult = await session.runtimeEvaluate(expr);
    }
    if (evalResult.exceptionDetails) {
      const ed = evalResult.exceptionDetails;
      const tail = ed.exception?.description ? `: ${ed.exception.description.split('\n')[0] ?? ''}` : '';
      return { ok: false, mode, error: ed.text + tail };
    }
    const value = await formatRemoteObject(evalResult.result, getProperties, { depth });
    return {
      ok: true,
      mode,
      expr,
      type: evalResult.result.type,
      subtype: evalResult.result.subtype,
      value,
    };
  };

  ctx.handlers.locals = async (req): Promise<IpcResponse> => {
    const callFrames = ctx.getPausedCallFrames();
    if (!callFrames || callFrames.length === 0) {
      return { ok: false, error: 'No paused frame; locals only available when paused.' };
    }
    const depth = Number(req.depth ?? 2);
    const top = callFrames[0]!;
    const scopes = await formatScopeChain(top, getProperties, { depth });
    return { ok: true, frame: ctx.summarizeFrame(top), scopes };
  };

  ctx.handlers.stack = (): Promise<IpcResponse> => {
    const callFrames = ctx.getPausedCallFrames();
    if (!callFrames || callFrames.length === 0) {
      return Promise.resolve({ ok: false, error: 'No paused frame; stack only available when paused.' });
    }
    return Promise.resolve({ ok: true, stack: callFrames.map((f) => ctx.summarizeFrame(f)) });
  };

  ctx.handlers.step = async (req): Promise<IpcResponse> => {
    if (!ctx.getPausedFrame()) return { ok: false, error: 'Cannot step; not paused.' };
    const direction = (req.direction as string | undefined) ?? 'over';
    ctx.setState('stepping');
    if (direction === 'over') await session.stepOver();
    else if (direction === 'in') await session.stepInto();
    else if (direction === 'out') await session.stepOut();
    else return { ok: false, error: `Unknown step direction: ${direction}` };
    return { ok: true, direction };
  };

  ctx.handlers.resume = async (): Promise<IpcResponse> => {
    if (!ctx.getPausedFrame()) return { ok: false, error: 'Cannot resume; not paused.' };
    await session.resume();
    return { ok: true };
  };
}
