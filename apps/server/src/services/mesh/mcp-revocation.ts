/**
 * Noticing that a managed server has stopped honouring the sign-in DorkOS holds,
 * and putting the fix where the person hit it (DOR-981).
 *
 * A stored token can die without expiring. The operator revokes the grant in the
 * provider's dashboard, an admin rotates the client, the server forgets the
 * session — and DorkOS, which has a token that looks perfectly live, keeps
 * injecting it. The row went on saying "Connected", the agent's tools went on
 * failing, and nothing anywhere said the two were the same problem.
 *
 * ## The signal, and why this one
 *
 * The subprocess that dials the server is the only thing that sees its answer, so
 * the honest question is which of ITS reports means "refused". It reports one per
 * turn: connecting a remote MCP server with a bearer the server rejects yields
 * the status `needs-auth`, distinct from `failed` (which is every other kind of
 * trouble — DNS, a 500, a socket that never opened). Treating `failed` as
 * revocation would throw away a working sign-in every time a network hiccupped,
 * so only `needs-auth` reaches here.
 *
 * That report arrives once per turn, early — the runtime asks for it as the turn
 * starts. So the card lands in the conversation at roughly the moment the agent
 * discovers the tools are gone, which is the whole point: the person is looking
 * at the place the work stopped, and the fix is right there.
 *
 * ## What it refuses to conclude
 *
 * Evidence of one 401 is not proof a sign-in is dead, and this is deliberately
 * slow to condemn one:
 *
 * - **Nothing held → nothing to say.** A server DorkOS has no token for is one
 *   the person never connected. Its row already reads "Needs sign-in", the agent
 *   can offer a sign-in itself, and an unbidden card would be noise.
 * - **One refresh first.** A refused access token beside a live refresh token is
 *   a blip as often as a revocation. The refresh runs (retried and classified by
 *   {@link McpTokenRefresher} — a transport failure is not a verdict), and only a
 *   refresh the OAuth server itself refuses is taken as one.
 * - **Never for a server carrying its own `Authorization`.** That credential is
 *   the operator's, pasted in at `add`; DorkOS neither holds nor refreshes it, so
 *   its 401 is theirs to fix and no OAuth card belongs on it. Enforced upstream,
 *   in `oauthTargetForCwd`.
 *
 * ## And what it deliberately does not do
 *
 * It says nothing. No message is put in the agent's mouth — no "your sign-in
 * expired", no apology, no instruction to click. The failure surfaces itself as a
 * card, the agent's own tool result already says what it says, and the agent is
 * left to react or not (`meta/agent-etiquette.md`). One card per server, too:
 * a live sign-in link is re-used rather than replaced, so a burst of refusals
 * cannot stack dead links above the working one.
 *
 * @module services/mesh/mcp-revocation
 */
import type { Logger } from '@dorkos/shared/logger';
import type { SessionEvent } from '@dorkos/shared/session-stream';

import { peekProjector } from '../session/index.js';
import { mcpOAuthCustodyDisclosure } from './agent-mcp-oauth-service.js';
import type { McpOAuthTarget, StartSigninResult } from './agent-mcp-oauth-service.js';

/**
 * The `mcp_signin_required` event as this module produces it — the projector
 * stamps `seq`. A distributed `Extract`, for the reason
 * `mcp-signin-resume.ts` spells out: omitting a key from the whole union
 * collapses it to the members' common keys.
 */
type RawSigninRequired = Omit<Extract<SessionEvent, { type: 'mcp_signin_required' }>, 'seq'>;

/**
 * What a turn observed: a session, where it ran, and the managed servers that
 * answered "sign in again" during it.
 */
export interface McpAuthEvidence {
  /** The session the turn ran in — where the card is drawn. */
  sessionId: string;
  /** That session's working directory, which is the agent's workspace. */
  cwd: string;
  /** The servers the runtime reported as needing a sign-in, by name. */
  serverNames: string[];
}

/**
 * The port a runtime calls when a turn saw a managed server refuse its
 * credentials. Injected at boot so no runtime holds an opinion about OAuth, and
 * absent in tests that only care about turns.
 */
export type McpAuthEvidencePort = (evidence: McpAuthEvidence) => void;

