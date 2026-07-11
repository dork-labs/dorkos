/// <reference lib="dom" />
/**
 * The in-page DevTools capture shim (DOR-213) — the injected script that runs
 * first inside a served/proxied preview and reports its console + network to the
 * DorkOS client.
 *
 * ## The load-bearing security choice
 *
 * The preview renders in a sandbox WITHOUT `allow-same-origin` (opaque `"null"`
 * origin, ADR 260708-185519). This shim therefore talks ONLY to `window.parent`
 * via `postMessage` and **never** touches `/api/*`: a direct `fetch('/api/...')`
 * from an opaque origin would be cross-origin (forcing a CORS-`*` ingest hole any
 * page could POST to) and would be subject to the page's own CSP `connect-src`.
 * `postMessage` to the parent is neither — it reaches only our own client app,
 * which is same-origin and authenticated and does the credentialed ingest. The
 * shim's blast radius stays exactly what the sandbox already permits. There is no
 * `/api` reference anywhere in this file's shim source (a test enforces it).
 *
 * ## How it is authored and embedded
 *
 * {@link serializeConsoleArg} and the internal `installDevtoolsShim` are real,
 * self-contained functions (typechecked + linted), embedded into
 * {@link DEVTOOLS_AGENT_SCRIPT} via `Function.prototype.toString()`. `install`
 * receives the serializer as a parameter (a local binding), so nothing depends on
 * cross-scope identifier names surviving bundling/minification. Type assertions
 * erase at emit, so the string is clean browser JS regardless of this file's
 * Node type environment. The target is ES2022 (no downlevel helpers).
 *
 * @module services/workbench-serve/devtools-shim
 */

/**
 * Safely serialize an arbitrary console argument into a structured-clone-safe,
 * depth- and size-capped, circular-safe plain value. Exported both to embed into
 * the shim (via `toString()`) and to unit-test in isolation. Self-contained: it
 * references no module-scope binding, so its stringified source is complete.
 *
 * @param value - The value logged in the page.
 * @param maxDepth - How deep to walk nested objects/arrays before summarizing.
 * @param maxItems - Max array elements / object keys captured per level.
 * @param maxString - Max characters of any single string before truncation.
 */
export function serializeConsoleArg(
  value: unknown,
  maxDepth = 4,
  maxItems = 50,
  maxString = 8_000
): unknown {
  const seen = new Set<unknown>();
  function walk(v: unknown, depth: number): unknown {
    if (v === null) return null;
    const t = typeof v;
    if (t === 'string') {
      const s = v as string;
      return s.length > maxString ? s.slice(0, maxString) + '…[truncated]' : s;
    }
    if (t === 'number' || t === 'boolean') return v;
    if (t === 'undefined') return '[undefined]';
    if (t === 'bigint') return String(v) + 'n';
    if (t === 'symbol') return (v as symbol).toString();
    if (t === 'function') {
      const name = (v as { name?: string }).name;
      return name ? '[Function ' + name + ']' : '[Function]';
    }
    if (v instanceof Error) {
      return { name: v.name, message: v.message, stack: v.stack };
    }
    if (depth >= maxDepth) return Array.isArray(v) ? '[Array]' : '[Object]';
    if (seen.has(v)) return '[Circular]';
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        const out: unknown[] = [];
        for (let i = 0; i < v.length && i < maxItems; i++) out.push(walk(v[i], depth + 1));
        if (v.length > maxItems) out.push('…(' + (v.length - maxItems) + ' more)');
        return out;
      }
      const record = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const keys = Object.keys(record);
      for (let i = 0; i < keys.length && i < maxItems; i++) {
        out[keys[i]] = walk(record[keys[i]], depth + 1);
      }
      return out;
    } finally {
      seen.delete(v);
    }
  }
  return walk(value, 0);
}

/**
 * The shim body. Self-contained except the injected `serialize` parameter and
 * browser globals. Wraps `console.*`, uncaught errors, and `fetch`/XHR, batches
 * captures on a short debounce, and delivers them to `window.parent` — only after
 * a handshake ack, so it is inert anywhere that is not our browser pane. Every
 * hook swallows its own errors: instrumentation must never break the page.
 */
