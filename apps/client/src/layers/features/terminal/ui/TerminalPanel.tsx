import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import type { TerminalHandle } from '@dorkos/shared/transport';
import { useAppStore, useTransport } from '@/layers/shared/model';

/**
 * Embedded terminal panel (spec right-panel-workbench, Chunk E). Renders an
 * `@xterm/xterm` terminal wired to a server-side PTY via the Transport's
 * `openTerminal` byte channel: output streams in, keystrokes and resize stream
 * out. The WebGL renderer is used when available, with a silent DOM fallback.
 * Web-only — the tab is gated on `transport.supportsTerminal`, so this never
 * mounts under the in-process transport.
 *
 * The whole feature module is lazy-loaded by the right-panel contribution
 * (`React.lazy`), so `@xterm/*` lands in its own async chunk.
 *
 * @module features/terminal/ui/TerminalPanel
 */
export function TerminalPanel() {
  const transport = useTransport();
  const cwd = useAppStore((s) => s.selectedCwd);
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
        handle = await transport.openTerminal(cwd, controller.signal);
        if (cancelled) return;
        term.onData((data) => handle && transport.writeTerminal(handle, data));
        // Sync the PTY to the fitted viewport before output starts flowing.
        transport.resizeTerminal(handle, { cols: term.cols, rows: term.rows });
        for await (const chunk of handle.output) {
          term.write(chunk);
        }
      } catch (err) {
        if (!cancelled) {
          term.write(`\r\n\x1b[31mTerminal error: ${errorMessage(err)}\x1b[0m\r\n`);
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
  }, [transport, cwd]);

  if (!cwd) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center p-6 text-sm">
        Select a working directory to open a terminal.
      </div>
    );
  }

  return <div ref={containerRef} className="bg-sidebar h-full w-full overflow-hidden p-2" />;
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
