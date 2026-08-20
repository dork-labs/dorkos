import { useCallback, useState } from 'react';
import { toast } from 'sonner';

/** How long `copied`/`failed` holds before the control reverts to idle (~1.2s). */
const DEFAULT_TIMEOUT_MS = 1200;

/** Options for {@link useCopyFeedback}. */
export interface UseCopyFeedbackOptions {
  /** Duration in milliseconds `copied`/`failed` holds before reverting. Defaults to ~1.2s. */
  timeoutMs?: number;
  /**
   * Report the result as one neutral toast instead of relying on the caller
   * morphing its own chrome.
   *
   * This is the fallback for a control that has nothing left on screen to
   * morph once it is clicked — a dropdown item that closes its menu, a row
   * inside a list that unmounts with it. Every such call site sets this flag
   * rather than hand-rolling its own `toast.success`/`toast.error`, so "copy"
   * reads as one pattern everywhere it appears in the app (research
   * `20260819_notification-system-review.md` §2.4 item 2).
   */
  toastOnSettle?: boolean;
}

/** What {@link useCopyFeedback} hands back. */
export interface UseCopyFeedbackResult {
  /** `true` for `timeoutMs` after a `copy()` whose clipboard write succeeded. */
  copied: boolean;
  /** `true` for `timeoutMs` after a `copy()` whose clipboard write threw. */
  failed: boolean;
  /**
   * Write `text` to the clipboard and hold the result in `copied`/`failed`.
   *
   * Resolves `true`/`false` too, for the rare caller that needs to react to
   * one specific write rather than the hook's own render state — a menu item
   * that stays deliberately quiet on success and reports only a failure
   * (`use-file-actions.ts`'s `copyPath`) cannot wait for a state update to
   * land back in its own closure.
   */
  copy: (text: string) => Promise<boolean>;
}

/**
 * Copy text to the clipboard with timed inline feedback — the one
 * copy-to-clipboard mechanism in the app. It replaces five hand-rolled
 * variants that used to disagree on whether the write was awaited, whether a
 * failure said anything, and whether success also fired a toast on top of
 * whatever the control already showed (research
 * `20260819_notification-system-review.md` §2.4 item 2).
 *
 * `copied` and `failed` are mutually exclusive and both revert to `false`
 * after `timeoutMs`. A caller with real button chrome morphs it off these —
 * a check mark for success, an inline "Couldn't copy" for failure — because
 * the control the person just clicked is where their eyes already are.
 * `copy()` never rejects; a clipboard write it cannot make is reported
 * through `failed` (and, opted in, one toast) rather than thrown.
 *
 * @param options - Timing and the toast fallback for chrome-less call sites.
 */
export function useCopyFeedback(options: UseCopyFeedbackOptions = {}): UseCopyFeedbackResult {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, toastOnSettle = false } = options;
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  const copy = useCallback(
    async (text: string) => {
      let ok: boolean;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
        setCopied(true);
        setFailed(false);
        if (toastOnSettle) toast.success('Copied');
      } catch {
        ok = false;
        setCopied(false);
        setFailed(true);
        if (toastOnSettle) toast.error("Couldn't copy to the clipboard");
      }
      setTimeout(() => {
        setCopied(false);
        setFailed(false);
      }, timeoutMs);
      return ok;
    },
    [timeoutMs, toastOnSettle]
  );

  return { copied, failed, copy };
}
