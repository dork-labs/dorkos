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
      className={cn('mt-1 pl-4 text-xs', TEST_TONE_CLASS[tone])}
      {...(!result.ok && !result.needsAuth && result.error ? { title: result.error } : {})}
    >
      {text}
    </p>
  );
}

/**
 * The status a row shows, in precedence order.
 *
 * Two sources disagree here, and the rule is symmetric — whichever knows a
 * SIGN-IN fact more recently wins, because the runtime's status is a snapshot
 * from the last turn while the sign-in state is read live:
 *
 * 1. A turned-off server is `disabled`, whatever anything else says.
 * 2. A Test that came back OK is `connected`. Test is the only thing on this row
 *    that actually dialled the server, and since DOR-985 it dials WITH the
 *    bearer — so an `ok` is a round trip that provably worked, which beats every
 *    cached opinion below it. (Its `needsAuth` counterpart already decides the
 *    Sign in button; this is the same evidence pointed at the chip.)
 * 3. A sign-in that just completed is `signed-in` immediately — the person
 *    watched it happen and must not see the row claim otherwise.
 * 4. A runtime `failed` wins over both overrides below: that is a reachability
 *    problem, and holding (or lacking) a token says nothing about it.
 * 5. A live token beats a runtime `needs-auth` — the token postdates the turn.
 * 6. NO token beats a runtime `connected` OR a runtime `pending` — this is the
 *    STRONGER half: with no token to inject, the next turn provably carries no
 *    bearer, so a green chip would be a lie. Without it, a token that expired
 *    after one successful turn left the row green with no Sign in button, which
 *    is DOR-985 all over again. `pending` is the same lie told more quietly: a
 *    cached "connecting…" from a past turn outranking the live, provable fact
 *    that there is no token leaves the row spinning with nothing to press.
 * 7. Otherwise the runtime's live status, then the derived sign-in state, and
 *    finally nothing (Unknown) — which is what every row showed before DOR-985,
 *    because the runtime cache is only written during a turn.
 *
 * @param args.enabled - Whether the managed server is switched on.
 * @param args.testedOk - Whether the most recent Test probe reached the server.
 * @param args.signedInNow - Whether this row's sign-in flow just reached `connected`.
 * @param args.runtimeStatus - The status the runtime reported, if any.
 * @param args.authStatus - The listing's derived sign-in state, if any.
 */
function resolveStatusKey(args: {
  enabled: boolean;
  testedOk: boolean;
  signedInNow: boolean;
  runtimeStatus: McpServerEntry['status'];
  authStatus: ManagedMcpServerView['authStatus'];
}): McpStatusKey | undefined {
  const { enabled, testedOk, signedInNow, runtimeStatus, authStatus } = args;
  if (!enabled) return 'disabled';
  if (testedOk) return 'connected';
  if (signedInNow) return 'signed-in';
  if (runtimeStatus === 'failed') return 'failed';
  if (authStatus === 'connected' && runtimeStatus === 'needs-auth') return 'signed-in';
  if (authStatus === 'needs-auth' && (runtimeStatus === 'connected' || runtimeStatus === 'pending'))
    return 'needs-auth';
  if (runtimeStatus) return runtimeStatus;
  return authStatus === 'connected' ? 'signed-in' : authStatus;
}

/**
 * Whether the row offers Sign in.
 *
 * The probe's own verdict counts, and it counts even against a green chip: Test
 * is the only thing here that actually contacted the server, so if it came back
 * 401 the person needs the button no matter what the runtime cached. Telling
 * them "Needs sign-in — click Sign in" beside no such button was the whole of
 * DOR-985.
 *
 * The two things that do silence it: a turned-off server, and a sign-in that
 * just completed in this very row (whose fresh token postdates any probe).
 *
 * @param args.statusKey - The status the chip is showing.
 * @param args.testResult - The most recent probe result for this server, if any.
 * @param args.signedInNow - Whether this row's sign-in flow just reached `connected`.
 */
function offersSignIn(args: {
  statusKey: McpStatusKey | undefined;
  testResult: AgentMcpTestResult | undefined;
  signedInNow: boolean;
}): boolean {
  const { statusKey, testResult, signedInNow } = args;
  if (statusKey === 'disabled' || signedInNow) return false;
  if (testResult?.needsAuth === true) return true;
  return statusKey === 'needs-auth';
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
  const signedInNow = signin.state.step === 'connected';
  const statusKey = resolveStatusKey({
    enabled: server.enabled,
    testedOk: testResult?.ok === true,
    signedInNow,
    runtimeStatus: live?.status,
    authStatus: server.authStatus,
  });
  // The button stays mounted (disabled) while the start request is on the wire:
  // unmounting the element a person just pressed drops their focus to the body.
  const startingSignIn = signin.state.step === 'starting';
  const showSignIn =
    offersSignIn({ statusKey, testResult, signedInNow }) &&
    (signin.state.step === 'idle' || startingSignIn);

  return (
    // No `gap` between the rows here: the sign-in panel's live region is always
    // mounted (see McpSigninPanel) and a gap would reserve space for it even
    // while it is empty. The optional lines carry their own top margin instead.
    <div className="flex flex-col py-1.5">
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
