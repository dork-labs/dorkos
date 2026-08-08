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
 * ## The runtime's report is a TRIGGER, never a verdict
 *
 * This is the whole design, and it is the correction of a wrong first attempt.
 *
 * The runtime's per-turn MCP status snapshot looks like it answers "was our token
 * refused?". It does not, for three independent reasons — all three verified
 * against the shipped claude-code binary and then observed live (see the
 * empirical anchor below):
 *
 * 1. **The status you would reach for is the wrong one.** For an http/sse server
 *    whose config carries an `Authorization` header — which is EVERY server
 *    DorkOS injects a bearer into — a 401/403 at connect is reported as
 *    `failed`, with an error naming the rejected header. `needs-auth` is reserved
 *    for the TOKENLESS case, where DorkOS holds nothing and correctly says
 *    nothing. Keying on `needs-auth` therefore never fires for the very bug this
 *    module exists for.
 * 2. **A `needs-auth` verdict is CACHED and replayed for 15 minutes.** The CLI
 *    writes it to `mcp-needs-auth-cache.json` and, while the entry is fresh,
 *    skips connecting entirely and re-reports `needs-auth` from disk. So the
 *    snapshot can describe a server that has since been signed into. Acting on
 *    it would delete the grant the person had just created — repeatedly, for a
 *    quarter of an hour.
 * 3. **The snapshot is partial.** It is requested as the turn starts and answers
 *    whenever it answers; servers still connecting report `pending`. A report is
 *    a rumour about a moment that has already passed.
 *
 * So the report only decides WHETHER TO LOOK. The arbiter is the probe — the same
 * reachability probe the settings panel's Test button uses, which dials the
 * server through the connection a turn would use, bearer and all, right now.
 * Only a probe that comes back refused proceeds. That single choice immunises
 * this against all three problems above at once: a cached verdict is bypassed
 * because the probe really dials, a just-signed-in grant passes and the watch
 * stands down, and a transport blip is not a refusal.
 *
 * ## Empirical anchor, and exactly how far it reaches
 *
 * Observed 2026-08-07 against `@anthropic-ai/claude-agent-sdk` **0.3.177**: one
 * real turn, two MCP servers pointed at the same always-401 endpoint, one
 * carrying a DorkOS-style bearer and one with no credentials at all. The verbatim
 * `query.mcpServerStatus()` array is committed at
 * `__tests__/fixtures/mcp-server-status-401.observed.json` and asserted against
 * in `mcp-revocation.test.ts`, so the anchor is reproducible from the repo
 * without spending a turn. The harness that produced it: an `http.createServer`
 * answering every request `401` with a `WWW-Authenticate: Bearer` header, both
 * servers declared under `query({ options: { mcpServers } })`, and the resolved
 * `mcpServerStatus()` promise printed. It is not run by any suite.
 *
 * Three things to carry forward, and they are NOT equally well evidenced:
 *
 * 1. **Observed.** The bearer-carrying server reports `failed` with the
 *    header-rejected error text. That is the headline finding and the reason the
 *    first version of this module never fired.
 * 2. **Observed.** `errorCode` (`AUTH_HEADER_REJECTED` in the binary) **does not
 *    cross the SDK boundary** — absent from the observed objects and from
 *    `McpServerStatus` in `sdk.d.ts`. Detection cannot key on it, and
 *    deliberately keys on nothing the SDK words ({@link mcpAuthEvidenceFrom}).
 * 3. **Binary reading only.** That `needs-auth` is the TOKENLESS case, and that
 *    its verdict is cached for 15 minutes. The live run did NOT produce a
 *    `needs-auth`: the tokenless server also came back `failed` (with an empty
 *    error), because the harness 401'd the dynamic-client-registration request
 *    too and the CLI took a different branch. So that half rests on reading the
 *    shipped binary — the needs-auth cache's writer/freshness pair, its default
 *    TTL of 900000 ms, and the dispatcher's "Skipping connection (cached
 *    needs-auth)" — not on observation.
 *
 * Point 3 is precisely why the probe exists rather than a smarter status filter:
 * the one claim this module cannot fully verify from outside is also the one it
 * refuses to act on.
 *
 * ### Re-derived 2026-08-07 against 0.3.224 — statically, no live turn
 *
 * 0.3.221 fixed external MCP servers not being connected before the first turn,
 * which is exactly the timing point 3 above leans on, so the whole anchor was
 * re-derived by diffing the 0.3.177 and 0.3.224 `claude` binaries side by side.
 * Every claim survives:
 *
 * - `McpServerStatus` in `sdk.d.ts` is **byte-identical** across the two
 *   versions, down to the five-value `status` union. Point 2 therefore still
 *   holds by construction: `errorCode` and the newly-added internal
 *   `displayDetail` are on the CLI's own object and on neither published type.
 * - The bearer branch still returns `type: 'failed'`, and its message is
 *   byte-identical to the string in the committed fixture. Point 1 holds.
 * - The tokenless `needs-auth` branch is still reached only when there is no
 *   caller `Authorization` header, no CLI-owned bearer, and no first-party auth.
 *   Point 3's first half holds.
 * - The needs-auth cache still writes to `mcp-needs-auth-cache.json`, is still
 *   read through a freshness check with a **default TTL of 900000 ms**, and the
 *   dispatcher still logs "Skipping connection (cached needs-auth)" and reports
 *   `needs-auth` without dialling. Point 3's second half holds. 0.3.224 adds a
 *   per-entry TTL override, used to shorten the cache to 90000 ms when a refresh
 *   token is already held — which only ever makes a stale verdict shorter-lived.
 * - Every server is still seeded `pending` before its connect is attempted, so a
 *   snapshot is still a rumour about a moment that has passed.
 *
 * The fixture is therefore **not** refreshed: nothing it encodes changed, and a
 * fixture rewritten from a run that observed the same thing would be churn.
 * What 0.3.224 does add is two more ways to be `failed` or `needs-auth` that have
 * nothing to do with a dead DorkOS token — a managed-policy block, and a
 * claude.ai-proxy ineligibility gate. Neither needs handling here, and that is
 * the point: the net stays coarse and the probe stays the arbiter.
 *
 * **Deliberately no minified symbol names above.** The 0.3.177 note cited three
 * (`Uc8`, `eo7`, `YE3`); all three were renamed by 0.3.224, and the binary in
 * fact carries two independently-minified copies of the bundle that disagree with
 * each other on names. The string literals quoted instead survived both. Cite
 * strings, not symbols.
 *
 * **Still unverified on 0.3.224**: the live half. Nobody has re-run the two-server
 * 401 harness against it, so the observed status *distribution* — in particular
 * whether 0.3.221's connect-before-first-turn fix makes the two unrelated project
 * servers report something other than `pending` — rests on the 0.3.177 run.
 * That distribution is not something this module acts on.
 *
 * ## What it refuses to conclude
 *
 * - **Nothing held → nothing to say.** A server DorkOS has no token for is one
 *   the person never connected. Its row already reads "Needs sign-in", the agent
 *   can offer a sign-in itself, and an unbidden card would be noise.
 * - **Probe not refused → stand down**, and retire any card this module drew.
 *   That covers the healthy case, the unreachable case, and the no-probe-wired
 *   case: none of them is evidence a credential is dead.
 * - **One refresh before condemning.** A refused access token beside a live
 *   refresh token is as often a blip as a revocation.
 * - **Only the OAuth server's own refusal deletes the stored grant.** A refresh
 *   that merely ran out of attempts on transport failures drops the CACHED token
 *   (so the row tells the truth and the next turn retries) and leaves the stored
 *   one alone for a later refresh or a restart's `warm` to recover.
 * - **Never for a server carrying its own `Authorization` header.** That
 *   credential is the operator's, pasted in at `add`; DorkOS neither holds nor
 *   refreshes it, so its 401 is theirs to fix. Enforced in `oauthTargetForCwd`.
 *
 * ## And what it deliberately does not do
 *
 * It says nothing. No message is put in the agent's mouth. The failure surfaces
 * itself as a card, the agent's own tool result already says what it says, and
 * the agent is left to react or not (`meta/agent-etiquette.md`). One card per
 * server, too: a live sign-in link is re-used rather than replaced.
 *
 * @module services/mesh/mcp-revocation
 */
