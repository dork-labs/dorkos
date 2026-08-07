import { useEffect, useRef } from 'react';
import { Button, FieldCard, FieldCardContent } from '@/layers/shared/ui';
import { McpSigninBody, useMcpSigninFlow } from '@/layers/entities/agent';

/** Props for {@link AddedServerSignin}. */
export interface AddedServerSigninProps {
  /** ULID of the agent that now owns the server. */
  agentId: string;
  /** The server that was just added and needs signing in. */
  serverName: string;
  /** Leave this step — the person is finished with it. */
  onDone: () => void;
}

/**
 * The step the add-server form flows into when the server it just wrote needs an
 * OAuth sign-in (DOR-1004).
 *
 * Adding a server that needs signing in used to end with the form closing and
 * the person having to notice a row telling them to press Sign in. This picks up
 * where the add left off: the sign-in starts by itself, the custody disclosure
 * and the link land where the person is already looking, and the row they would
 * otherwise have gone hunting for updates itself when the token arrives.
 *
 * The sign-in is started exactly once per mount, guarded by a ref rather than an
 * effect dependency — the flow's `start` is a fresh closure on every render, so
 * depending on it would restart the sign-in forever.
 */
export function AddedServerSignin({ agentId, serverName, onDone }: AddedServerSigninProps) {
  const flow = useMcpSigninFlow(agentId, serverName);
  const { start } = flow;
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    start();
  }, [start]);

  return (
    <FieldCard>
      <FieldCardContent className="space-y-2">
        <p className="text-sm font-medium">Sign in to {serverName}</p>
        <p className="text-muted-foreground text-xs">
          This server needs you to sign in before your agent can use it.
        </p>
        <McpSigninBody
          flow={flow}
          serverName={serverName}
          failedActions={
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => flow.start()}
                className="focus-visible:ring-2"
              >
                Try again
              </Button>
              <Button variant="ghost" size="sm" onClick={onDone} className="focus-visible:ring-2">
                Later
              </Button>
            </>
          }
          connectedActions={
            <Button variant="ghost" size="sm" onClick={onDone} className="focus-visible:ring-2">
              Done
            </Button>
          }
        />
        {flow.state.step !== 'failed' && flow.state.step !== 'connected' && (
          <Button variant="ghost" size="sm" onClick={onDone} className="focus-visible:ring-2">
            Later
          </Button>
        )}
      </FieldCardContent>
    </FieldCard>
  );
}
