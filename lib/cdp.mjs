import CDP from 'chrome-remote-interface';

export async function discoverTarget(host, port, { timeoutMs = 5000 } = {}) {
  const url = `http://${host}:${port}/json/list`;
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = await res.json();
      const node = list.find((t) => t.type === 'node' && t.webSocketDebuggerUrl);
      if (node) return node;
      const any = list.find((t) => t.webSocketDebuggerUrl);
      if (any) return any;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`Could not reach Node Inspector at ${url} after ${timeoutMs}ms (${lastErr?.message ?? 'unknown'})`);
}

export class CdpSession {
  constructor() {
    this.client = null;
    this.scripts = new Map();
    this.scriptsByUrl = new Map();
    this.target = null;
    this.onPaused = null;
    this.onResumed = null;
    this.onScriptParsed = null;
    this.onDetached = null;
    this._closing = false;
  }

  async connect(host, port, { timeoutMs = 5000 } = {}) {
    this.target = await discoverTarget(host, port, { timeoutMs });
    this.client = await CDP({ target: this.target.webSocketDebuggerUrl });
    const { Debugger, Runtime } = this.client;

    await Runtime.enable();
    await Debugger.enable({ maxScriptsCacheSize: 100 * 1024 * 1024 });
    await Debugger.setPauseOnExceptions({ state: 'none' });
    await Debugger.setBreakpointsActive({ active: true });

    Debugger.scriptParsed((script) => {
      this.scripts.set(script.scriptId, script);
      if (script.url) {
        const list = this.scriptsByUrl.get(script.url) ?? [];
        list.push(script);
        this.scriptsByUrl.set(script.url, list);
      }
      this.onScriptParsed?.(script);
    });

    Debugger.paused((evt) => {
      this.onPaused?.(evt);
    });

    Debugger.resumed(() => {
      this.onResumed?.();
    });

    this.client.on('disconnect', () => {
      if (!this._closing) this.onDetached?.('connection-lost');
    });

    if (this.target?.url?.startsWith('file://') === false) {
      await Runtime.runIfWaitingForDebugger().catch(() => {});
    } else {
      await Runtime.runIfWaitingForDebugger().catch(() => {});
    }

    return this.target;
  }

  async setBreakpointByUrl({ urlRegex, url, lineNumber, columnNumber, condition }) {
    const params = { lineNumber: Math.max(0, lineNumber - 1) };
    if (columnNumber != null) params.columnNumber = columnNumber;
    if (urlRegex) params.urlRegex = urlRegex;
    else if (url) params.url = url;
    if (condition) params.condition = condition;
    return this.client.Debugger.setBreakpointByUrl(params);
  }

  async removeBreakpoint(breakpointId) {
    return this.client.Debugger.removeBreakpoint({ breakpointId });
  }

  async resume() {
    return this.client.Debugger.resume();
  }

  async stepOver() {
    return this.client.Debugger.stepOver();
  }

  async stepInto() {
    return this.client.Debugger.stepInto();
  }

  async stepOut() {
    return this.client.Debugger.stepOut();
  }

  async evaluateOnCallFrame(callFrameId, expression, opts = {}) {
    return this.client.Debugger.evaluateOnCallFrame({
      callFrameId,
      expression,
      generatePreview: true,
      returnByValue: false,
      throwOnSideEffect: false,
      ...opts,
    });
  }

  async runtimeEvaluate(expression, opts = {}) {
    return this.client.Runtime.evaluate({
      expression,
      generatePreview: true,
      returnByValue: false,
      includeCommandLineAPI: false,
      ...opts,
    });
  }

  async getProperties(objectId, { ownProperties = true, generatePreview = true, accessorPropertiesOnly = false } = {}) {
    return this.client.Runtime.getProperties({
      objectId,
      ownProperties,
      generatePreview,
      accessorPropertiesOnly,
    });
  }

  async releaseObject(objectId) {
    try {
      await this.client.Runtime.releaseObject({ objectId });
    } catch {
      /* ignore */
    }
  }

  scriptForUrl(url) {
    const list = this.scriptsByUrl.get(url);
    return list?.[list.length - 1] ?? null;
  }

  scriptsMatching(predicate) {
    return [...this.scripts.values()].filter(predicate);
  }

  async ping() {
    try {
      const r = await this.client.Runtime.evaluate({ expression: '1+1', returnByValue: true });
      return r.result?.value === 2;
    } catch {
      return false;
    }
  }

  async close() {
    this._closing = true;
    if (this.client) {
      try { await this.client.close(); } catch { /* ignore */ }
    }
    this.client = null;
  }
}
