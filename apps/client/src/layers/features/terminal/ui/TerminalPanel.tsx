import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import type { Transport, TerminalHandle } from '@dorkos/shared/transport';
import { useAppStore, useTransport } from '@/layers/shared/model';
import { readTerminalId, writeTerminalId, clearTerminalId } from '../lib/terminal-id-store';

/**
 * Embedded terminal panel (spec right-panel-workbench, Chunk E). Renders an
 * `@xterm/xterm` terminal wired to a server-side PTY via the Transport byte
 * channel: output streams in, keystrokes and resize stream out. The WebGL
 * renderer is used when available, with a silent DOM fallback. Web-only — the tab
 * is gated on `transport.supportsTerminal`, so this never mounts under the
 * in-process transport.
 *
 * On mount it re-attaches to the PTY it created before a page refresh, keyed by
 * (session, cwd) in `sessionStorage` (DOR-225): the server replays the output it
 * buffered while detached, so the shell survives a reload instead of being
 * orphaned. If the stored PTY is gone it falls back to a fresh create, seamlessly.
 *
 * The whole feature module is lazy-loaded by the right-panel contribution
 * (`React.lazy`), so `@xterm/*` lands in its own async chunk.
 *
 * @module features/terminal/ui/TerminalPanel
 */
export function TerminalPanel() {
  const transport = useTransport();
  const cwd = useAppStore((s) => s.selectedCwd);
  const sessionId = useAppStore((s) => s.sessionId);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !cwd) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      theme: readTerminalTheme(container),
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    loadWebglRenderer(term);
    fit.fit();

    const controller = new AbortController();
    let cancelled = false;
    let handle: TerminalHandle | null = null;

    void (async () => {
      try {
        const { handle: attached, reattached } = await openOrReattach(
          transport,
          sessionId,
          cwd,
          controller.signal
        );
        if (cancelled) return;
        handle = attached;
        // Remember the id so a refresh re-attaches to this same PTY next mount.
        writeTerminalId(sessionId, cwd, handle.id);
        term.onData((data) => handle && transport.writeTerminal(handle, data));
        // Sync the PTY to the fitted viewport before output starts flowing.
        transport.resizeTerminal(handle, { cols: term.cols, rows: term.rows });
        // A subtle restoration cue, printed BEFORE the server's replayed
        // scrollback so the user knows state was recovered, not lost.
        if (reattached) term.write('\x1b[2m[reconnected]\x1b[0m\r\n');
        for await (const chunk of handle.output) {
          term.write(chunk);
        }
        // The stream ended without a client-initiated teardown (`cancelled` is
        // still false), so the server closed it: the shell exited or the PTY was
        // idle-reclaimed. Either way the stored id is stale — forget it so the
        // next mount spawns a fresh shell instead of a doomed re-attach.
        if (!cancelled) clearTerminalId(sessionId, cwd);
      } catch (err) {
        if (!cancelled) {
          // The live-terminal cap (429, TERMINAL_LIMIT) is an expected
          // operational state, not a fault — show human copy instead of the
          // raw server error. Everything else keeps the raw message.
          const message = isTerminalLimitError(err)
            ? 'Too many terminals open — close some or wait a few minutes.'
            : `Terminal error: ${errorMessage(err)}`;
          term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`);
        }
      }
    })();

    // Reflow the PTY whenever the panel resizes.
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // xterm throws if measured before layout — ignore; the next tick retries.
      }
      if (handle) transport.resizeTerminal(handle, { cols: term.cols, rows: term.rows });
    });
    observer.observe(container);

    return () => {
      cancelled = true;
      controller.abort();
      observer.disconnect();
      term.dispose();
    };
  }, [transport, cwd, sessionId]);

  if (!cwd) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center p-6 text-sm">
        Select a working directory to open a terminal.
      </div>
    );
  }

  return <div ref={containerRef} className="bg-sidebar h-full w-full overflow-hidden p-2" />;
}

/**
 * Attach to the PTY stored for this (session, cwd) if one exists, else create a
 * fresh one (DOR-225). A stored id whose PTY is gone (expired/killed/unknown)
 * rejects; unless the mount was already aborted, we fall back to a create so the
 * recovery is seamless with no user-visible error.
 *
 * @returns The live handle and whether it came from a re-attach (drives the
 *   `[reconnected]` cue).
 */
async function openOrReattach(
  transport: Transport,
  sessionId: string | null,
  cwd: string,
  signal: AbortSignal
): Promise<{ handle: TerminalHandle; reattached: boolean }> {
  const storedId = readTerminalId(sessionId, cwd);
  if (storedId) {
    try {
      return { handle: await transport.attachTerminal(storedId, signal), reattached: true };
    } catch (err) {
      // Don't spawn a fresh PTY into an already-torn-down mount.
      if (signal.aborted) throw err;
      // Otherwise the stored PTY is gone — fall through to a fresh create.
    }
  }
  return { handle: await transport.openTerminal(cwd, signal), reattached: false };
}

/** Best-effort WebGL renderer; falls back silently to the DOM renderer. */
function loadWebglRenderer(term: Terminal): void {
  try {
    const webgl = new WebglAddon();
    // If the GL context is lost, drop the addon so xterm reverts to the DOM renderer.
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    // No WebGL (headless, blocked, or unsupported) — the DOM renderer is used.
  }
}

/**
 * Derive xterm's background/foreground from the panel's computed Tailwind
 * tokens, so the terminal matches the active (light/dark) theme. `rgb(...)`
 * strings from `getComputedStyle` are valid xterm theme colors.
 */
function readTerminalTheme(container: HTMLElement): { background: string; foreground: string } {
  const styles = getComputedStyle(container);
  return {
    background: styles.backgroundColor || '#1e1e1e',
    foreground: styles.color || '#d4d4d4',
  };
}

/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Whether a create failure is the server's live-terminal cap (HTTP 429,
 * `code: 'TERMINAL_LIMIT'`) — the transport carries the machine-readable code
 * on the thrown error so the panel can show friendlier copy.
 */
function isTerminalLimitError(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === 'TERMINAL_LIMIT';
}
