import { LogIn, MoreHorizontal, RotateCw } from 'lucide-react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Spinner,
  Switch,
} from '@/layers/shared/ui';
import { useMcpSigninFlow } from '@/layers/entities/agent';
import type { ManagedMcpServerView } from '@dorkos/shared/mesh-schemas';
import type { McpServerEntry } from '@dorkos/shared/transport';
import { cardSentence, primaryActionFor } from '../lib/mcp-card-copy';
import {
  holdsSignIn,
  liveTestResult,
  offersSignIn,
  probeAdjustedStatus,
  resolveStatusKey,
  usesOwnKey,
  type McpCardStatus,
  type StampedTestResult,
} from '../lib/mcp-server-state';
import { parseMcpServerName } from '../lib/mcp-scope';
import { McpServerCard } from './McpServerCard';
import { McpServerCardDetails } from './McpServerCardDetails';
import { McpSigninPanel } from './McpSigninPanel';

/** Props for {@link ManagedMcpServerCard}. */
export interface ManagedMcpServerCardProps {
  /** The managed (editable) server this card renders. */
  server: ManagedMcpServerView;
  /** The agent that owns the server — needed to drive its OAuth sign-in flow. */
  agentId: string;
  /** The live status entry joined by name, or `undefined` when the runtime reports none. */
  live: McpServerEntry | undefined;
  /** The most recent Test probe result for this server, stamped with when it landed. */
  testResult: StampedTestResult | undefined;
  /** Client epoch ms the managed listing last landed; see {@link liveTestResult}. */
  rosterUpdatedAt: number;
  /** Whether this card's Test probe is in flight. */
  testing: boolean;
  /** Whether a roster-level mutation is running (disables the card's controls). */
  busy: boolean;
  /** Toggle the server's enabled state. */
  onToggle: (name: string, enabled: boolean) => void;
  /** Probe the server's reachability. */
  onTest: (name: string) => void;
  /** Remove the server from management. */
  onRemove: (name: string) => void;
}

/**
 * One managed (editable) MCP server as a card: what it is, where it came from,
 * how it is doing, the one thing to do about it, and everything else behind "⋯".
 *
 * The card is presentation over a state machine that is deliberately unchanged
 * from DOR-985/DOR-1004 — see {@link resolveStatusKey}, {@link offersSignIn} and
 * {@link liveTestResult} for the precedence rules, which are the whole reason
 * this surface can be trusted about whether a server will actually work on the
 * next turn.
 *
 * **Sign out is not offered.** The token store can forget a server
 * (`AgentMcpOAuthService.forgetServer`), but no route exposes it yet, so the menu
 * item would be a button that does nothing. It is gated behind `canSignOut`
 * rather than written and disabled, because an action a person cannot take is
 * better absent than greyed out with no explanation.
 */
export function ManagedMcpServerCard({
  server,
  agentId,
  live,
  testResult,
  rosterUpdatedAt,
  testing,
  busy,
  onToggle,
  onTest,
  onRemove,
}: ManagedMcpServerCardProps) {
  const signin = useMcpSigninFlow(agentId, server.name);
  const signedInNow = signin.state.step === 'connected';
  // ONE answer to "what does the probe still say", shared by the chip, the Sign
  // in button and the sentence — so they cannot disagree about it.
  const probe = liveTestResult({
    stamped: testResult,
    signedInNow,
    authStatus: server.authStatus,
    rosterUpdatedAt,
  });
  const ownKey = usesOwnKey(server.connection);
  const resolved = resolveStatusKey({
    enabled: server.enabled,
    testedOk: probe?.ok === true,
    signedInNow,
    runtimeStatus: live?.status,
    runtimeError: live?.error,
    authStatus: server.authStatus,
    ownKey,
  });
  // The button stays mounted (disabled) while the start request is on the wire:
  // unmounting the element a person just pressed drops their focus to the body.
  const startingSignIn = signin.state.step === 'starting';
  const signinOnScreen =
    signin.state.step === 'disclosure' || signin.state.step === 'waiting' || startingSignIn;
  const status: McpCardStatus = signinOnScreen ? 'signing-in' : resolved;

  const showSignIn =
    offersSignIn({ statusKey: resolved, testResult: probe, signedInNow }) &&
    (signin.state.step === 'idle' || startingSignIn);

  const parsed = parseMcpServerName(server.name);
  const toolCount = probe?.ok ? (probe.toolCount ?? null) : signin.state.toolCount;
  // The probe adjustment is suppressed while the sign-in surface is on screen, on
  // the same reasoning as the primary action: a probe from before the sign-in
  // started would otherwise print "This server didn't answer" directly above the
  // consent panel a person is reading, competing with it and describing a moment
  // that is being superseded as they look at it.
  const sentenceStatus = signinOnScreen ? status : probeAdjustedStatus({ status, probe });
  const sentence = cardSentence(sentenceStatus, {
    displayName: parsed.displayName,
    toolCount,
    justSignedIn: signedInNow,
  });
  const primary = signinOnScreen ? 'none' : primaryActionFor(sentenceStatus);
  const canReauth = holdsSignIn({ connection: server.connection, authStatus: server.authStatus });

  return (
    <McpServerCard
      displayName={parsed.displayName}
      rawName={server.name}
      scope="agent"
      pluginName={parsed.pluginName}
      status={status}
      sentence={sentence}
      managed
      toggle={
        <Switch
          checked={server.enabled}
          onCheckedChange={(next) => onToggle(server.name, next)}
          disabled={busy}
          aria-label={`Enable ${server.name}`}
        />
      }
      actions={
        <>
          {showSignIn && (
            <Button
              variant="default"
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
          {!showSignIn && primary === 'try-again' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onTest(server.name)}
              disabled={testing || busy}
              aria-label={`Try ${server.name} again`}
              className="gap-1.5 focus-visible:ring-2"
            >
              {testing ? <Spinner size="xs" /> : null}
              Try again
            </Button>
          )}
          {!showSignIn && primary === 'test' && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onTest(server.name)}
              disabled={testing || busy}
              className="focus-visible:ring-2"
            >
              {testing ? <Spinner size="xs" /> : 'Test'}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`More actions for ${server.name}`}
                className="ml-auto focus-visible:ring-2"
              >
                <MoreHorizontal className="size-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onTest(server.name)} disabled={testing || busy}>
                <RotateCw className="size-3.5" aria-hidden />
                Test
              </DropdownMenuItem>
              {canReauth && (
                <DropdownMenuItem onSelect={() => signin.start()} disabled={busy}>
                  <LogIn className="size-3.5" aria-hidden />
                  Sign in again
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => onRemove(server.name)}
                disabled={busy}
              >
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
      details={
        <McpServerCardDetails
          connection={server.connection}
          authStatus={server.authStatus}
          authClientOrigin={server.authClientOrigin}
          scope="agent"
          pluginName={parsed.pluginName}
          rawName={parsed.rawName}
          displayName={parsed.displayName}
          toolCount={toolCount}
          error={probe?.ok === false ? probe.error : live?.error}
        />
      }
    >
      <McpSigninPanel flow={signin} serverName={parsed.displayName} />
    </McpServerCard>
  );
}