/**
 * The servers in a turn's MCP status snapshot that REFUSED the credentials
 * DorkOS sent — nothing else.
 *
 * `needs-auth` is the runtime's own word for a 401 at connect, and it is
 * deliberately the only status read as revocation. `failed` is every other kind
 * of trouble — DNS, a refused socket, a 500 — none of which say anything about a
 * token, and condemning a sign-in on one would sign the person out of a working
 * server every time their network hiccupped. `pending` and `disabled` say even
 * less.
 *
 * Lives here rather than in the runtime that produces the snapshot: which status
 * means "the token is dead" is a fact about credentials, and the runtime's job
 * ends at reporting what it saw.
 *
 * @param servers - The runtime's per-turn status entries.
 */
export function authRefusedServers(
  servers: ReadonlyArray<{ name: string; status?: string }>
): string[] {
  return servers.filter((server) => server.status === 'needs-auth').map((server) => server.name);
}

/** The OAuth engine, narrowed to what a revocation needs. Satisfied by `AgentMcpOAuthService`. */
export interface McpRevocationOAuthPort {
  /** The live token DorkOS holds for a target, or `undefined` — "was this ever connected?". */
  getAccessToken(agentId: string, serverName: string, serverUrl: string): string | undefined;
  /** Run the target's refresh now; `true` when a fresh token replaced the cached one. */
  refreshNow(target: McpOAuthTarget): Promise<boolean>;
  /** Delete the target's stored credentials, so a new sign-in cannot find the dead ones. */
  forgetServer(agentId: string, serverName: string): Promise<void>;
  /** A sign-in link already waiting for this target, if any. */
  liveSigninFor(
    agentId: string,
    serverName: string
  ): { flowId: string; authorizeUrl: string } | undefined;
  /** Begin a sign-in, recording the session and directory to resume in. */
  startSignin(
    target: McpOAuthTarget,
    options?: { originSessionId?: string; originCwd?: string }
  ): Promise<StartSigninResult>;
}

/** The managed-server registry, narrowed to what a revocation needs. */
export interface McpRevocationServerPort {
  /** Translate `(cwd, serverName)` into the OAuth target it belongs to, or `undefined`. */
  oauthTargetForCwd(
    cwd: string,
    serverName: string
  ): { agentId: string; serverName: string; serverUrl: string } | undefined;
  /** Record that a server authenticates with OAuth, so its row can offer a sign-in. */
  learnOAuthAuthKind(agentId: string, name: string): Promise<boolean>;
}

/** Collaborators for {@link createMcpRevocationWatch}. */
export interface McpRevocationDeps {
  /** The OAuth engine. */
  oauth: McpRevocationOAuthPort;
  /** The managed-server registry. */
  servers: McpRevocationServerPort;
  /** Diagnostic sink; defaults to `console`. */
  logger?: Pick<Logger, 'warn' | 'info'>;
  /**
   * Called once per reported server when its investigation settles, however it
   * settles — including the ones dismissed without one.
   *
   * A test seam, and a necessary one: this work is deliberately detached from the
   * turn that reported the evidence, so a caller has nothing to await and a test
   * would otherwise be reduced to guessing how many microtasks a refresh takes.
   * Production omits it.
   */
  onSettled?: (serverName: string) => void;
}

/** The per-target key one investigation is serialized on. */
function targetKey(agentId: string, serverName: string): string {
  return `${agentId}\0${serverName}`;
}

/**
 * Build the port that turns "this server refused us" into an evicted credential
 * and a sign-in card.
 *
 * The returned port is fire-and-forget: it is called from a runtime's own
 * per-turn bookkeeping, where a rejected promise would become an unhandled
 * rejection on a turn that has otherwise succeeded. Every way it can fail is a
 * log line.
 *
 * @param deps - The OAuth engine, the managed-server registry, and a log sink.
 */
