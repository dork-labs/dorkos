import { useState } from 'react';
import { useTransport } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';

/** Another chat's held sign-in pauses effects here without taking focus or granting its page. */
export function PausedForSignIn({
  handoffId,
  agentName,
}: {
  handoffId: string;
  agentName: string | null;
}) {
  const transport = useTransport();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const show = async () => {
    setBusy(true);
    setError(false);
    try {
      // The person-only handler focuses the held tab. Its other-chat state must never
      // replace this chat's cache or grant that page to its agent.
      await transport.signInLocalBrowser({ handoffId });
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <p className="text-sm break-words">
        Paused while you sign in for another chat. {agentName || 'Your agent'} can still read this
        tab.
      </p>
      {error && (
        <p role="alert" className="text-sm">
          Couldn’t show the sign-in. Try again.
        </p>
      )}
      <Button
        onClick={() => void show()}
        disabled={busy}
        className="h-auto min-h-11 w-full py-2 whitespace-normal transition-none min-[480px]:w-auto md:h-auto"
      >
        Show the sign-in
      </Button>
    </div>
  );
}
