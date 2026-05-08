import { formatRemoteObject, formatScopeChain } from './format.mjs';

const D = globalThis.__debugDaemon;
if (!D) throw new Error('handlers-inspect.mjs loaded outside daemon context');

const session = D.session;

async function getProperties(objectId) {
  return session.getProperties(objectId, { ownProperties: true, generatePreview: true });
}

D.handlers.eval = async (req) => {
  if (!req.expr) return { ok: false, error: 'eval requires expr' };
  const depth = Number(req.depth ?? 2);
  const frame = D.getPausedFrame();
  let evalResult;
  let mode;
  if (frame) {
    mode = 'callFrame';
    const callFrames = D.getPausedCallFrames() || [frame];
    const target = callFrames[Number(req.frame ?? 0)] ?? frame;
    evalResult = await session.evaluateOnCallFrame(target.callFrameId, req.expr);
  } else {
    mode = 'runtime';
    evalResult = await session.runtimeEvaluate(req.expr);
  }
  if (evalResult.exceptionDetails) {
    return {
      ok: false,
      mode,
      error: evalResult.exceptionDetails.text + (evalResult.exceptionDetails.exception?.description ? `: ${evalResult.exceptionDetails.exception.description.split('\n')[0]}` : ''),
    };
  }
  const value = await formatRemoteObject(evalResult.result, getProperties, { depth });
  return { ok: true, mode, expr: req.expr, type: evalResult.result?.type, subtype: evalResult.result?.subtype, value };
};

D.handlers.locals = async (req) => {
  const callFrames = D.getPausedCallFrames();
  if (!callFrames || callFrames.length === 0) return { ok: false, error: 'No paused frame; locals only available when paused.' };
  const depth = Number(req.depth ?? 2);
  const top = callFrames[0];
  const scopes = await formatScopeChain(top, getProperties, { depth });
  return { ok: true, frame: D.summarizeFrame(top), scopes };
};

D.handlers.stack = async () => {
  const callFrames = D.getPausedCallFrames();
  if (!callFrames || callFrames.length === 0) return { ok: false, error: 'No paused frame; stack only available when paused.' };
  return { ok: true, stack: callFrames.map(D.summarizeFrame) };
};

D.handlers.step = async (req) => {
  if (!D.getPausedFrame()) return { ok: false, error: 'Cannot step; not paused.' };
  const direction = req.direction || 'over';
  D.setState('stepping');
  if (direction === 'over') await session.stepOver();
  else if (direction === 'in') await session.stepInto();
  else if (direction === 'out') await session.stepOut();
  else return { ok: false, error: `Unknown step direction: ${direction}` };
  return { ok: true, direction };
};

D.handlers.resume = async () => {
  if (!D.getPausedFrame()) return { ok: false, error: 'Cannot resume; not paused.' };
  await session.resume();
  return { ok: true };
};
