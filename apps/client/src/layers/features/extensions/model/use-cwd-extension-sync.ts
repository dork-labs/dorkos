/**
 * Watch for CWD changes and notify the server to re-scan local extensions.
 *
 * When the working directory changes and the extension set differs (new
 * extensions added or existing ones removed), a toast is shown and the
 * page reloads after 1.5 seconds so the new extension set takes effect.
 *
 * @module features/extensions/model/use-cwd-extension-sync
 */
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useAppStore } from '@/layers/shared/model';

/** Delay between toast and page reload (ms). */
const RELOAD_DELAY_MS = 1500;

/** Response shape from POST /api/extensions/cwd-changed. */
interface CwdChangedResponse {
  changed: boolean;
  added: string[];
  removed: string[];
}

/**
 * Notify the server that the CWD changed and trigger a page reload if
 * the set of discovered extensions differs.
 *
 * @param cwd - New working directory (null clears the CWD)
 * @returns The diff response, or null on network/server error
 */
async function notifyCwdChanged(cwd: string | null): Promise<CwdChangedResponse | null> {
  try {
    const res = await fetch('/api/extensions/cwd-changed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd }),
    });
    if (!res.ok) {
      console.error('[extensions] CWD change notification failed:', res.status);
      return null;
    }
    return (await res.json()) as CwdChangedResponse;
  } catch (err) {
    console.error('[extensions] CWD change notification error:', err);
    return null;
  }
}

/**
 * Hook that subscribes to CWD changes in the app store and notifies the
 * server when the working directory switches. If the server reports that
 * the extension set changed (added or removed extensions), a toast is
 * shown and the page reloads after {@link RELOAD_DELAY_MS}.
 *
 * Placed inside `ExtensionProvider` so it runs once for the app lifetime.
 */
export function useCwdExtensionSync(): void {
  const selectedCwd = useAppStore((s) => s.selectedCwd);

  // Track the previous CWD to detect actual changes (not the initial mount).
  const prevCwdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    // Skip the initial mount — we don't want to trigger a reload on first render.
    if (prevCwdRef.current === undefined) {
      prevCwdRef.current = selectedCwd;
      return;
    }

    // Skip if the CWD hasn't actually changed.
    if (prevCwdRef.current === selectedCwd) {
      return;
    }

    prevCwdRef.current = selectedCwd;

    // Fire-and-forget: notify server and handle response.
    void notifyCwdChanged(selectedCwd).then((result) => {
      if (!result || !result.changed) return;

      toast.info('Project extensions changed. Reloading...', {
        duration: RELOAD_DELAY_MS,
      });

      setTimeout(() => {
        location.reload();
      }, RELOAD_DELAY_MS);
    });
  }, [selectedCwd]);
}