function installDevtoolsShim(serialize: (value: unknown) => unknown): void {
  try {
    const w = window as unknown as { __dorkosDevtoolsInstalled?: boolean };
    if (w.__dorkosDevtoolsInstalled) return;
    const parent = window.parent;
    // Not embedded (top-level, or no distinct parent): do nothing at all.
    if (!parent || parent === window) return;
    w.__dorkosDevtoolsInstalled = true;

    const MAX_BUFFER = 500; // local cap before ack and between flushes
    const CONSOLE_BATCH_MAX = 500;
    const NETWORK_BATCH_MAX = 200;
    const FLUSH_DEBOUNCE_MS = 250;
    const HELLO_RETRY_MS = 400;
    const HELLO_MAX_TRIES = 15;
    const MAX_TEXT = 20_000;
    const MAX_URL = 2_048;

    let acked = false;
    let seq = 0;
    let consoleQ: unknown[] = [];
    let networkQ: unknown[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    function post(msg: unknown): void {
      try {
        parent.postMessage(msg, '*');
      } catch {
        /* parent gone / cross-origin throw — ignore */
      }
    }
    function clamp(s: unknown, max: number): string {
      const str = String(s);
      return str.length > max ? str.slice(0, max) : str;
    }
    function stringify(v: unknown): string {
      try {
        return typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v));
      } catch {
        return String(v);
      }
    }
    function scheduleFlush(): void {
      if (!acked || flushTimer !== null) return;
      flushTimer = setTimeout(flush, FLUSH_DEBOUNCE_MS);
    }
    function flush(): void {
      flushTimer = null;
      if (!acked || (consoleQ.length === 0 && networkQ.length === 0)) return;
      const consoleBatch = consoleQ.slice(0, CONSOLE_BATCH_MAX);
      const networkBatch = networkQ.slice(0, NETWORK_BATCH_MAX);
      consoleQ = consoleQ.slice(CONSOLE_BATCH_MAX);
      networkQ = networkQ.slice(NETWORK_BATCH_MAX);
      seq += 1;
      post({ __dorkosDevtools: 'batch', seq, console: consoleBatch, network: networkBatch });
      if (consoleQ.length > 0 || networkQ.length > 0) scheduleFlush();
    }
    function pushConsole(entry: unknown): void {
      consoleQ.push(entry);
      if (consoleQ.length > MAX_BUFFER) consoleQ = consoleQ.slice(consoleQ.length - MAX_BUFFER);
      scheduleFlush();
    }
    function pushNetwork(entry: unknown): void {
      networkQ.push(entry);
      if (networkQ.length > MAX_BUFFER) networkQ = networkQ.slice(networkQ.length - MAX_BUFFER);
      scheduleFlush();
    }

    // --- Console ---
    const levels = ['log', 'info', 'warn', 'error', 'debug'] as const;
    for (const level of levels) {
      const original = (console as unknown as Record<string, unknown>)[level];
      if (typeof original !== 'function') continue;
      (console as unknown as Record<string, unknown>)[level] = function (
        this: unknown,
        ...args: unknown[]
      ): void {
        try {
          const serializedArgs: unknown[] = [];
          const texts: string[] = [];
          let stack: string | undefined;
          for (const a of args) {
            if (a instanceof Error) {
              texts.push(a.name + ': ' + a.message);
              serializedArgs.push({ name: a.name, message: a.message, stack: a.stack });
              if (!stack && a.stack) stack = clamp(a.stack, MAX_TEXT);
            } else {
              const s = serialize(a);
              serializedArgs.push(s);
              texts.push(typeof a === 'string' ? a : stringify(s));
            }
          }
          pushConsole({
            level,
            text: clamp(texts.join(' '), MAX_TEXT),
            args: serializedArgs,
            stack,
            timestamp: Date.now(),
          });
        } catch {
          /* never break the logging call */
        }
        return (original as (...a: unknown[]) => unknown).apply(console, args) as void;
      };
    }

    // --- Uncaught errors + unhandled rejections (recorded at error level) ---
    window.addEventListener('error', (ev: ErrorEvent) => {
      try {
        const loc = ev.filename ? ev.filename + ':' + ev.lineno + ':' + ev.colno : undefined;
        pushConsole({
          level: 'error',
          text: clamp(ev.message || 'Uncaught error', MAX_TEXT),
          stack: ev.error && ev.error.stack ? clamp(ev.error.stack, MAX_TEXT) : undefined,
          timestamp: Date.now(),
          source: loc ? clamp(loc, MAX_URL) : undefined,
        });
      } catch {
        /* ignore */
      }
    });
    window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
      try {
        const reason = ev.reason;
        const text =
          reason instanceof Error
            ? reason.name + ': ' + reason.message
            : stringify(serialize(reason));
        pushConsole({
          level: 'error',
          text: clamp('Unhandled promise rejection: ' + text, MAX_TEXT),
          stack: reason && reason.stack ? clamp(reason.stack, MAX_TEXT) : undefined,
          timestamp: Date.now(),
        });
      } catch {
        /* ignore */
      }
    });

    // --- Network: fetch ---
    function record(
      method: unknown,
      url: unknown,
      status: number,
      ok: boolean,
      startedAt: number,
      size: number | undefined,
      initiator: 'fetch' | 'xhr'
    ): void {
      try {
        pushNetwork({
          method: clamp(String(method).toUpperCase(), 16),
          url: clamp(url, MAX_URL),
          status,
          ok,
          durationMs: Date.now() - startedAt,
          responseSize: typeof size === 'number' && !isNaN(size) ? size : undefined,
          timestamp: startedAt,
          initiator,
        });
      } catch {
        /* ignore */
      }
    }
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const startedAt = Date.now();
        const method =
          (init && init.method) ||
          (typeof input === 'object' && input && 'method' in input ? input.method : 'GET');
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : (input as Request).url;
        const p = origFetch.call(window, input, init);
        try {
          p.then(
            (res) => {
              const len = res.headers && res.headers.get('content-length');
              record(
                method,
                url,
                res.status,
                res.ok,
                startedAt,
                len ? Number(len) : undefined,
                'fetch'
              );
            },
            () => record(method, url, 0, false, startedAt, undefined, 'fetch')
          );
        } catch {
          /* ignore */
        }
        return p;
      };
    }

    // --- Network: XHR ---
    const Xhr = window.XMLHttpRequest;
    if (Xhr && Xhr.prototype) {
      const origOpen = Xhr.prototype.open;
      const origSend = Xhr.prototype.send;
      Xhr.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]): void {
        try {
          (this as unknown as { __dork?: { method: string; url: string } }).__dork = {
            method: String(args[0]),
            url: String(args[1]),
          };
        } catch {
          /* ignore */
        }
        return (origOpen as (...a: unknown[]) => void).apply(this, args);
      };
      Xhr.prototype.send = function (this: XMLHttpRequest, ...args: unknown[]): void {
        const meta = (this as unknown as { __dork?: { method: string; url: string } }).__dork;
        if (meta) {
          const startedAt = Date.now();
          this.addEventListener('loadend', () => {
            const len = this.getResponseHeader && this.getResponseHeader('content-length');
            record(
              meta.method,
              meta.url,
              this.status,
              // Match fetch's Response.ok (2xx only) so `ok` means the same
              // thing regardless of initiator — a 304 must not classify
              // differently between fetch and XHR.
              this.status >= 200 && this.status < 300,
              startedAt,
              len ? Number(len) : undefined,
              'xhr'
            );
          });
        }
        return (origSend as (...a: unknown[]) => void).apply(this, args);
      };
    }

    // --- Navigation boundary ---
    function navigated(): void {
      post({ __dorkosDevtools: 'navigated' });
    }
    window.addEventListener('pagehide', navigated);
    window.addEventListener('beforeunload', navigated);

    // --- Screenshot: on-demand rasterization (browser_screenshot, DOR-213 P3) ---
    // The parent DELIVERS the rasterizer source (html-to-image UMD) with each
    // capture request; the shim injects it once as a runtime inline <script> —
    // the same CSP class as this shim itself, so any page that ran the shim can
    // load it, with no cross-origin fetch and zero cost until the first capture.
    // Literals (not shared imports — this function is serialized standalone):
    // 1568 = long-edge cap, the model-vision sweet spot; 900000 mirrors
    // DEVTOOLS_SCREENSHOT_MAX_CHARS (the ingest cap, sized to the server's
    // 1 MB JSON body limit).
    const SCREENSHOT_MAX_EDGE = 1568;
    const SCREENSHOT_MAX_CHARS = 900_000;
    type Rasterizer = {
      toPng: (node: HTMLElement, opts: Record<string, unknown>) => Promise<string>;
    };
    function ensureRasterizer(lib: unknown): Rasterizer | null {
      const g = window as unknown as { htmlToImage?: Rasterizer };
      if (!g.htmlToImage && typeof lib === 'string' && lib.length > 0) {
        try {
          const s = document.createElement('script');
          s.textContent = lib;
          (document.head || document.documentElement).appendChild(s);
          s.remove(); // executed synchronously; keep the DOM clean
        } catch {
          /* fall through to the null check */
        }
      }
      return g.htmlToImage && typeof g.htmlToImage.toPng === 'function' ? g.htmlToImage : null;
    }
    function captureScreenshot(requestId: string, lib: unknown): void {
      function fail(error: unknown): void {
        post({
          __dorkosDevtools: 'capture-result',
          requestId,
          error: clamp(error instanceof Error ? error.message : error, 2_000),
        });
      }
      try {
        const hti = ensureRasterizer(lib);
        if (!hti) {
          fail('the rasterizer failed to load — the page CSP may block injected scripts');
          return;
        }
        const el = document.documentElement;
        const w = Math.max(el.scrollWidth, el.clientWidth, 1);
        const h = Math.max(el.scrollHeight, el.clientHeight, 1);
        const render = (scale: number): Promise<string> =>
          hti.toPng(el, {
            canvasWidth: Math.max(1, Math.round(w * scale)),
            canvasHeight: Math.max(1, Math.round(h * scale)),
            pixelRatio: 1,
          });
        const scale = Math.min(1, SCREENSHOT_MAX_EDGE / Math.max(w, h));
        render(scale)
          // One downscale retry when a graphics-heavy page renders over the
          // ingest cap; a second miss is reported honestly instead of looping.
          .then((dataUrl) =>
            dataUrl.length <= SCREENSHOT_MAX_CHARS ? dataUrl : render(scale * 0.6)
          )
          .then((dataUrl) => {
            if (dataUrl.length > SCREENSHOT_MAX_CHARS) {
              fail('the rendered screenshot exceeds the size cap even after downscaling');
            } else {
              post({ __dorkosDevtools: 'capture-result', requestId, dataUrl });
            }
          })
          .catch(fail);
      } catch (err) {
        fail(err);
      }
    }

    // --- Handshake + parent requests: ack starts delivery; capture-request
    // rasterizes on demand. Source identity (ev.source === parent) is the guard.
    window.addEventListener('message', (ev: MessageEvent) => {
      if (ev.source !== parent) return;
      const d = ev.data as { __dorkosDevtools?: string; requestId?: unknown; lib?: unknown } | null;
      if (!d || typeof d.__dorkosDevtools !== 'string') return;
      if (d.__dorkosDevtools === 'ack') {
        if (!acked) {
          acked = true;
          scheduleFlush();
        }
        return;
      }
      if (d.__dorkosDevtools === 'capture-request' && typeof d.requestId === 'string') {
        captureScreenshot(d.requestId, d.lib);
      }
    });
    let tries = 0;
    function hello(): void {
      if (acked) return;
      post({ __dorkosDevtools: 'hello' });
      tries += 1;
      if (tries < HELLO_MAX_TRIES) setTimeout(hello, HELLO_RETRY_MS);
    }
    hello();
  } catch {
    /* an install failure must never surface in the instrumented page */
  }
}

/**
 * The self-contained IIFE source injected as the first `<head>` child of every
 * served/proxied preview. Built by stringifying the two authored functions and
 * passing the serializer into the installer as an argument — see the module doc
 * for why this survives bundling and stays free of `/api` and Node-only syntax.
 */
export const DEVTOOLS_AGENT_SCRIPT = `(${installDevtoolsShim.toString()})(${serializeConsoleArg.toString()});`;
