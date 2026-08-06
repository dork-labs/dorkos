import { CheckCircle2, ExternalLink, Loader2, LogIn, Trash2 } from 'lucide-react';
import { Button, Switch } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useMcpSigninFlow, type McpSigninFlow } from '@/layers/entities/agent';
import type { ManagedMcpServer } from '@dorkos/shared/mesh-schemas';
import type { AgentMcpTestResult, McpServerEntry } from '@dorkos/shared/transport';
import { StatusChip } from './McpStatusChip';

/** The tone a test result reads in: a plain report, an actionable sign-in nudge, or an error. */
type TestResultTone = 'ok' | 'auth' | 'error';

/** The text color each {@link TestResultTone} renders in. */
const TEST_TONE_CLASS: Record<TestResultTone, string> = {
  ok: 'text-muted-foreground',
  auth: 'text-amber-700 dark:text-amber-400',
  error: 'text-destructive',
};

/**
 * Turn a probe result into one line of copy + its tone. A 401 is not a failure a
 * person should read as broken — it means "sign in", so it gets its own tone and
 * a nudge to the Sign in button rather than the raw `Streamable HTTP error … {"message":"Unauthorized"}`.
 *
 * @param result - The `mcp.test` probe result.
 */
function describeTestResult(result: AgentMcpTestResult): { text: string; tone: TestResultTone } {
  if (result.ok) {
    const count = result.toolCount ?? 0;
    return { text: `Connected — ${count} tool${count === 1 ? '' : 's'}.`, tone: 'ok' };
  }
  if (result.needsAuth) {
    return { text: 'Needs sign-in — click Sign in.', tone: 'auth' };
  }
  return { text: `Failed — ${result.error ?? 'could not connect.'}`, tone: 'error' };
}

/** The one-line result of the most recent Test, rendered under a managed row. */
function TestResultLine({ result }: { result: AgentMcpTestResult }) {
  const { text, tone } = describeTestResult(result);
  return <p className={cn('pl-4 text-xs', TEST_TONE_CLASS[tone])}>{text}</p>;
}

/**
 * The inline OAuth sign-in surface under a managed row: the server's custody
 * sentence, then the sign-in link (opened only after the disclosure is on
 * screen), a waiting spinner while polling, and a terminal success or error.
 * Reading order is the consent order — the disclosure sits above the link.
 *
 * @param props.flow - The sign-in state machine for this server.
 * @param props.serverName - The server's name, for the link's accessible label.
 */
function McpSigninPanel({ flow, serverName }: { flow: McpSigninFlow; serverName: string }) {
  const { state } = flow;

  if (state.step === 'starting') {
    return (
      <div className="text-muted-foreground flex items-center gap-2 pl-4 text-xs">
        <Loader2 className="size-3 animate-spin" aria-hidden />
        Starting sign-in…
      </div>
    );
  }

  if (state.step === 'disclosure') {
    return (
      <div className="space-y-2 pl-4">
        <p className="bg-muted rounded-md px-3 py-2 text-xs leading-relaxed">{state.disclosure}</p>
        <Button asChild size="sm" className="gap-1.5 focus-visible:ring-2">
          <a
            href={state.authorizeUrl ?? '#'}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => flow.authOpened()}
            aria-label={`Open the sign-in page for ${serverName}`}
          >
            Open the sign-in page
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
        </Button>
      </div>
    );
  }

  if (state.step === 'waiting') {
    return (
      <div className="text-muted-foreground flex items-center gap-2 pl-4 text-xs">
        <Loader2 className="size-3 animate-spin" aria-hidden />
        Waiting for you to finish signing in… You can close the tab when done.
      </div>
    );
  }

  if (state.step === 'connected') {
    return (
      <div className="flex items-center gap-2 pl-4 text-xs text-green-600 dark:text-green-500">
        <CheckCircle2 className="size-3.5" aria-hidden />
        Signed in — the server’s tools are available on the next turn.
      </div>
    );
  }

  // failed
  return (
    <div className="space-y-2 pl-4">
      <p role="alert" className="text-destructive text-xs leading-relaxed">
        {state.error ?? 'The sign-in did not complete.'}
      </p>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => flow.start()}
          className="focus-visible:ring-2"
        >
          Try again
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => flow.reset()}
          className="focus-visible:ring-2"
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}

/** Props for {@link ManagedServerRow}. */
export interface ManagedServerRowProps {
  /** The managed (editable) server this row renders. */
  server: ManagedMcpServer;
  /** The agent that owns the server — needed to drive its OAuth sign-in flow. */
  agentId: string;
  /** The live status entry joined by name, or `undefined` when the runtime reports none. */
  live: McpServerEntry | undefined;
  /** The most recent Test probe result for this server, if any. */
  testResult: AgentMcpTestResult | undefined;
  /** Whether this row's Test probe is in flight. */
  testing: boolean;
  /** Whether a roster-level mutation is running (disables the row's controls). */
  busy: boolean;
  /** Toggle the server's enabled state. */
  onToggle: (name: string, enabled: boolean) => void;
  /** Probe the server's reachability. */
  onTest: (name: string) => void;
  /** Remove the server from management. */
  onRemove: (name: string) => void;
}

/**
 * One managed (editable) server: labeled status, name, transport, and the action
 * cluster (Sign in when the server needs OAuth, Test, Remove, enable switch). An
 * OAuth server that reports `needs-auth` gets a Sign in button that drives the
 * inline {@link McpSigninPanel}; every other status hides it.
 */
export function ManagedServerRow({
  server,
  agentId,
  live,
  testResult,
  testing,
  busy,
  onToggle,
  onTest,
  onRemove,
}: ManagedServerRowProps) {
  const statusKey = server.enabled ? live?.status : 'disabled';
  const signin = useMcpSigninFlow(agentId, server.name);
  // Offer Sign in only for an enabled server the runtime says needs OAuth, and
  // only while no flow is already in progress (the panel takes over then).
  const canSignIn = statusKey === 'needs-auth' && signin.state.step === 'idle';
  return (
    <div className="flex flex-col gap-1 py-1.5">
      <div className="flex items-center gap-2">
        <StatusChip statusKey={statusKey} />
        <span className="min-w-0 truncate text-sm">{server.name}</span>
        <span className="text-muted-foreground/50 text-xs">{server.connection.transport}</span>
        <div className="ml-auto flex items-center gap-1">
          {canSignIn && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => signin.start()}
              disabled={busy}
              className="gap-1.5 focus-visible:ring-2"
            >
              <LogIn className="size-3.5" aria-hidden />
              Sign in
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onTest(server.name)}
            disabled={testing || busy}
            className="focus-visible:ring-2"
          >
            {testing ? <Loader2 className="size-3 animate-spin" /> : 'Test'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onRemove(server.name)}
            disabled={busy}
            aria-label={`Remove ${server.name}`}
            className="focus-visible:ring-2"
          >
            <Trash2 className="size-3.5" />
          </Button>
          <Switch
            checked={server.enabled}
            onCheckedChange={(next) => onToggle(server.name, next)}
            disabled={busy}
            aria-label={`Enable ${server.name}`}
          />
        </div>
      </div>
      {signin.state.step !== 'idle' && <McpSigninPanel flow={signin} serverName={server.name} />}
      {testResult && <TestResultLine result={testResult} />}
    </div>
  );
}
