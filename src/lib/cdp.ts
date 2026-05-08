import CDP from 'chrome-remote-interface';
import type { Protocol } from 'devtools-protocol';

export type CdpTarget = CDP.Target;
export type CdpClient = CDP.Client;

export async function discoverTarget(
  host: string,
  port: number,
  { timeoutMs = 5000 }: { timeoutMs?: number } = {},
): Promise<CdpTarget> {
  const url = `http://${host}:${port}/json/list`;
  const deadline = Date.now() + timeoutMs;
  let lastErr: Error | undefined;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = (await res.json()) as CdpTarget[];
      const node = list.find((t) => t.type === 'node' && t.webSocketDebuggerUrl);
      if (node) return node;
      const any = list.find((t) => t.webSocketDebuggerUrl);
      if (any) return any;
    } catch (err) {
      lastErr = err as Error;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(
    `Could not reach Node Inspector at ${url} after ${timeoutMs}ms (${lastErr?.message ?? 'unknown'})`,
  );
}

export type ScriptParsedHandler = (script: Protocol.Debugger.ScriptParsedEvent) => void;
export type PausedHandler = (evt: Protocol.Debugger.PausedEvent) => void;
export type ResumedHandler = () => void;
export type DetachedHandler = (reason: string) => void;

export interface SetBreakpointParams {
  urlRegex?: string;
  url?: string;
  lineNumber: number;
  columnNumber?: number;
  condition?: string | undefined;
}

export class CdpSession {
  client: CdpClient | null = null;
  scripts = new Map<string, Protocol.Debugger.ScriptParsedEvent>();
  scriptsByUrl = new Map<string, Protocol.Debugger.ScriptParsedEvent[]>();
  target: CdpTarget | null = null;
  onPaused: PausedHandler | null = null;
  onResumed: ResumedHandler | null = null;
  onScriptParsed: ScriptParsedHandler | null = null;
  onDetached: DetachedHandler | null = null;
  private _closing = false;

  async connect(host: string, port: number, { timeoutMs = 5000 }: { timeoutMs?: number } = {}): Promise<CdpTarget> {
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

    await Runtime.runIfWaitingForDebugger().catch(() => undefined);

    return this.target;
  }

  async setBreakpointByUrl(params: SetBreakpointParams): Promise<Protocol.Debugger.SetBreakpointByUrlResponse> {
    if (!this.client) throw new Error('CDP client not connected');
    const cdpParams: Protocol.Debugger.SetBreakpointByUrlRequest = {
      lineNumber: Math.max(0, params.lineNumber - 1),
    };
    if (params.columnNumber != null) cdpParams.columnNumber = params.columnNumber;
    if (params.urlRegex) cdpParams.urlRegex = params.urlRegex;
    else if (params.url) cdpParams.url = params.url;
    if (params.condition) cdpParams.condition = params.condition;
    return this.client.Debugger.setBreakpointByUrl(cdpParams);
  }

  async removeBreakpoint(breakpointId: string): Promise<void> {
    if (!this.client) throw new Error('CDP client not connected');
    await this.client.Debugger.removeBreakpoint({ breakpointId });
  }

  async resume(): Promise<void> {
    if (!this.client) throw new Error('CDP client not connected');
    await this.client.Debugger.resume({});
  }

  async stepOver(): Promise<void> {
    if (!this.client) throw new Error('CDP client not connected');
    await this.client.Debugger.stepOver({});
  }

  async stepInto(): Promise<void> {
    if (!this.client) throw new Error('CDP client not connected');
    await this.client.Debugger.stepInto({});
  }

  async stepOut(): Promise<void> {
    if (!this.client) throw new Error('CDP client not connected');
    await this.client.Debugger.stepOut();
  }

  async evaluateOnCallFrame(
    callFrameId: string,
    expression: string,
    opts: Partial<Protocol.Debugger.EvaluateOnCallFrameRequest> = {},
  ): Promise<Protocol.Debugger.EvaluateOnCallFrameResponse> {
    if (!this.client) throw new Error('CDP client not connected');
    return this.client.Debugger.evaluateOnCallFrame({
      callFrameId,
      expression,
      generatePreview: true,
      returnByValue: false,
      throwOnSideEffect: false,
      ...opts,
    });
  }

  async runtimeEvaluate(
    expression: string,
    opts: Partial<Protocol.Runtime.EvaluateRequest> = {},
  ): Promise<Protocol.Runtime.EvaluateResponse> {
    if (!this.client) throw new Error('CDP client not connected');
    return this.client.Runtime.evaluate({
      expression,
      generatePreview: true,
      returnByValue: false,
      includeCommandLineAPI: false,
      ...opts,
    });
  }

  async getProperties(
    objectId: string,
    {
      ownProperties = true,
      generatePreview = true,
      accessorPropertiesOnly = false,
    }: { ownProperties?: boolean; generatePreview?: boolean; accessorPropertiesOnly?: boolean } = {},
  ): Promise<Protocol.Runtime.GetPropertiesResponse> {
    if (!this.client) throw new Error('CDP client not connected');
    return this.client.Runtime.getProperties({
      objectId,
      ownProperties,
      generatePreview,
      accessorPropertiesOnly,
    });
  }

  async releaseObject(objectId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.Runtime.releaseObject({ objectId });
    } catch {
      /* ignore */
    }
  }

  scriptForUrl(url: string): Protocol.Debugger.ScriptParsedEvent | null {
    const list = this.scriptsByUrl.get(url);
    return list?.[list.length - 1] ?? null;
  }

  scriptsMatching(predicate: (s: Protocol.Debugger.ScriptParsedEvent) => boolean): Protocol.Debugger.ScriptParsedEvent[] {
    return [...this.scripts.values()].filter(predicate);
  }

  async ping(): Promise<boolean> {
    if (!this.client) return false;
    try {
      const r = await this.client.Runtime.evaluate({ expression: '1+1', returnByValue: true });
      return r.result.value === 2;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this._closing = true;
    if (this.client) {
      try { await this.client.close(); } catch { /* ignore */ }
    }
    this.client = null;
  }
}
