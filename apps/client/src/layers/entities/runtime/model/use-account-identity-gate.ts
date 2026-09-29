import { useClaudeAccounts } from '@/layers/shared/model';
import { useRuntimeCapabilities } from './use-runtime-capabilities';

/**
 * Whether a runtime's sessions tell their accounts apart, which is THE gate for
 * every account-identity surface (spec `claude-account-ui` invariant 1): the
 * status-bar chip, the popover's continue action, the sidebar dot and
 * limited-row text, the header badge, the Settings dots and the Flow note.
 *
 * True only when the runtime declares `supportsAccounts` AND it has two or
 * more registered accounts. With one account every session is on it, so naming
 * it would repeat a fact that never varies. Claude Code counts its registry;
 * no other runtime has one today, so every other runtime counts zero. False
 * while capabilities load, so nothing flashes in and out.
 *
 * A nullish runtime resolves to the server's default runtime, exactly as
 * `useCapabilitiesForRuntime` does, for a session that has not bound yet.
 *
 * `isMultiAccount` on `useClaudeAccounts` stays only for the pre-launch picker
 * and the team roster; everything that shows account identity reads this.
 *
 * @param runtime - The session's runtime, or nothing for the server default.
 */
export function useAccountIdentityGate(runtime: string | null | undefined): boolean {
  const { data } = useRuntimeCapabilities();
  const { accounts } = useClaudeAccounts();
  if (!data) return false;
  const type = runtime ?? data.defaultRuntime;
  if (!Object.hasOwn(data.capabilities, type)) return false;
  if (!data.capabilities[type]!.supportsAccounts) return false;
  const registered = type === 'claude-code' ? accounts.length : 0;
  return registered >= 2;
}
