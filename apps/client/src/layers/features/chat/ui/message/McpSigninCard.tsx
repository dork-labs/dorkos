import { useEffect } from 'react';
import { KeyRound, TriangleAlert } from 'lucide-react';
import type { MessagePart } from '@dorkos/shared/types';
import { cn } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { McpSigninBody, useMcpSigninFlow } from '@/layers/entities/agent';

/** The `mcp_signin` member of {@link MessagePart}. */
type McpSigninPart = Extract<MessagePart, { type: 'mcp_signin' }>;

/** Props for {@link McpSigninCard}. */
export interface McpSigninCardProps {
  /** The card the server pushed into this turn. */
  part: McpSigninPart;
  /** The session the card lives in — where the resume is sent. */
  sessionId: string;
}

/** The `actionId` the resume rides, so the agent can tell it apart from a widget click. */
const RESUME_ACTION_ID = 'mcp_signin_connected';

/**
 * Flows this page has already resumed.
 *
 * Module-level, not a ref on the component, because the card does not survive
 * everything a person does: switching sessions and coming back re-mounts the
 * whole transcript, and a per-instance guard resets with it — so the second
 * mount would resume the agent a second time for a sign-in that happened once.
 * A flow id is resumable exactly once per page, and the set holds one short
 * string per sign-in.
 */
const resumedFlows = new Set<string>();

/** @internal Exported for testing only — flow ids are stable across test cases. */
export function resetResumedSigninFlows(): void {
  resumedFlows.clear();
}

/**
 * What the resumed agent is told to do.
 *
 * The whole product promise is that a person signs in and comes back to find the
 * work already done — so the one thing the agent must NOT do is announce itself.
 * "I'm connected!" is a turn spent telling someone what they just watched
 * happen.
 */
const RESUME_INSTRUCTIONS =
  'The sign-in finished and this server’s tools are ready to use. Continue the task the ' +
  'user originally asked for, using them. Do not describe or narrate the sign-in: do not ' +
  'announce that you are connected, do not thank the user for signing in, and do not ' +
  'summarize what just happened. Pick the job back up and do it.';

/** The one-line terminal note a failed sign-in leaves behind. */
function SigninFailedNote({ serverName }: { serverName: string }) {
  return (
    <div
      data-testid="mcp-signin-failed"
      className={cn(
        'my-2 flex items-start gap-2 rounded-md border px-3 py-2',
        'text-foreground border-border bg-muted/40'
      )}
    >
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber-500" />
      <p className="min-w-0 flex-1 text-sm">
        The sign-in to &ldquo;{serverName}&rdquo; didn’t finish. Ask your agent to try again.
      </p>
    </div>
  );
}

/**
 * The inline sign-in card an agent draws when it needs an OAuth-protected MCP
 * server connected (DOR-1004).
 *
 * The person reads the custody disclosure, opens the link, signs in, and comes
 * back — and the agent has already resumed. That last part is this component's
 * doing: when the flow it is watching reaches `connected`, it sends one
 * `ui_action` back into the session telling the agent to carry on with the
 * original task. Three guards keep that from misfiring, and all three are
 * load-bearing:
 *
 * 1. **Ownership.** Every tab watching this session renders this same card, and
 *    only the one where the person actually clicked the link owns the flow. A
 *    hydrated card in a second tab shows every state this one does and sends
 *    nothing — otherwise one sign-in would resume the agent once per open tab.
 * 2. **Fire-once, per flow, per page.** Not per component instance: switching
 *    sessions and coming back re-mounts the transcript, and a guard that resets
 *    with the component resumes the agent again for a sign-in that happened once.
 * 3. **A locked session settles quietly.** A `409` means a turn is already
 *    running — usually the agent doing the very work we would be asking for. So
 *    the card keeps its connected state and says nothing; no retry, no error.
 */
export function McpSigninCard({ part, sessionId }: McpSigninCardProps) {
  const transport = useTransport();
  const flow = useMcpSigninFlow(part.agentId, part.serverName);
  const { adopt } = flow;

  useEffect(() => {
    adopt({
      flowId: part.flowId,
      authorizeUrl: part.authorizeUrl,
      disclosure: part.disclosure,
    });
  }, [adopt, part.flowId, part.authorizeUrl, part.disclosure]);

  const connected = flow.state.step === 'connected';
  const { isOwner, state } = flow;
  const toolCount = state.toolCount;

  useEffect(() => {
    if (!connected || !isOwner) return;
    if (resumedFlows.has(part.flowId)) return;
    resumedFlows.add(part.flowId);
    void transport
      .sendUiAction(sessionId, {
        actionId: RESUME_ACTION_ID,
        widgetTitle: `Sign-in: ${part.serverName}`,
        payload: {
          server: part.serverName,
          ...(toolCount === null ? {} : { toolCount }),
          instructions: RESUME_INSTRUCTIONS,
        },
      })
      .catch((err: unknown) => {
        // Deliberately terminal, whatever went wrong. A locked session is the
        // expected case and needs no telling; anything else has already left the
        // person with a working connection, and a red row under a green tick
        // would only make them doubt it.
        console.warn('[mcp-signin-card] resume not delivered', {
          sessionId,
          flowId: part.flowId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }, [connected, isOwner, part.flowId, part.serverName, sessionId, toolCount, transport]);

  if (part.outcome === 'failed') return <SigninFailedNote serverName={part.serverName} />;

  return (
    <div
      data-testid="mcp-signin-card"
      className={cn(
        'my-2 flex items-start gap-2 rounded-md border px-3 py-2',
        'text-foreground border-border bg-muted/40'
      )}
    >
      <KeyRound aria-hidden="true" className="text-muted-foreground mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm">Sign in to {part.serverName}</p>
        <McpSigninBody flow={flow} serverName={part.serverName} />
      </div>
    </div>
  );
}
