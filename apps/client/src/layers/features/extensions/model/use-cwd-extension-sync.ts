/**
 * Watch for CWD changes and re-resolve the working directory's extension set.
 *
 * When the working directory changes and the server reconciliation succeeds, the caller's
 * `onExtensionsChanged` handler live-remounts the extension slots for the new
 * set and a toast confirms the swap — no full-page reload.
 *
 * @module features/extensions/model/use-cwd-extension-sync
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import {
  getExtensionLoadAdmission,
  subscribeExtensionLoadAdmission,
  type ExtensionLoadAdmission,
} from '@/layers/shared/lib';
import { useAppStore } from '@/layers/shared/model';
import type { ExtensionLoadOutcome } from './extension-loader';
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
async function notifyCwdChanged(
  cwd: string | null,
  current: () => boolean
): Promise<CwdChangedResponse | null> {
  try {
    const url = extensionApiUrl('/extensions/cwd-changed');
    const request: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd }),
    };
    const method = globalThis.fetch;
    if (!current()) return null;
    const res = await Reflect.apply(method, globalThis, [url, request]);
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
 * when the working directory switches. After every successful server reconcile,
 * including an unchanged ID set, `onExtensionsChanged` runs to
 * live-remount the extension slots with the new set, then a toast confirms the
 * swap — everything unrelated (session view, scroll, composer text, router
 * state) is preserved.
 *
 * Placed inside `ExtensionProvider` so it runs once for the app lifetime.
 *
 * @param onExtensionsChanged - Runs after the server confirms the cwd-scoped
 *   reconciliation completed. The handler re-resolves and remounts the extension
 *   slots; the success toast waits for it to resolve, and a rejection surfaces
 *   as an error toast only for a genuine current failed outcome. Handlers stay
 *   in refs; CWD and admission identity control notification initiation.
 */
export function useCwdExtensionSync(
  onExtensionsChanged: () => Promise<ExtensionLoadOutcome | undefined>,
  isOutcomeCurrent: (outcome: ExtensionLoadOutcome) => boolean
): void {
  const selectedCwd = useAppStore((s) => s.selectedCwd);
  const admission = useSyncExternalStore(
    subscribeExtensionLoadAdmission,
    getExtensionLoadAdmission,
    getExtensionLoadAdmission
  );
  const pendingCwdRef = useRef(false);

  // Track the previous CWD to detect actual changes (not the initial mount).
  const prevCwdRef = useRef<string | null | undefined>(undefined);

  // Keep the latest handler in a ref so a new callback identity never re-runs
  // the CWD effect (which would re-notify the server for an unchanged cwd).
  const onChangedRef = useRef(onExtensionsChanged);
  const outcomeCurrentRef = useRef(isOutcomeCurrent);
  useEffect(() => {
    onChangedRef.current = onExtensionsChanged;
    outcomeCurrentRef.current = isOutcomeCurrent;
  }, [onExtensionsChanged, isOutcomeCurrent]);

  useEffect(() => {
    // Skip the initial mount — we don't want to re-scan on first render.
    if (prevCwdRef.current === undefined) {
      prevCwdRef.current = selectedCwd;
      return;
    }

    if (prevCwdRef.current !== selectedCwd) {
      prevCwdRef.current = selectedCwd;
      pendingCwdRef.current = true;
    }
    if (!pendingCwdRef.current) return;

    return startCwdSync({
      cwd: selectedCwd,
      admission,
      pending: pendingCwdRef,
      onChanged: onChangedRef,
      outcomeCurrent: outcomeCurrentRef,
    });
  }, [selectedCwd, admission]);
}

interface CwdSyncContext {
  cwd: string | null;
  admission: ExtensionLoadAdmission;
  pending: { current: boolean };
  onChanged: { current: () => Promise<ExtensionLoadOutcome | undefined> };
  outcomeCurrent: { current: (outcome: ExtensionLoadOutcome) => boolean };
}
function startCwdSync(context: CwdSyncContext): (() => void) | undefined {
  const { admission } = context;
  // Retain a suspended change; only its exact resumed admission may initiate it.
  if (admission.suspended || admission.retirementFailed) return;
  let current = true;
  const admitted = () =>
    current &&
    getExtensionLoadAdmission() === admission &&
    !admission.suspended &&
    !admission.retirementFailed;
  void notifyCwdChanged(context.cwd, admitted).then(async (result) => {
    if (!admitted() || !result) return;
    context.pending.current = false;
    await applyCwdResult(context, result, admitted);
  });
  return () => {
    current = false;
  };
}
async function applyCwdResult(
  context: CwdSyncContext,
  result: CwdChangedResponse,
  admitted: () => boolean
): Promise<void> {
  try {
    const callback = context.onChanged.current;
    if (!admitted()) return;
    const outcome = await callback();
    const check = context.outcomeCurrent.current;
    if (!outcome || !check(outcome) || !admitted()) return;
    publishCwdOutcome(outcome, check, admitted, result);
  } catch (err) {
    console.error('[extensions] Failed to apply the new extension set:', err);
    // An unbound rejection cannot authorize a toast for the current load.
  }
}

function publishCwdOutcome(
  outcome: ExtensionLoadOutcome,
  check: (outcome: ExtensionLoadOutcome) => boolean,
  admitted: () => boolean,
  result: CwdChangedResponse
): void {
  if (outcome.status === 'failed' || outcome.status === 'partial') {
    const show = toast.error;
    if (!check(outcome) || !admitted()) return;
    Reflect.apply(show, toast, ['Couldn’t load this project’s extensions']);
    return;
  }
  if (outcome.status !== 'completed' || !check(outcome) || !admitted()) return;
  if (result.changed) {
    const show = toast.info;
    if (!check(outcome) || !admitted()) return;
    Reflect.apply(show, toast, ['Project extensions updated']);
  }
}
