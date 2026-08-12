/**
 * One store whose sessions could not be listed, said quietly.
 *
 * Shared by the two rosters — the Agent Hub's `SessionsView` and the Obsidian
 * embed's `EmbedSessionList` — because a degraded runtime is a fact about the
 * aggregation (ADR-0310), not about the surface reading it.
 *
 * @module features/session-list/ui/SessionListWarningNotice
 */
import { CircleAlert } from 'lucide-react';
import type { SessionListWarning } from '@dorkos/shared/types';
import { useClaudeAccounts } from '@/layers/shared/model';
import { getRuntimeDescriptor } from '@/layers/entities/runtime';

/**
 * Identity of one warning: the runtime, plus the account when the failure
 * belongs to a single Claude account rather than the whole runtime.
 *
 * Claude Code reads one store per account and pushes one warning per unreadable
 * account, all tagged `runtime: 'claude-code'` — so the runtime alone is NOT an
 * identity. Keyed by it, two unreadable accounts produced duplicate React keys
 * and duplicate test ids (spec `claude-code-accounts`).
 *
 * @param warning - The degradation the server reported.
 */
export function warningKey(warning: SessionListWarning): string {
  return warning.account ? `${warning.runtime}-${warning.account}` : warning.runtime;
}

/**
 * Quiet inline notice for one store whose sessions could not be listed.
 *
 * Names whatever failed: the account when one Claude account is unreadable and
 * the others still list, the runtime when the whole backend is down. Two notices
 * therefore read as two different problems. The server's failure reason rides the
 * tooltip so the line stays a single calm sentence ("OpenCode server is
 * starting…" class detail on hover).
 *
 * @param props - The warning to render.
 */
export function SessionListWarningNotice({ warning }: { warning: SessionListWarning }) {
  const { nameFor } = useClaudeAccounts();
  const runtimeLabel = getRuntimeDescriptor(warning.runtime).label;
  const subject = warning.account
    ? `${runtimeLabel} sessions from ${nameFor(warning.account)}`
    : `${runtimeLabel} sessions`;
  return (
    <p
      className="text-muted-foreground/60 flex items-start gap-1.5 text-xs"
      title={warning.message}
      data-testid={`session-list-warning-${warningKey(warning)}`}
    >
      <CircleAlert className="mt-px size-3 shrink-0" aria-hidden />
      <span>Couldn&apos;t load {subject}</span>
    </p>
  );
}