import type { Logger } from '@dorkos/shared/logger';
import type { SessionEvent } from '@dorkos/shared/session-stream';

import { peekProjector } from '../session/index.js';
import { mcpOAuthCustodyDisclosure } from './agent-mcp-oauth-service.js';
import type { McpOAuthTarget, StartSigninResult } from './agent-mcp-oauth-service.js';
import type { McpCacheRefreshVerdict } from './agent-mcp-access-token-cache.js';
import { probeTarget, tokenWasRefused, type McpTargetProbe } from './agent-mcp-target-probe.js';

/**
 * The `mcp_signin_required` / `mcp_signin_resolved` events as this module
 * produces them — the projector stamps `seq`. Distributed `Extract`s, for the
 * reason `mcp-signin-resume.ts` spells out: omitting a key from the whole union
 * collapses it to the members' common keys.
 */
type RawSigninRequired = Omit<Extract<SessionEvent, { type: 'mcp_signin_required' }>, 'seq'>;
type RawSigninResolved = Omit<Extract<SessionEvent, { type: 'mcp_signin_resolved' }>, 'seq'>;

/**
 * What a turn observed: a session, where it ran, and the managed servers whose
 * connection was not healthy during it.
 */
export interface McpAuthEvidence {
  /** The session the turn ran in — where the card is drawn. */
  sessionId: string;
  /** That session's working directory, which is the agent's workspace. */
  cwd: string;
  /** The servers worth LOOKING at, by name. Never a verdict; see the module doc. */
  serverNames: string[];
}

