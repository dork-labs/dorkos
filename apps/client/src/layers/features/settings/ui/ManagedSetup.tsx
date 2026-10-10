import { useEffect, useState } from 'react';
import type { RemoteAccessEnrolment } from '@dorkos/shared/types';
import { Button, ExternalLinkAnchor, buttonVariants } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useRemoteAccessActions } from '@/layers/entities/tunnel';

/** Props for {@link ManagedSetup}. */
export interface ManagedSetupProps {
  /** Where this computer's setup stands, from the remote access report. */
  enrolment: RemoteAccessEnrolment;
}

/**
 * The consequence of setup, in plain words, shown before a person starts it.
 *
 * Exported so the tests pin the exact sentence: it is the consent, and a
 * rewording that softens it is a change to what the person agreed to.
 */
export const MANAGED_CONSENT =
  'From now on, DorkOS may open this computer’s address when something asks for it.';

/** How often the expiry line re-reads the clock while a code is showing. */
const EXPIRY_TICK_MS = 15_000;

/**
 * "Code expires in 9m", from the request's expiry and the time now.
 *
 * @param expiresAt - The request's expiry (ISO 8601).
 * @param now - The current time in ms.
 */
export function expiryLine(expiresAt: string, now: number): string {
  const left = Date.parse(expiresAt) - now;
  if (!Number.isFinite(left) || left <= 0) return 'Code expired';
  const minutes = Math.floor(left / 60_000);
  return minutes < 1 ? 'Code expires in under a minute' : `Code expires in ${minutes}m`;
}

/** The clock, re-read every {@link EXPIRY_TICK_MS} so the expiry line moves. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), EXPIRY_TICK_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** The code, the approval link and the wait, while a person approves elsewhere. */
function PendingSetup({
  enrolment,
  busy,
  onCancel,
}: {
  enrolment: Extract<RemoteAccessEnrolment, { status: 'pending' }>;
  busy: boolean;
  onCancel: () => void;
}) {
  const now = useNow();
  return (
    <div className="space-y-3" data-testid="managed-setup-pending">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">Approve on your DorkOS account</p>
        <p className="text-muted-foreground text-xs">Check that this code matches.</p>
      </div>
      <p
        className="bg-muted/40 rounded-lg border px-3 py-2 text-center font-mono text-lg tracking-widest"
        data-testid="managed-setup-code"
      >
        {enrolment.userCode}
      </p>
      <ExternalLinkAnchor
        href={enrolment.approveUrl}
        className={cn(buttonVariants({ size: 'sm' }), 'w-full')}
      >
        Open approval page
      </ExternalLinkAnchor>
      <div className="flex items-center justify-between gap-3">
        <div className="text-muted-foreground space-y-0.5 text-xs" role="status">
          <p>Waiting for approval</p>
          <p>{expiryLine(enrolment.expiresAt, now)}</p>
        </div>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
          Cancel setup
        </Button>
      </div>
    </div>
  );
}

/**
 * Setting up remote access from DorkOS on this computer (DOR-2086).
 *
 * **Nothing happens until the person presses the button here.** No linked
 * account, plan or saved setting starts setup: the consent sentence is on
 * screen first, and the press is the agreement to it. Approval then happens on
 * the person's DorkOS account, in a new tab, with a short code they can match.
 *
 * A declined or timed-out setup enrolled nothing, so it says which and offers
 * the same start again. Waiting can be cancelled, which withdraws the request.
 */
export function ManagedSetup({ enrolment }: ManagedSetupProps) {
  const actions = useRemoteAccessActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (write: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    write()
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Couldn’t start setup. Try again.');
      })
      .finally(() => setBusy(false));
  };

  if (enrolment.status === 'pending') {
    return (
      <div className="space-y-2">
        <PendingSetup enrolment={enrolment} busy={busy} onCancel={() => run(actions.withdraw)} />
        {error && (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        )}
      </div>
    );
  }

  let lead: { title: string; body: string };
  if (enrolment.status === 'denied') {
    lead = { title: 'Setup was declined', body: 'Nothing changed on this computer.' };
  } else if (enrolment.status === 'expired') {
    lead = { title: 'Setup timed out', body: 'The code ran out before approval.' };
  } else {
    lead = {
      title: 'Remote access from DorkOS',
      body: 'A web address for this computer, from your DorkOS account.',
    };
  }
  const retry = enrolment.status === 'denied' || enrolment.status === 'expired';

  return (
    <div className="space-y-3" data-testid={`managed-setup-${enrolment.status}`}>
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{lead.title}</p>
        <p className="text-muted-foreground text-xs">{lead.body}</p>
      </div>
      <p className="text-sm" data-testid="managed-setup-consent">
        {MANAGED_CONSENT}
      </p>
      <Button size="sm" className="w-full" disabled={busy} onClick={() => run(actions.enrol)}>
        {retry ? 'Start again' : 'Set up remote access'}
      </Button>
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );
}
