/**
 * In-memory registry of in-flight managed-MCP OAuth sign-in flows (DOR-942),
 * mirroring `OpenRouterOAuthStore` (`services/runtimes/opencode/providers/openrouter.ts`).
 *
 * A flow is minted by `mcp.signin` and consumed by the loopback callback, which
 * run on **separate requests**, so the PKCE verifier, the target
 * `(agentId, serverName, serverUrl)`, the authorize URL captured from the SDK,
 * and the pollable status all have to survive between them out-of-band from the
 * subprocess. They live here, keyed by the opaque OAuth `state`, and expire after
 * {@link FLOW_TTL_MS}. The verifier never leaves the server; the client only ever
 * sees the flow id (the `state`) and the terminal status.
 *
 * @module services/mesh/agent-mcp-oauth-flow-store
 */

/** How long a started sign-in flow stays claimable before it is pruned. */
const FLOW_TTL_MS = 10 * 60_000;

/** The terminal-or-pending status the client polls for. */
export type McpSigninStatus = 'pending' | 'connected' | 'failed';

/** The target a sign-in flow is bound to, plus its transient PKCE + status state. */
interface FlowEntry {
  /** The agent whose manifest owns the server being signed into. */
  agentId: string;
  /** The managed server's name (unique within the agent). */
  serverName: string;
  /** The MCP server URL the OAuth flow authorizes against. */
  serverUrl: string;
  /**
   * The PKCE code verifier, held server-side only. Nulled once the callback
   * claims it so a replayed callback cannot re-run the code→token exchange.
   */
  verifier: string | null;
  /** The authorize URL captured from the SDK's `redirectToAuthorization`, for `mcp.signin` to return. */
  authorizeUrl: string | null;
  status: McpSigninStatus;
  error?: string;
  createdAt: number;
  /**
   * The session this sign-in was asked for in, when it was asked for INSIDE one
   * (DOR-1004). It is what lets the callback bring that agent back the moment
   * the token lands. Absent for every sessionless start — the settings panel,
   * the external `/mcp` server, HTTP — where there is no conversation to resume
   * and nothing should be triggered.
   */
  originSessionId?: string;
  /**
   * The working directory that session runs in, captured at start (DOR-981).
   *
   * Recorded HERE rather than looked up at resume time because the thing that
   * knows it — the session's live projector — is exactly what a restart destroys,
   * and a sign-in routinely outlives one: a person can spend minutes in a browser.
   * Without it a cold resume fell back to the default directory and quietly did
   * nothing for every session rooted anywhere else.
   */
  originCwd?: string;
}

/** A started flow's public handle: what `mcp.signin` needs to hand back. */
export interface StartedFlow {
  /** The flow id (opaque OAuth `state`) the client polls with. */
  flowId: string;
  /** The bound target. */
  agentId: string;
  serverName: string;
  serverUrl: string;
  /** The session to resume when this connects, when one asked for it (DOR-1004). */
  originSessionId?: string;
  /** The directory that session runs in, so a cold resume runs in the right place (DOR-981). */
  originCwd?: string;
}

/** Project a stored entry onto the public handle both lookups hand back. */
function toStartedFlow(state: string, flow: FlowEntry): StartedFlow {
  return {
    flowId: state,
    agentId: flow.agentId,
    serverName: flow.serverName,
    serverUrl: flow.serverUrl,
    ...(flow.originSessionId ? { originSessionId: flow.originSessionId } : {}),
    ...(flow.originCwd ? { originCwd: flow.originCwd } : {}),
  };
}

/**
 * The mutable, in-memory store of sign-in flows. One instance is shared by the
 * `mcp.signin`/`mcp.poll_signin` capabilities and the loopback callback route.
 */
export class McpOAuthFlowStore {
  private readonly flows = new Map<string, FlowEntry>();
  private readonly now: () => number;

  /**
   * Construct an empty flow store.
   *
   * @param now - Epoch-ms clock (defaults to `Date.now`); injected for tests.
   */
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /**
   * Register a new pending flow bound to a target, keyed by the caller-minted
   * `state`. The verifier and authorize URL are filled in by the SDK provider
   * during `auth()`.
   *
   * @param state - The opaque OAuth state that becomes the flow id.
   * @param target - The agent, server, and server URL the flow authorizes, plus
   *   the session that asked for it when one did (DOR-1004) and the directory
   *   that session runs in (DOR-981).
   */
  start(
    state: string,
    target: {
      agentId: string;
      serverName: string;
      serverUrl: string;
      originSessionId?: string;
      originCwd?: string;
    }
  ): void {
    this.prune();
    this.flows.set(state, {
      agentId: target.agentId,
      serverName: target.serverName,
      serverUrl: target.serverUrl,
      verifier: null,
      authorizeUrl: null,
      status: 'pending',
      createdAt: this.now(),
      ...(target.originSessionId ? { originSessionId: target.originSessionId } : {}),
      ...(target.originCwd ? { originCwd: target.originCwd } : {}),
    });
  }