/**
 * The port a runtime calls when a turn saw a managed server fail to connect.
 * Injected at boot so no runtime holds an opinion about OAuth, and absent in
 * tests that only care about turns.
 */
export type McpAuthEvidencePort = (evidence: McpAuthEvidence) => void;

/**
 * The servers in a turn's MCP status snapshot worth investigating — every one
 * that did not come up healthy.
 *
 * Deliberately coarse, and deliberately independent of anything the SDK words.
 * `failed` is what a bearer-carrying server reports when its token is refused,
 * and also what it reports when the host is down; `needs-auth` is the tokenless
 * refusal. Neither is trusted here, because neither can be: the reason is carried
 * in a prose `error` string and an `errorCode` the SDK does not surface at all
 * (both established empirically — see the module doc). Telling them apart is the
 * probe's job, so this only has to be a net wide enough to catch the real case.
 *
 * `pending` and `disabled` are excluded and are not near-misses: `pending` means
 * the snapshot was taken before that server finished connecting, and `disabled`
 * means nobody asked it to.
 *
 * @param servers - The runtime's per-turn status entries.
 */
export function mcpAuthEvidenceFrom(
  servers: ReadonlyArray<{ name: string; status?: string }>
): string[] {
  return servers
    .filter((server) => server.status === 'failed' || server.status === 'needs-auth')
    .map((server) => server.name);
}

/** The OAuth engine, narrowed to what a revocation needs. Satisfied by `AgentMcpOAuthService`. */
export interface McpRevocationOAuthPort {
  /** The live token DorkOS holds for a target, or `undefined` — "was this ever connected?". */
  getAccessToken(agentId: string, serverName: string, serverUrl: string): string | undefined;
  /** Run the target's refresh now, reporting why it ended the way it did. */
  refreshVerdict(target: McpOAuthTarget): Promise<McpCacheRefreshVerdict>;
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
  /**
   * The arbiter: dial the target with the credentials DorkOS holds RIGHT NOW,
   * exactly as a turn would. The same probe the settings panel's Test button
   * runs. Absent → nothing is ever condemned, which is the correct posture for a
   * process that cannot check.
   */
  probe?: McpTargetProbe;
  /** Diagnostic sink; defaults to `console`. */
  logger?: Pick<Logger, 'warn' | 'info'>;
  /**
   * Called once per reported server when its investigation settles, however it
   * settles — including the ones dismissed without one.
   *
   * A test seam, and a necessary one: this work is deliberately detached from the
   * turn that reported the evidence, so a caller has nothing to await and a test
   * would otherwise be reduced to guessing how many microtasks a probe takes.
   * Production omits it.
   */
  onSettled?: (serverName: string) => void;
}

/** The per-target key one investigation is serialized on. */
function targetKey(agentId: string, serverName: string): string {
  return `${agentId}\0${serverName}`;
}

/** A card this module drew, remembered so it can be retired if the target heals. */
interface DrawnCard {
  flowId: string;
  sessionId: string;
}

/**
 * Build the port that turns "this server did not come up" into a probe, and only
 * then — if the probe says the token is refused — into an evicted credential and
 * a sign-in card.
 *
 * The returned port is fire-and-forget: it is called from a runtime's own
 * per-turn bookkeeping, where a rejected promise would become an unhandled
 * rejection on a turn that has otherwise succeeded. Every way it can fail is a
 * log line.
 *
 * @param deps - The OAuth engine, the managed-server registry, the probe, and a
 *   log sink.
 */
