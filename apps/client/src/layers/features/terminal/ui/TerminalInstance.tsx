import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import type { Transport, TerminalHandle } from '@dorkos/shared/transport';
import { TERMINAL_CLOSE_SUPERSEDED } from '@dorkos/shared/terminal-schemas';
import { cn } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';

interface TerminalInstanceProps {
  /** Working directory the shell is spawned in. */
  cwd: string;
  /**
   * The PTY id to re-attach to on mount (a refresh-restore tab), or `null` to
   * spawn a fresh shell (a newly-created tab). Read once at mount — the parent
   * never changes it for a live instance (the stable React key keeps the same
   * instance across the create that resolves the id).
   */
  initialPtyId: string | null;
  /** Whether this instance is the visible (active) tab. Hidden tabs stay mounted. */
  active: boolean;
  /** Called with the server id once a fresh shell is spawned (create path only). */
  onCreated: (id: string) => void;
  /**
   * Called when the shell ends without a client-initiated close — it exited, or
   * a re-attach target was already gone (dead id). The parent removes the tab.
   */
  onEnded: () => void;
  /**
   * Called when the server closed this socket with `TERMINAL_CLOSE_SUPERSEDED` —
   * another window took the PTY over. The tab is kept (dead, with the in-terminal
   * notice), but the parent must record the takeover: the PTY is no longer this
   * window's to destroy, so a later close of this tab must skip `closeTerminal`
   * (destroying it would kill the live terminal in the other window).
   */
  onSuperseded: () => void;
  /**
   * Called when the attach resolves AFTER this instance was already torn down
   * (tab closed or panel unmounted mid-spawn). The abort signal only cancels
   * the create POST before the server spawns; once it resolves, this instance
   * holds the only reference to a live PTY it will never wire up. The parent
   * decides the PTY's fate: destroy it (the tab was explicitly closed) or
   * persist its id (an unmount — the shell must survive for re-attach).
   *
   * @param id - The resolved PTY id.
   * @param reattached - Whether the id came from a re-attach (already persisted).
   */
  onLateSpawn: (id: string, reattached: boolean) => void;
}

/**
 * A single embedded terminal: one `@xterm/xterm` instance bound to one
 * server-side PTY over the Transport byte channel (spec right-panel-workbench,
 * Chunk E; DOR-226). Output streams in, keystrokes and resize stream out. The
 * WebGL renderer is used when available, with a silent DOM fallback.
 *
 * Many instances are mounted at once (one per tab) and kept alive when
 * inactive — hidden with `display:none` rather than unmounted — so switching
 * tabs preserves scrollback instantly and never tears a PTY down. Because a
 * hidden instance has zero measured size, the viewport is re-fit (and the PTY
 * resized) whenever it becomes {@link TerminalInstanceProps.active}.
 *
 * On mount it either re-attaches to {@link TerminalInstanceProps.initialPtyId}
 * (a refresh-restore tab — the server replays buffered output, printing a
 * `[reconnected]` cue) or spawns a fresh shell. A dead re-attach target ends the
 * instance (the parent prunes the tab); it does not silently resurrect a shell.
 *
 * @module features/terminal/ui/TerminalInstance
 */
