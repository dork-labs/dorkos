import { Loader2, LogIn, Trash2 } from 'lucide-react';
import { Button, Switch } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useMcpSigninFlow } from '@/layers/entities/agent';
import type { ManagedMcpServerView } from '@dorkos/shared/mesh-schemas';
import type { AgentMcpTestResult, McpServerEntry } from '@dorkos/shared/transport';
import { McpStatusChip, type McpStatusKey } from './McpStatusChip';
import { McpSigninPanel } from './McpSigninPanel';

/** The tone a test result reads in: a plain report, an actionable sign-in nudge, or an error. */
type TestResultTone = 'ok' | 'auth' | 'error';

/** The text color each {@link TestResultTone} renders in. */
const TEST_TONE_CLASS: Record<TestResultTone, string> = {
  ok: 'text-muted-foreground',
  auth: 'text-amber-700 dark:text-amber-400',
  error: 'text-destructive',
};

/**
 * Turn a probe result into one line of copy + its tone. Neither failure branch
 * shows the raw transport string: a 401 means "sign in", and anything else is a
 * plain "couldn't reach it" — the SDK's `Streamable HTTP error … {"message":…}`
 * is developer detail, kept on the element's `title` for anyone who wants it.
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
  return {
    text: 'Couldn’t reach this server. Check the address and that it is running.',
    tone: 'error',
  };
}

/** The one-line result of the most recent Test, rendered under a managed row. */
function TestResultLine({ result }: { result: AgentMcpTestResult }) {
  const { text, tone } = describeTestResult(result);
  return (
    <p
      className={cn('pl-4 text-xs', TEST_TONE_CLASS[tone])}
      {...(!result.ok && !result.needsAuth && result.error ? { title: result.error } : {})}
    >
      {text}
    </p>
  );
}

/**
 * The status a row shows, in precedence order.
 *
 * 1. A turned-off server is `disabled`, whatever anything else says.
 * 2. A sign-in that just completed is `connected` immediately — the person
 *    watched it happen and must not see the row claim otherwise.
 * 3. A live token (`authStatus === 'connected'`) beats a runtime `needs-auth`,
 *    because the runtime's status was captured on an earlier turn and predates
 *    the token. A runtime `failed` still wins — that is a different problem.
 * 4. Otherwise the runtime's live status, then the derived sign-in state, and
 *    finally nothing (Unknown) — which is what every row showed before DOR-985,
 *    because the runtime cache is only written during a turn.
 *
 * @param args.enabled - Whether the managed server is switched on.
 * @param args.signedInNow - Whether this row's sign-in flow just reached `connected`.
 * @param args.runtimeStatus - The status the runtime reported, if any.
 * @param args.authStatus - The listing's derived sign-in state, if any.
 */
function resolveStatusKey(args: {
  enabled: boolean;
  signedInNow: boolean;
  runtimeStatus: McpServerEntry['status'];
  authStatus: ManagedMcpServerView['authStatus'];
}): McpStatusKey | undefined {
  const { enabled, signedInNow, runtimeStatus, authStatus } = args;
  if (!enabled) return 'disabled';
  if (signedInNow) return 'connected';
  if (authStatus === 'connected' && runtimeStatus === 'needs-auth') return 'connected';
  return runtimeStatus ?? authStatus;
}

/**
 * Whether the row offers Sign in.
 *
 * The probe's own verdict counts, not just the status chip: a fresh server has
 * no runtime status at all, so Test telling the person "Needs sign-in — click
 * Sign in" while no such button existed was the whole of DOR-985. A connected or
 * disabled row never offers it, so a stale probe result cannot resurrect the
 * button after a successful sign-in.
 *
 * @param statusKey - The status the chip is showing.
 * @param testResult - The most recent probe result for this server, if any.
 */
function offersSignIn(
  statusKey: McpStatusKey | undefined,
  testResult: AgentMcpTestResult | undefined
): boolean {
  if (statusKey === 'disabled' || statusKey === 'connected') return false;
  return statusKey === 'needs-auth' || testResult?.needsAuth === true;
}

/** Props for {@link ManagedServerRow}. */
export interface ManagedServerRowProps {
  /** The managed (editable) server this row renders. */
  server: ManagedMcpServerView;
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
 * cluster (Sign in when the server needs OAuth, Test, Remove, enable switch). A
 * server that needs signing in gets a Sign in button driving the inline
 * {@link McpSigninPanel}; see {@link resolveStatusKey} and `offersSignIn` for
 * exactly when each appears.
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
  const signin = useMcpSigninFlow(agentId, server.name);
  const statusKey = resolveStatusKey({
    enabled: server.enabled,
    signedInNow: signin.state.step === 'connected',
    runtimeStatus: live?.status,
    authStatus: server.authStatus,
  });
  // The button stays mounted (disabled) while the start request is on the wire:
  // unmounting the element a person just pressed drops their focus to the body.
  const startingSignIn = signin.state.step === 'starting';
  const showSignIn =
    offersSignIn(statusKey, testResult) && (signin.state.step === 'idle' || startingSignIn);

  return (
    <div className="flex flex-col gap-1 py-1.5">
      <div className="flex items-center gap-2">
        <McpStatusChip statusKey={statusKey} />
        <span className="min-w-0 truncate text-sm">{server.name}</span>
        <span className="text-muted-foreground/50 text-xs">{server.connection.transport}</span>
        <div className="ml-auto flex items-center gap-1">
          {showSignIn && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => signin.start()}
              disabled={busy || startingSignIn}
              aria-label={`Sign in to ${server.name}`}
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
      <McpSigninPanel flow={signin} serverName={server.name} />
      {testResult && <TestResultLine result={testResult} />}
    </div>
  );
}
