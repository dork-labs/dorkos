import { useEffect } from 'react';
import { CheckCircle2, KeyRound, TriangleAlert } from 'lucide-react';
import type { MessagePart } from '@dorkos/shared/types';
import { cn } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';
import { McpSigninBody, useMcpSigninFlow } from '@/layers/entities/agent';

/** The `mcp_signin` member of {@link MessagePart}. */
type McpSigninPart = Extract<MessagePart, { type: 'mcp_signin' }>;

/** Props for {@link McpSigninCard}. */
export interface McpSigninCardProps {
  /** The card the server pushed into this turn. */
  part: McpSigninPart;
}

/** The shell every state of this card renders inside. */
function CardShell({
  testId,
  icon,
  children,
}: {
  testId: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'my-2 flex items-start gap-2 rounded-md border px-3 py-2',
        'text-foreground border-border bg-muted/40'
      )}
    >
      {icon}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * The terminal receipt a finished sign-in leaves in the transcript.
 *
 * This is the ONLY durable record of what was authorized and when — the runtime's
 * own transcript never sees a sign-in, and the settings row shows a live status,
 * not a history. So it survives the turn the sign-in triggered, and reads as a
 * statement about the past rather than something to act on.
 */
function SigninReceipt({ part }: { part: McpSigninPart }) {
  if (part.outcome === 'failed') {
    return (
      <CardShell
        testId="mcp-signin-failed"
        icon={
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber-500" />
        }
      >
        <p className="text-sm">
          The sign-in to &ldquo;{part.serverName}&rdquo; didn’t finish. Ask your agent to try again.
        </p>
      </CardShell>
    );
  }
  return (
    <CardShell
      testId="mcp-signin-receipt"
      icon={
        <CheckCircle2
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-green-600 dark:text-green-500"
        />
      }
    >
      <p className="text-sm">
        Connected to {part.serverName}
        {part.toolCount === undefined
          ? ''
          : ` — ${part.toolCount} tool${part.toolCount === 1 ? '' : 's'}`}
        .
      </p>
    </CardShell>
  );
}

/**
 * The inline sign-in card an agent draws when it needs an OAuth-protected MCP
 * server connected (DOR-1004).
 *
 * The person reads the custody disclosure, opens the link, signs in, and comes
 * back to find the agent already working. This component does NOT arrange that
 * last part: the resume is triggered server-side, at the moment the token
 * exchange succeeds, so it happens with no tab open, after a reload, and exactly
 * once however many people are watching the session. This is the display half
 * only.
 *
 * It still watches the flow it was handed, because watching is what lets the card
 * show the sign-in landing without waiting for the next server event — and every
 * tab watches, so every tab shows the same thing. Once the resolution arrives the
 * card becomes a terminal {@link SigninReceipt} and stops being interactive.
 */
export function McpSigninCard({ part }: McpSigninCardProps) {
  const flow = useMcpSigninFlow(part.agentId, part.serverName);
  const { adopt } = flow;
  const settled = part.outcome !== undefined;

  useEffect(() => {
    // A settled receipt is history: adopting it would poll a flow that has
    // already ended, every time an old turn is scrolled back into view.
    if (settled) return;
    adopt({
      flowId: part.flowId,
      authorizeUrl: part.authorizeUrl,
      disclosure: part.disclosure,
    });
  }, [settled, adopt, part.flowId, part.authorizeUrl, part.disclosure]);

  if (part.outcome !== undefined) return <SigninReceipt part={part} />;

  return (
    <CardShell
      testId="mcp-signin-card"
      icon={
        <KeyRound aria-hidden="true" className="text-muted-foreground mt-0.5 size-4 shrink-0" />
      }
    >
      <p className="text-sm">Sign in to {part.serverName}</p>
      <McpSigninBody
        flow={flow}
        serverName={part.serverName}
        failedActions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => flow.start()}
            className="focus-visible:ring-2"
          >
            Try again
          </Button>
        }
      />
    </CardShell>
  );
}