export function createMcpRevocationWatch(deps: McpRevocationDeps): McpAuthEvidencePort {
  const logger = deps.logger ?? console;
  // One investigation per target at a time. Two turns in the same workspace can
  // report the same dead server within milliseconds of each other, and each
  // would otherwise mint its own sign-in flow before the other's finished.
  const inFlight = new Set<string>();

  const investigate = async (target: McpOAuthTarget, evidence: McpAuthEvidence): Promise<void> => {
    const { agentId, serverName, serverUrl } = target;
    const live = deps.oauth.liveSigninFor(agentId, serverName);

    if (!deps.oauth.getAccessToken(agentId, serverName, serverUrl)) {
      // DorkOS holds nothing for this server, so nothing of its is being refused.
      //
      // Usually that means it was never connected: its row already reads
      // needs-auth, the agent can offer a sign-in itself, and an unbidden card
      // would be noise. The exception is a sign-in ALREADY waiting — the person
      // is part-way through one (often the one a previous dead turn drew) and the
      // server is still refusing. Then the card is re-drawn on the SAME flow,
      // which keeps a working link on screen instead of letting the projector's
      // grace age it out from under someone mid-browser.
      if (live) draw(evidence.sessionId, target, live);
      return;
    }

    // A refused access token beside a live refresh token is as often a blip as a
    // revocation; a refresh that succeeds says it was one, and the next turn
    // carries the new token.
    if (await deps.oauth.refreshNow(target)) {
      logger.info(`[mcp-revocation] refreshed ${serverName} after a refused token`);
      return;
    }

    // The verdict. Clear the stored credential as well as the cached one: a
    // sign-in that could still find the dead token set on disk would report the
    // server "already connected" and hand the person no link at all.
    await deps.oauth.forgetServer(agentId, serverName);
    // A 401 proves the server is OAuth-protected, which is what makes the row
    // read "Needs sign-in" rather than fall silent — and an entry added by hand
    // may never have carried the hint. Best-effort: the eviction is the fix, and
    // a failed manifest write must not cost the card.
    await deps.servers.learnOAuthAuthKind(agentId, serverName).catch((err: unknown) => {
      logger.warn(
        `[mcp-revocation] could not record authKind for "${serverName}": ${message(err)}`
      );
      return false;
    });

    // A sign-in already waiting is re-used rather than replaced: minting a second
    // flow would put a dead link on screen beside the working one.
    const signin = live ?? (await startSignin(target, evidence));
    if (!signin) return;
    draw(evidence.sessionId, target, signin);
    logger.info(`[mcp-revocation] ${serverName} needs signing in again — card drawn`);
  };

  /** Mint a fresh sign-in for a condemned target, or `undefined` when it has no link. */
  const startSignin = async (
    target: McpOAuthTarget,
    evidence: McpAuthEvidence
  ): Promise<{ flowId: string; authorizeUrl: string } | undefined> => {
    const started = await deps.oauth.startSignin(target, {
      originSessionId: evidence.sessionId,
      originCwd: evidence.cwd,
    });
    // `alreadyConnected` here would mean the credential we just deleted still
    // authorizes the server. There is no link to show and nothing to fix.
    return started.authorizeUrl
      ? { flowId: started.flowId, authorizeUrl: started.authorizeUrl }
      : undefined;
  };

  /** Put the sign-in card for a target on a session. */
  const draw = (
    sessionId: string,
    target: McpOAuthTarget,
    signin: { flowId: string; authorizeUrl: string }
  ): void => {
    drawCard(sessionId, {
      type: 'mcp_signin_required',
      agentId: target.agentId,
      serverName: target.serverName,
      flowId: signin.flowId,
      authorizeUrl: signin.authorizeUrl,
      disclosure: mcpOAuthCustodyDisclosure(target.serverName),
    });
  };

  return (evidence) => {
    for (const serverName of new Set(evidence.serverNames)) {
      const target = deps.servers.oauthTargetForCwd(evidence.cwd, serverName);
      const key = target && targetKey(target.agentId, serverName);
      // Nothing DorkOS manages a sign-in for, or an investigation of this very
      // target already running — a second turn reporting the same dead server
      // while the first is still deciding what to do about it.
      if (!target || !key || inFlight.has(key)) {
        deps.onSettled?.(serverName);
        continue;
      }
      inFlight.add(key);
      void investigate(target, evidence)
        .catch((err: unknown) => {
          logger.warn(`[mcp-revocation] could not act on ${serverName}: ${message(err)}`);
        })
        .finally(() => {
          inFlight.delete(key);
          deps.onSettled?.(serverName);
        });
    }
  };
}

/**
 * Put the card in the conversation.
 *
 * Ingested into the projector rather than pushed onto a turn's event queue,
 * because the turn that produced the evidence may already be over by the time
 * the refresh has been tried. The projector carries a sign-in card past its own
 * turn and into later snapshots, so the card reaches a tab opened afterwards
 * too — and a session nobody is watching simply has no projector, which is a
 * quiet no-op rather than a failure.
 */
function drawCard(sessionId: string, event: RawSigninRequired): void {
  peekProjector(sessionId)?.ingest(event);
}

/** The readable half of an unknown throw. */
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
