import { FieldCard, FieldCardContent, SwitchSettingRow } from '@/layers/shared/ui';
import { useClaudeAccounts, useCloudCredits, useSetCreditsDefault } from '@/layers/shared/model';
import { getRuntimeDescriptor } from '@/layers/entities/runtime';
import { CreditsNotices } from './CreditsNotices';

/** A runtime's name as the app shows it everywhere ("Claude Code"). */
function runtimeLabel(type: string): string {
  return getRuntimeDescriptor(type).label;
}

/**
 * "Use credits for": one switch per runtime DorkOS credits reach (ADR
 * 261001-000811).
 *
 * Each switch is a view onto that runtime's default in Runs on, with no state
 * of its own: on, new work there runs on credits unless an agent or a session
 * picks something else; off, it goes back to the runtime's own sign-in, which
 * the line under the switch names. Only runtimes that DECLARE credits get a
 * switch, and the ones that do not are named in words, so nobody is told their
 * work runs on credits when it does not.
 *
 * Renders nothing until this computer is linked, and nothing at all on a server
 * where credits are switched off, beyond saying so.
 */
export function CreditsSource() {
  const { data } = useCloudCredits();
  const setDefault = useSetCreditsDefault();
  const { ownResolvedAccount, nameFor } = useClaudeAccounts();

  if (!data?.linked) return null;

  const wired = Object.entries(data.runtimes)
    .filter(([, state]) => state === 'wired')
    .map(([runtime]) => runtime);
  const pending = Object.entries(data.runtimes)
    .filter(([, state]) => state === 'follow-up')
    .map(([runtime]) => runtimeLabel(runtime));
  const ownSignIn = (runtime: string) =>
    runtime === 'claude-code' && ownResolvedAccount
      ? nameFor(ownResolvedAccount)
      : `your ${runtimeLabel(runtime)} sign-in`;

  return (
    <FieldCard>
      <FieldCardContent className="space-y-3">
        <p className="text-muted-foreground text-xs tracking-wide uppercase">Use credits for</p>
        <CreditsNotices />
        {data.killed && (
          <p className="text-muted-foreground text-sm">
            DorkOS credits are turned off on this computer, so nothing runs on them.
          </p>
        )}
        {wired.map((runtime) => {
          const recorded = data.defaults?.[runtime];
          // On only when the record says credits: a recorded "no" is off.
          const choice = recorded?.runsOn === 'credits' ? recorded : undefined;
          const label = runtimeLabel(runtime);
          return (
            <SwitchSettingRow
              key={runtime}
              label={label}
              description={
                choice
                  ? choice.chosenBy === 'default'
                    ? `DorkOS turned this on when you linked, because ${label} had no working sign-in. Turn it off to use ${ownSignIn(runtime)}.`
                    : `New ${label} sessions run on your DorkOS credits unless an agent or a session picks another account.`
                  : `New ${label} sessions run on ${ownSignIn(runtime)}.`
              }
              checked={choice !== undefined}
              disabled={setDefault.isPending || (data.killed && choice === undefined)}
              ariaLabel={`Use DorkOS credits for ${label}`}
              onCheckedChange={(useCredits) => setDefault.mutate({ runtime, useCredits })}
            />
          );
        })}
        {setDefault.isError && (
          <p role="alert" className="text-destructive text-sm">
            {setDefault.error instanceof Error && setDefault.error.message
              ? setDefault.error.message
              : 'Couldn’t save that. Try again.'}
          </p>
        )}
        {pending.length > 0 && (
          <p className="text-muted-foreground text-xs">
            {pending.join(' and ')} {pending.length === 1 ? 'runs' : 'run'} on{' '}
            {pending.length === 1 ? 'its' : 'their'} own sign-in for now.
          </p>
        )}
      </FieldCardContent>
    </FieldCard>
  );
}