export function TerminalInstance({
  cwd,
  initialPtyId,
  active,
  onCreated,
  onEnded,
  onSuperseded,
  onLateSpawn,
}: TerminalInstanceProps) {
  const transport = useTransport();
  const containerRef = useRef<HTMLDivElement>(null);

  // Latest callbacks behind refs so the attach-once mount effect can call the
  // current handlers without re-running (it must run exactly once per instance
  // — re-running would spawn or re-attach a second PTY). Synced in an effect
  // (react-hooks/refs forbids ref writes during render), mirroring the
  // command-bridge pattern in FileExplorer.
  const onCreatedRef = useRef(onCreated);
  const onEndedRef = useRef(onEnded);
  const onSupersededRef = useRef(onSuperseded);
  const onLateSpawnRef = useRef(onLateSpawn);
  useEffect(() => {
    onCreatedRef.current = onCreated;
    onEndedRef.current = onEnded;
    onSupersededRef.current = onSuperseded;
    onLateSpawnRef.current = onLateSpawn;
  });

  // The xterm + fit addon + live handle, shared between the mount effect and the
  // activation effect (which re-fits on reveal).
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const handleRef = useRef<TerminalHandle | null>(null);

  // Attach inputs captured once at mount. The attach effect must run exactly
  // once per instance — re-running would spawn or re-attach a second PTY — and
  // its inputs are fixed by design: cwd changes remount the whole panel body
  // (keyed), initialPtyId is only meaningful at attach time (the parent updates
  // it after onCreated, which must NOT re-trigger), and transport is
  // context-stable for the app's lifetime.
  const mountInputsRef = useRef({ transport, cwd, initialPtyId });

  useEffect(() => {
    const { transport, cwd, initialPtyId } = mountInputsRef.current;
    const container = containerRef.current;
    if (!container) return;

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
    safeFit(fit);
    termRef.current = term;
    fitRef.current = fit;

    const controller = new AbortController();
    let cancelled = false;

    void (async () => {
      try {
        const { handle, reattached } = await openOrReattach(
          transport,
          cwd,
          initialPtyId,
          controller.signal
        );
        if (cancelled) {
          // Resolved after teardown: this closure holds the only reference to a
          // live PTY (the abort signal only cancels the create POST BEFORE the
          // server spawns). A bare return here would leak it until the server's
          // idle TTL — hand it to the parent instead, which destroys it (tab
          // was explicitly closed) or persists its id (unmount — the shell must
          // survive for re-attach). Never wire input/resize/output to a
          // disposed xterm.
          onLateSpawnRef.current(handle.id, reattached);
          return;
        }
        handleRef.current = handle;
        // A freshly-spawned shell reports its id up so the parent can persist it.
        if (!reattached) onCreatedRef.current(handle.id);
        term.onData((data) => transport.writeTerminal(handle, data));
        // Sync the PTY to the fitted viewport before output starts flowing.
        transport.resizeTerminal(handle, { cols: term.cols, rows: term.rows });
        // A subtle restoration cue, printed BEFORE the server's replayed
        // scrollback so the user knows state was recovered, not lost.
        if (reattached) term.write('\x1b[2m[reconnected]\x1b[0m\r\n');
        for await (const chunk of handle.output) {
          term.write(chunk);
        }
        // Client-initiated teardown (unmount/abort) — the parent already owns
        // this instance's fate; nothing to report.
        if (cancelled) return;
        // A takeover: the server replaced this sink with a newer attachment
        // (e.g. this session was duplicated into another window). Keep the tab —
        // dead but labeled — and DON'T prune or touch the stored ids, so the
        // window that took over isn't disrupted. Re-attaching here would just
        // steal the sink back and start a takeover war between the two windows.
        // The parent records the takeover so closing this tab later skips the
        // PTY destroy — the shell belongs to the other window now.
        if (handle.closeInfo?.code === TERMINAL_CLOSE_SUPERSEDED) {
          term.write('\r\n\x1b[2m[opened in another window — session moved]\x1b[0m\r\n');
          onSupersededRef.current();
          return;
        }
        // Otherwise the server closed it because the shell exited or the PTY was
        // idle-reclaimed. Tell the parent so it prunes this tab and clears its id.
        onEndedRef.current();
      } catch (err) {
        // If the abort raced the create AFTER the server spawned but before the
        // response was read, the PTY's id is unknowable client-side — that
        // narrow window is left to the server's idle TTL (bounded, unavoidable
        // without idempotency keys on create).
        if (cancelled) return;
        if (isTerminalLimitError(err)) {
          // The live-terminal cap (429, TERMINAL_LIMIT) is an expected
          // operational state, not a fault — show human copy in-panel and keep
          // the (empty) tab so the message stays visible; the user closes it.
          term.write(
            '\r\n\x1b[31mToo many terminals open — close some or wait a few minutes.\x1b[0m\r\n'
          );
        } else if (initialPtyId !== null) {
          // A re-attach target that is gone (dead id) — prune the tab silently
          // rather than surfacing a socket error for an expected reload gap.
          onEndedRef.current();
        } else {
          term.write(`\r\n\x1b[31mTerminal error: ${errorMessage(err)}\x1b[0m\r\n`);
        }
      }
    })();

    // Reflow the PTY whenever the (visible) panel resizes. A tab being hidden
    // (`display:none` on switch) also fires the observer — with a 0×0 rect —
    // and FitAddon would then compute a bogus tiny grid from cached cell sizes
    // and push it to the backgrounded PTY, reflowing a running TUI (vim/htop).
    // Zero-size means hidden, never a real resize: skip it; the activation
    // effect re-fits on reveal.
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width === 0 || rect.height === 0) return;
      safeFit(fit);
      if (handleRef.current) {
        transport.resizeTerminal(handleRef.current, { cols: term.cols, rows: term.rows });
      }
    });
    observer.observe(container);

    return () => {
      cancelled = true;
      controller.abort();
      observer.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      handleRef.current = null;
    };
  }, []);

  // On reveal, re-fit (a hidden instance measured zero) and resize the PTY, then
  // focus so keystrokes land in the just-activated terminal.
  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    safeFit(fit);
    if (handleRef.current) {
      transport.resizeTerminal(handleRef.current, { cols: term.cols, rows: term.rows });
    }
    term.focus();
  }, [active, transport]);

  return (
    <div className={cn('h-full w-full', !active && 'hidden')}>
      <div ref={containerRef} className="bg-sidebar h-full w-full overflow-hidden p-2" />
    </div>
  );
}

/**
 * Re-attach to `initialPtyId` if given (refresh-restore), else spawn a fresh PTY.
 * Unlike the single-terminal path, a dead re-attach id is NOT transparently
 * replaced with a new shell — it rejects, and the caller prunes the tab (DOR-226
 * "dead ids silently pruned").
 *
 * @returns The live handle and whether it came from a re-attach (drives the
 *   `[reconnected]` cue).
 */
async function openOrReattach(
  transport: Transport,
  cwd: string,
  initialPtyId: string | null,
  signal: AbortSignal
): Promise<{ handle: TerminalHandle; reattached: boolean }> {
  if (initialPtyId !== null) {
    return { handle: await transport.attachTerminal(initialPtyId, signal), reattached: true };
  }
  return { handle: await transport.openTerminal(cwd, signal), reattached: false };
}

/** Fit the viewport, tolerating xterm throwing when measured before layout. */
function safeFit(fit: FitAddon): void {
  try {
    fit.fit();
  } catch {
    // xterm throws if measured before layout (or while hidden) — ignore; the
    // next resize/activation retries.
  }
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