  /** The bound target for a live flow, or `undefined` when unknown/expired. */
  target(state: string): StartedFlow | undefined {
    this.prune();
    const flow = this.flows.get(state);
    if (!flow) return undefined;
    return toStartedFlow(state, flow);
  }

  /**
   * The live, still-clickable sign-in for a target, or `undefined` (DOR-981).
   *
   * "Live" is deliberately narrow: still `pending`, and already carrying an
   * authorize URL. A flow that has not reached its URL yet has nothing to show
   * anyone, and a settled one is history. This is what stops a burst of refusals
   * from one server minting a flow apiece — the second refusal finds the first
   * flow's link and re-uses it, so the person sees ONE card with ONE working
   * button.
   *
   * @param agentId - The owning agent's id.
   * @param serverName - The managed server's name.
   */
  liveFor(
    agentId: string,
    serverName: string
  ): (StartedFlow & { authorizeUrl: string }) | undefined {
    this.prune();
    for (const [state, flow] of this.flows) {
      if (flow.agentId !== agentId || flow.serverName !== serverName) continue;
      if (flow.status !== 'pending' || !flow.authorizeUrl) continue;
      return { ...toStartedFlow(state, flow), authorizeUrl: flow.authorizeUrl };
    }
    return undefined;
  }

  /** Record the PKCE verifier the SDK generated for this flow. */
  setVerifier(state: string, verifier: string): void {
    const flow = this.flows.get(state);
    if (flow) flow.verifier = verifier;
  }

  /**
   * Claim the verifier for a live flow, or `null` when unknown/expired/already
   * claimed. One-shot: nulled on first claim so a replayed callback cannot
   * re-exchange the code. The entry itself survives (with its status) for the poll.
   */
  claimVerifier(state: string): string | null {
    this.prune();
    const flow = this.flows.get(state);
    if (!flow || flow.verifier === null) return null;
    const { verifier } = flow;
    flow.verifier = null;
    return verifier;
  }

  /**
   * Forget a live flow's PKCE verifier without touching its status — what the
   * SDK asks for when it invalidates credentials mid-`auth()` so the retry mints
   * a fresh verifier instead of reusing a spent one.
   */
  clearVerifier(state: string): void {
    const flow = this.flows.get(state);
    if (flow) flow.verifier = null;
  }

  /** Record the authorize URL the SDK asked us to redirect to. */
  setAuthorizeUrl(state: string, url: string): void {
    const flow = this.flows.get(state);
    if (flow) flow.authorizeUrl = url;
  }

  /** The authorize URL captured for a flow, or `undefined` when unset/unknown. */
  authorizeUrl(state: string): string | undefined {
    return this.flows.get(state)?.authorizeUrl ?? undefined;
  }

  /**
   * Forget a flow entirely. Used when a sign-in never got off the ground: no
   * link was handed out, so nothing can legitimately poll it — and leaving the
   * `state` claimable would let a stray callback carrying it complete a sign-in
   * the operator was never shown.
   *
   * @param state - The flow id to forget.
   */
  drop(state: string): void {
    this.flows.delete(state);
  }

  /**
   * Forget every flow bound to one target, live or settled (DOR-982).
   *
   * Used when the OAuth client identity a target signs in as is replaced: every
   * authorize URL already handed out names the OLD client, so leaving them
   * claimable means the operator can click a link that is guaranteed to fail —
   * or, worse, that a callback still carrying the old `state` completes against
   * the new identity.
   *
   * @param agentId - The owning agent's id.
   * @param serverName - The managed server's name.
   */
  dropFor(agentId: string, serverName: string): void {
    for (const [state, flow] of this.flows) {
      if (flow.agentId === agentId && flow.serverName === serverName) this.flows.delete(state);
    }
  }

  /** Mark a flow connected (the callback stored a token). */
  markConnected(state: string): void {
    const flow = this.flows.get(state);
    if (flow) flow.status = 'connected';
  }

  /** Mark a flow failed with an honest, secret-free message. */
  markFailed(state: string, error: string): void {
    const flow = this.flows.get(state);
    if (flow) {
      flow.status = 'failed';
      flow.error = error;
    }
  }

  /** The pollable status of a flow; an unknown/expired id reads as a failed, honest error. */
  status(state: string): { status: McpSigninStatus; error?: string } {
    this.prune();
    const flow = this.flows.get(state);
    if (!flow) return { status: 'failed', error: 'This sign-in link expired. Please start again.' };
    return flow.error ? { status: flow.status, error: flow.error } : { status: flow.status };
  }

  private prune(): void {
    const cutoff = this.now() - FLOW_TTL_MS;
    for (const [state, flow] of this.flows) {
      if (flow.createdAt < cutoff) this.flows.delete(state);
    }
  }
}
