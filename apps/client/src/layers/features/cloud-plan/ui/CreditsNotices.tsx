import type { CloudCreditsNotice } from '@dorkos/shared/cloud-schemas';
import { Button, Notice } from '@/layers/shared/ui';
import {
  useCloudCredits,
  useDismissCreditsNotice,
  useSetCreditsDefault,
  useSettingsDeepLink,
  useUndoFilledCredits,
} from '@/layers/shared/model';
import { getRuntimeDescriptor } from '@/layers/entities/runtime';

/** A runtime's name as the app shows it everywhere ("Claude Code"). */
function runtimeLabel(type: string): string {
  return getRuntimeDescriptor(type).label;
}

/** "Claude Code", "Claude Code and Codex", "Claude Code, Codex and OpenCode". */
function listOf(runtimes: readonly string[]): string {
  const names = runtimes.map(runtimeLabel);
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The notices DorkOS owes a person about credits (ADR 261001-000811), each
 * shown until they act on it, each worded calmly: what happened, why, and what
 * they can do.
 *
 * - `filled` — a new link set runtimes with no working sign-in to credits.
 *   Change opens Runs on; Undo all puts every one back.
 * - `offer` — this computer was linked before credits were a choice, so
 *   nothing was switched. Offered once.
 * - `signed-in` — a runtime DorkOS set to credits now has a working sign-in of
 *   its own. Switching back is offered once.
 */
export function CreditsNotices() {
  const { data } = useCloudCredits();
  const notices = data?.notices ?? [];
  if (notices.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="credits-notices">
      {notices.map((notice) => (
        <CreditsNoticeRow
          key={notice.kind === 'signed-in' ? `signed-in:${notice.runtime}` : notice.kind}
          notice={notice}
        />
      ))}
    </div>
  );
}

function CreditsNoticeRow({ notice }: { notice: CloudCreditsNotice }) {
  const dismiss = useDismissCreditsNotice();
  const undo = useUndoFilledCredits();
  const setDefault = useSetCreditsDefault();
  const settings = useSettingsDeepLink();
  const busy = dismiss.isPending || undo.isPending || setDefault.isPending;

  if (notice.kind === 'filled') {
    const names = listOf(notice.runtimes);
    return (
      <Notice className="space-y-2" data-testid="credits-notice-filled">
        <p className="text-sm">
          {names} now {notice.runtimes.length === 1 ? 'runs' : 'run'} on your DorkOS credits,
          because {notice.runtimes.length === 1 ? 'it' : 'they'} had no working sign-in when you
          linked your account.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              dismiss.mutate({ kind: 'filled' });
              settings.open('runtimes');
            }}
          >
            Change
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => undo.mutate()}>
            Undo all
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => dismiss.mutate({ kind: 'filled' })}
          >
            OK
          </Button>
        </div>
      </Notice>
    );
  }

  if (notice.kind === 'offer') {
    return (
      <Notice className="space-y-2" data-testid="credits-notice-offer">
        <p className="text-sm">
          Your DorkOS account can pay for Claude Code. Nothing changes until you turn it on.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={busy}
            onClick={() => setDefault.mutate({ runtime: 'claude-code', useCredits: true })}
          >
            Use DorkOS credits
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => dismiss.mutate({ kind: 'offer' })}
          >
            Not now
          </Button>
        </div>
      </Notice>
    );
  }

  const name = runtimeLabel(notice.runtime);
  return (
    <Notice className="space-y-2" data-testid="credits-notice-signed-in">
      <p className="text-sm">
        You’re signed in to {name} now. It still runs on your DorkOS credits until you switch back.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          // Turning credits off removes the choice the notice is about, so it
          // settles with it.
          onClick={() => setDefault.mutate({ runtime: notice.runtime, useCredits: false })}
        >
          Use my {name} sign-in
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => dismiss.mutate({ kind: 'signed-in', runtime: notice.runtime })}
        >
          Keep credits
        </Button>
      </div>
    </Notice>
  );
}
