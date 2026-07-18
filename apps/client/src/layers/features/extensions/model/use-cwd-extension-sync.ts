/**
 * Watch for CWD changes and re-resolve the working directory's extension set.
 *
 * When the working directory changes and the discovered extension set differs
 * (new extensions added or existing ones removed), a toast is shown and the
 * caller's `onExtensionsChanged` handler runs, which live-remounts the
 * extension slots for the new set — no full-page reload.
 *
 * @module features/extensions/model/use-cwd-extension-sync
 */
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useAppStore } from '@/layers/shared/model';
import { extensionApiUrl } from './extension-api-url';

/** Response shape from POST /api/extensions/cwd-changed. */
interface CwdChangedResponse {
  changed: boolean;
  added: string[];
  removed: string[];
}

/**
 * Notify the server that the CWD changed and return the diff of discovered
 * extensions. The server re-scans and re-scopes its extension set as a side
 * effect, so a subsequent extension-list fetch reflects the new working
 * directory.
 *
 * @param cwd - New working directory (null clears the CWD)
 * @returns The diff response, or null on network/server error
 */
async function notifyCwdChanged(cwd: string | null): Promise<CwdChangedResponse | null> {
  try {
    const res = await fetch(extensionApiUrl('/extensions/cwd-changed'), {
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
 * Hook that subscribes to CWD changes in the app store and notifies the server
 * when the working directory switches. If the server reports that the extension
 * set changed (added or removed extensions), a toast is shown and
 * `onExtensionsChanged` runs to live-remount the extension slots with the new
 * set — everything unrelated (session view, scroll, composer text, router
 * state) is preserved.
 *
 * Placed inside `ExtensionProvider` so it runs once for the app lifetime.
 *
 * @param onExtensionsChanged - Runs after the server confirms the cwd-scoped
 *   extension set changed. The handler re-resolves and remounts the extension
 *   slots. Kept in a ref so the effect stays keyed on the CWD alone.
 */
export function useCwdExtensionSync(onExtensionsChanged: () => void): void {
  const selectedCwd = useAppStore((s) => s.selectedCwd);

  // Track the previous CWD to detect actual changes (not the initial mount).
  const prevCwdRef = useRef<string | null | undefined>(undefined);

  // Keep the latest handler in a ref so a new callback identity never re-runs
  // the CWD effect (which would re-notify the server for an unchanged cwd).
  const onChangedRef = useRef(onExtensionsChanged);
  useEffect(() => {
    onChangedRef.current = onExtensionsChanged;
  }, [onExtensionsChanged]);

  useEffect(() => {
    // Skip the initial mount — we don't want to re-scan on first render.
    if (prevCwdRef.current === undefined) {
      prevCwdRef.current = selectedCwd;
      return;
    }

    // Skip if the CWD hasn't actually changed.
    if (prevCwdRef.current === selectedCwd) {
      return;
    }

    prevCwdRef.current = selectedCwd;

    // Fire-and-forget: notify the server, then live-remount if the set differs.
    void notifyCwdChanged(selectedCwd).then((result) => {
      if (!result || !result.changed) return;

      toast.info('Project extensions updated');
      onChangedRef.current();
    });
  }, [selectedCwd]);
}
