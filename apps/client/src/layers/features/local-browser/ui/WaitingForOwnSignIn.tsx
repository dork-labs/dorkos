import type { LocalBrowserPersonState } from '@dorkos/shared/local-browser';

/** Main's sign-in-window guidance, retained alongside attached per-chat handoffs. */
export function WaitingForOwnSignIn({
  handoff,
  agentName,
  closed,
}: {
  handoff: NonNullable<LocalBrowserPersonState['handoff']>;
  agentName: string | null;
  closed: boolean;
}) {
  return (
    <div className="space-y-1 text-sm">
      <p>
        {agentName || handoff.agentName || 'The agent'} needs you to sign in to {handoff.site}.
      </p>
      {closed ? (
        <p>
          The sign-in window closed. Press{' '}
          <strong className="font-medium">Continue in the chat</strong> to hand it back.
        </p>
      ) : (
        <p>
          Finish in the sign-in window, then press{' '}
          <strong className="font-medium">Continue in the chat</strong>.
        </p>
      )}
    </div>
  );
}
