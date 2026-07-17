'use client';

import { useCallback, useEffect, useState } from 'react';

import { authErrorMessage } from '@/layers/features/account/lib/auth-errors';
import { approveDevice, denyDevice, fetchPendingInstance } from '@/lib/auth-client';
import type { PendingInstanceView } from '@/lib/instance-types';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@/layers/shared/ui';

/** The panel's own view state on top of the device-code lookup status. */
type PanelState =
  | { phase: 'entry' }
  | { phase: 'loading' }
  | { phase: 'resolved'; pending: PendingInstanceView }
  | { phase: 'approved'; name?: string }
  | { phase: 'denied' }
  | { phase: 'error'; message: string };

/**
 * `/activate` device-approval panel (accounts-and-auth P2, task 2.3).
 *
 * Renders on a signed-in DorkOS account page. The visitor confirms the
 * 8-character user code shown by a DorkOS instance; the panel looks it up
 * (claiming it for this account), shows which instance is asking, and offers
 * Approve / Deny. Expired codes explain how to get a fresh one. Every call goes
 * through the `@/lib/auth-client` wrappers, so no component touches `better-auth`.
 *
 * @param props.initialCode - A user code pre-filled from the `?code=` param.
 */
export function ActivatePanel({ initialCode }: { initialCode?: string }) {
  const [code, setCode] = useState((initialCode ?? '').toUpperCase());
  const [state, setState] = useState<PanelState>({ phase: 'entry' });
  const [actionPending, setActionPending] = useState(false);

  const lookup = useCallback(async (userCode: string) => {
    const trimmed = userCode.trim();
    if (!trimmed) {
      setState({ phase: 'error', message: 'Enter the code shown by your instance.' });
      return;
    }
    setState({ phase: 'loading' });
    try {
      const pending = await fetchPendingInstance(trimmed);
      setState({ phase: 'resolved', pending });
    } catch {
      setState({ phase: 'error', message: 'We could not look up that code. Please try again.' });
    }
  }, []);

  // Auto-look up a pre-filled code so a click-through from the instance lands
  // directly on the approval prompt.
  useEffect(() => {
    if (initialCode?.trim()) void lookup(initialCode);
    // Only on first mount for the initial code.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onApprove(userCode: string, name?: string) {
    setActionPending(true);
    const { error } = await approveDevice(userCode);
    setActionPending(false);
    if (error) {
      setState({ phase: 'error', message: authErrorMessage(error) ?? 'Approval failed.' });
      return;
    }
    setState({ phase: 'approved', name });
  }

  async function onDeny(userCode: string) {
    setActionPending(true);
    const { error } = await denyDevice(userCode);
    setActionPending(false);
    if (error) {
      setState({
        phase: 'error',
        message: authErrorMessage(error) ?? 'Could not deny the request.',
      });
      return;
    }
    setState({ phase: 'denied' });
  }

  return (
    <Card className="w-full max-w-md gap-6">
      <CardHeader>
        <CardTitle className="text-xl">Link a DorkOS instance</CardTitle>
        <CardDescription>
          Confirm the 8-character code shown by your instance to link it to this DorkOS account.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {state.phase === 'entry' || state.phase === 'loading' ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void lookup(code);
            }}
            noValidate
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="user-code">Device code</Label>
              <Input
                id="user-code"
                name="user-code"
                autoComplete="one-time-code"
                autoCapitalize="characters"
                placeholder="ABCD1234"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
              />
            </div>
            <Button type="submit" className="w-full" disabled={state.phase === 'loading'}>
              {state.phase === 'loading' ? 'Checking…' : 'Continue'}
            </Button>
          </form>
        ) : null}

        {state.phase === 'resolved' ? (
          <ResolvedView
            code={code}
            pending={state.pending}
            actionPending={actionPending}
            onApprove={() => void onApprove(code, state.pending.name)}
            onDeny={() => void onDeny(code)}
            onReset={() => setState({ phase: 'entry' })}
          />
        ) : null}

        {state.phase === 'approved' ? (
          <p role="status" className="text-sm">
            <span className="font-medium">{state.name ?? 'Your instance'}</span> is now linked to
            your DorkOS account. You can close this page and return to your instance.
          </p>
        ) : null}

        {state.phase === 'denied' ? (
          <p role="status" className="text-sm">
            Request denied. The instance was not linked.
          </p>
        ) : null}

        {state.phase === 'error' ? (
          <div className="flex flex-col gap-3">
            <p role="alert" className="text-destructive text-sm">
              {state.message}
            </p>
            <Button variant="outline" onClick={() => setState({ phase: 'entry' })}>
              Try another code
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Normalize a user code for display: strips any dashes the visitor typed
 * (the resolve lookup already tolerates them) and uppercases it, so what
 * renders here always matches the raw code the instance itself displays —
 * no separator, all caps.
 */
function displayCode(code: string): string {
  return code.replace(/-/g, '').trim().toUpperCase();
}

/** The approve/deny prompt for a resolved user code, branching on its status. */
function ResolvedView({
  code,
  pending,
  actionPending,
  onApprove,
  onDeny,
  onReset,
}: {
  code: string;
  pending: PendingInstanceView;
  actionPending: boolean;
  onApprove: () => void;
  onDeny: () => void;
  onReset: () => void;
}) {
  if (pending.status === 'expired') {
    return (
      <div className="flex flex-col gap-3">
        <p role="status" className="text-sm">
          This code has expired. Ask the instance to generate a new code, then enter it here.
        </p>
        <Button variant="outline" onClick={onReset}>
          Enter a new code
        </Button>
      </div>
    );
  }
  if (pending.status !== 'pending') {
    return (
      <div className="flex flex-col gap-3">
        <p role="alert" className="text-destructive text-sm">
          That code can no longer be approved
          {pending.status === 'denied' ? ' — it was already denied.' : '.'}
        </p>
        <Button variant="outline" onClick={onReset}>
          Enter a new code
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-2">
        <p className="text-muted-foreground text-sm">
          Check that this code matches the one your DorkOS instance is showing.
        </p>
        <code className="bg-muted block rounded-md px-4 py-3 text-center font-mono text-2xl font-semibold tracking-[0.2em] tabular-nums">
          {displayCode(code)}
        </code>
      </div>
      <div className="rounded-md border p-4">
        <p className="text-sm font-medium">{pending.name ?? 'A DorkOS instance'}</p>
        <p className="text-muted-foreground text-sm">Platform: {pending.platform ?? 'unknown'}</p>
      </div>
      <p className="text-muted-foreground text-sm">
        Approving lets this instance act on behalf of your DorkOS account until you revoke it.
      </p>
      <div className="flex gap-3">
        <Button className="flex-1" onClick={onApprove} disabled={actionPending}>
          {actionPending ? 'Working…' : 'Approve'}
        </Button>
        <Button variant="outline" className="flex-1" onClick={onDeny} disabled={actionPending}>
          Deny
        </Button>
      </div>
    </div>
  );
}