export function createMcpRevocationWatch(deps: McpRevocationDeps): McpAuthEvidencePort {
  const logger = deps.logger ?? console;
  // One investigation per target at a time. Two turns in the same workspace can
  // report the same server within milliseconds of each other, and each would
  // otherwise probe and mint its own sign-in flow before the other's finished.
  const inFlight = new Set<string>();
  // The cards THIS module put on screen, so a target that turns out healthy can
  // have its card retired rather than left telling someone to sign in to a
  // server they are already signed in to.
  //
  // Note what this does and does not distinguish. It records the flow a card was
  // drawn ON, which on the two re-use paths is a flow the AGENT minted — so an
  // agent-initiated sign-in this module adopted CAN be settled here. That is
  // deliberate and safe: settling only ever happens after a probe has just
  // proved the server accepts the token DorkOS holds, which makes the link that
  // card offers moot no matter who minted it. What is never touched is a flow
  // this module never drew a card for.
  const drawn = new Map<string, DrawnCard>();

  const investigate = async (target: McpOAuthTarget, evidence: McpAuthEvidence): Promise<void> => {
    const { agentId, serverName, serverUrl } = target;
    const key = targetKey(agentId, serverName);
    const live = deps.oauth.liveSigninFor(agentId, serverName);

    if (!deps.oauth.getAccessToken(agentId, serverName, serverUrl)) {
      // DorkOS holds nothing for this server, so nothing of its is being refused.
      //
      // Usually that means it was never connected: its row already reads
      // needs-auth, the agent can offer a sign-in itself, and an unbidden card
      // would be noise. The exception is a sign-in ALREADY waiting — the person
      // is part-way through one (often the one a previous dead turn drew) and the
      // server is still failing. Then the card is re-drawn on the SAME flow,
      // which keeps a working link on screen instead of letting the projector's
      // grace age it out from under someone mid-browser.
      if (live) draw(evidence.sessionId, target, live, key);
      return;
    }

    // The arbiter. Everything above this line is a rumour; this dials the server
    // with the bearer a turn would send and asks it directly.
    const probed = await probeTarget(deps.probe, target, logger);
    if (!tokenWasRefused(probed)) {
      // Healthy, unreachable, or unprobeable — none of which is a dead credential.
      // If this module had put a card up on earlier evidence, retire it now.
      settleDrawnCard(key, 'connected');
      return;
    }

    // The server refused the token DorkOS holds. Try to replace it before
    // condemning it: a refused access token beside a live refresh token is as
    // often a blip as a revocation.
    const verdict = await deps.oauth.refreshVerdict(target);
    if (verdict === 'refreshed') {
      logger.info(`[mcp-revocation] refreshed ${serverName} after a refused token`);
      settleDrawnCard(key, 'connected');
      return;
    }
    if (verdict !== 'terminal') {
      // The attempt budget ran out on transport failures, or there was no cached
      // entry left to refresh. The access token is proven dead, so the cache is
      // already clear and the row tells the truth — but nothing here proves the
      // GRANT is gone, so the stored credential stays for a later refresh or a
      // restart's `warm` to recover, and nobody is asked to sign in again yet.
      logger.info(
        `[mcp-revocation] ${serverName} could not be refreshed right now — keeping the stored sign-in`
      );
      return;
    }

    // The OAuth server's own refusal. Clear the stored credential as well as the
    // cached one: a sign-in that could still find the dead token set on disk
    // would report the server "already connected" and hand the person no link.
    await deps.oauth.forgetServer(agentId, serverName);
    // A refusal proves the server is OAuth-protected, which is what makes the row
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
    draw(evidence.sessionId, target, signin, key);
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

  /** Put the sign-in card for a target on a session, and remember that we did. */
  const draw = (
    sessionId: string,
    target: McpOAuthTarget,
    signin: { flowId: string; authorizeUrl: string },
    key: string
  ): void => {
    const card: RawSigninRequired = {
      type: 'mcp_signin_required',
      agentId: target.agentId,
      serverName: target.serverName,
      flowId: signin.flowId,
      authorizeUrl: signin.authorizeUrl,
      disclosure: mcpOAuthCustodyDisclosure(target.serverName),
    };
    // Ingested into the projector rather than pushed onto a turn's event queue,
    // because the turn that produced the evidence may already be over by the time
    // the probe has answered. The projector carries a sign-in card past its own
    // turn and into later snapshots, so the card reaches a tab opened afterwards
    // too — and a session nobody is watching simply has no projector, which is a
    // quiet no-op rather than a failure.
    peekProjector(sessionId)?.ingest(card);
    drawn.set(key, { flowId: signin.flowId, sessionId });
  };

  /**
   * Retire a card THIS module drew, once the target turns out to be fine.
   *
   * A card that outlives its problem is worse than no card: it tells someone to
   * sign in to a server they are already signed in to. The reach is "a card we
   * put on screen", which includes an agent-minted flow we adopted — see the
   * {@link drawn} comment for why that is safe.
   */
  const settleDrawnCard = (key: string, outcome: 'connected' | 'failed'): void => {
    const card = drawn.get(key);
    if (!card) return;
    drawn.delete(key);
    const resolved: RawSigninResolved = {
      type: 'mcp_signin_resolved',
      flowId: card.flowId,
      outcome,
    };
    peekProjector(card.sessionId)?.ingest(resolved);
  };

  return (evidence) => {
    for (const serverName of new Set(evidence.serverNames)) {
      const target = deps.servers.oauthTargetForCwd(evidence.cwd, serverName);
      const key = target && targetKey(target.agentId, serverName);
      // Nothing DorkOS manages a sign-in for, or an investigation of this very
      // target already running — a second turn reporting the same server while
      // the first is still deciding what to do about it.
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

/** The readable half of an unknown throw. */
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
