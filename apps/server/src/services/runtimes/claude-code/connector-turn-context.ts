/** Turn-scoped structural connector authority for Claude Code MCP tools. */
import { openOriginalNativeTurn } from '../../connectors/principal/runtime-principal-service.js';
import { type ServerPrincipalProof } from '../../connectors/principal/server-principal.js';
import {
  type OpenConnectorTurnResult,
  type RevokeConnectorTurnReason,
} from '../../connectors/runtime-principal-port.js';
import { type ConnectorRuntimeTools } from '../connector-tools.js';
import { logger } from '../../../lib/logger.js';
import {
  ConnectorTurnLeaseSupervisor,
  type ConnectorTurnLeaseSupervisorHandle,
} from '../connectors/connector-turn-lease-supervisor.js';

/** Inputs whose live values identify one Claude turn. */
export interface ClaudeConnectorTurnContextOptions {
  /** Server-owned binding lifecycle and exact capability predicate. */
  readonly tools: ConnectorRuntimeTools;
  /** Reads the SDK id after first-turn canonical rekey. */
  readonly canonicalSessionId: () => string;
  /** Canonical registered agent path. */
  readonly agentPath: string;
  /** Working directory bound to the turn. */
  readonly cwd: string;
  readonly nativeOperation?: object;
  readonly retireNative?: () => void;
}

/**
 * Lazily opens and resolves one Claude runtime principal.
 *
 * A persistent Claude process may host many DorkOS turns. This object belongs
 * to exactly one turn and is read through the mutable `AgentSession` at tool
 * call time, so a warm MCP server can never retain the prior turn's authority.
 */
const nativeClaudeResolvers = new WeakMap<object, () => Promise<ServerPrincipalProof>>();
/** Resolve only a constructor-owned Claude context through its original opening implementation. */
export function resolveOriginalClaudeConnectorPrincipal(
  context: object
): Promise<ServerPrincipalProof> {
  const resolve = nativeClaudeResolvers.get(context);
  if (!resolve) throw new Error('Original Claude connector context is unavailable.');
  return resolve();
}
const nativeClaudeContexts = new WeakMap<object, { signal: AbortSignal; active: boolean }>();
/** Fixed constructor-state read; this carries data, never a caller-issued currentness permit. */
export function readClaudeConnectorContext(context: object) {
  const state = nativeClaudeContexts.get(context);
  if (!state || !state.active) return undefined;
  return state.signal;
}
/** Own the Claude connector turn's principal and lease lifecycle. */
export class ClaudeConnectorTurnContext {
  private readonly controller = new AbortController();
  private opening: Promise<ServerPrincipalProof> | undefined;
  private binding: OpenConnectorTurnResult | undefined;
  private revocation: Promise<void> | undefined;
  #retirement: Promise<void> | undefined;
  private supervisor: ConnectorTurnLeaseSupervisorHandle | undefined;
  private active = true;
  #fixedOptions: ClaudeConnectorTurnContextOptions;
  #originalPrincipals: ClaudeConnectorTurnContextOptions['tools']['principals'];
  #retireNative: (() => void) | undefined;

  constructor(options: ClaudeConnectorTurnContextOptions) {
    const principals = options.tools.principals;
    const open = principals.openTurn,
      resolve = principals.resolve,
      revoke = principals.revoke,
      renew = principals.renew;
    const capability = options.tools.isConnectorCapabilityId;
    const supervisor = options.tools.createLeaseSupervisor;
    const canonicalSessionId = options.canonicalSessionId;
    this.#fixedOptions = Object.freeze({
      ...options,
      canonicalSessionId: () => Reflect.apply(canonicalSessionId, options, []),
      tools: Object.freeze({
        ...options.tools,
        principals: Object.freeze({
          ...principals,
          openTurn: (...args: Parameters<typeof open>): ReturnType<typeof open> =>
            Reflect.apply(open, principals, args),
          resolve: (...args: Parameters<typeof resolve>): ReturnType<typeof resolve> =>
            Reflect.apply(resolve, principals, args),
          revoke: (...args: Parameters<typeof revoke>): ReturnType<typeof revoke> =>
            Reflect.apply(revoke, principals, args),
          renew: (...args: Parameters<typeof renew>): ReturnType<typeof renew> =>
            Reflect.apply(renew, principals, args),
        }),
        isConnectorCapabilityId: (id: string) => Reflect.apply(capability, options.tools, [id]),
        ...(supervisor && {
          createLeaseSupervisor: (...args: Parameters<typeof supervisor>) =>
            Reflect.apply(supervisor, options.tools, args),
        }),
      }),
    });
    this.#originalPrincipals = principals;
    this.#retireNative = options.retireNative;
    nativeClaudeResolvers.set(this, () => this.#resolvePrincipal());
    nativeClaudeContexts.set(this, { signal: this.controller.signal, active: true });
  }

  /** Whether the broker's exact allowlist marks this as connector execution. */
  isConnectorCapabilityId(id: string): boolean {
    return this.#fixedOptions.tools.isConnectorCapabilityId(id);
  }

  /** Lazily open one binding and revalidate its authority on each capability call. */
  async resolvePrincipal(): Promise<ServerPrincipalProof> {
    return this.#resolvePrincipal();
  }

  async #resolvePrincipal(): Promise<ServerPrincipalProof> {
    this.#assertCurrent();
    this.supervisor?.assertUsable();
    this.opening ??= this.#openAndResolve();
    await this.opening;
    this.#assertCurrent();
    const binding = this.binding;
    if (!binding) throw new Error('Original Claude connector binding is unavailable.');
    this.#assertCurrent();
    const resolved = await this.#fixedOptions.tools.principals.resolve({
      bearer: binding.bearer,
      expectedRuntime: 'claude-code',
      expectedCanonicalCwd: this.#fixedOptions.cwd,
    });
    this.#assertCurrent();
    this.supervisor?.assertUsable();
    if (resolved.status === 'refused') {
      await this.revoke('setup_failed');
      throw new Error('Runtime tools are unavailable for this Claude turn.');
    }
    return resolved.principal;
  }

  #assertCurrent(): void {
    if (!this.active) throw new Error('Original Claude connector context is retired.');
    this.controller.signal.throwIfAborted();
  }

  /** Cancel pending setup and revoke an already-open binding immediately. */
  cancel(): Promise<void> {
    return this.revoke('turn_cancelled');
  }

  /** Whether interruption cancelled this turn. */
  get cancelled(): boolean {
    return this.controller.signal.aborted;
  }

  /**
   * Revoke the binding once, if this turn ever opened one.
   *
   * @param reason - Terminal state observed by the runtime generator.
   */
  revoke(reason: RevokeConnectorTurnReason): Promise<void> {
    if (this.#retirement) return this.#retirement;
    let resolve!: () => void, reject!: (cause: unknown) => void;
    // Install the one cleanup owner before observable retirement callbacks can reenter.
    this.#retirement = new Promise<void>((done, refused) => {
      resolve = done;
      reject = refused;
    });
    this.active = false;
    nativeClaudeContexts.get(this)!.active = false;
    let failed = false,
      firstCause: unknown;
    const remember = (cause: unknown) => {
      if (!failed) {
        failed = true;
        firstCause = cause;
      }
    };
    try {
      this.#retireNative?.();
    } catch (cause) {
      remember(cause);
    }
    try {
      this.supervisor?.stop();
    } catch (cause) {
      remember(cause);
    }
    try {
      if (reason === 'turn_cancelled') this.controller.abort();
    } catch (cause) {
      remember(cause);
    }
    void (async () => {
      // A failed opening remains the setup caller's cause, but cannot skip durable cleanup.
      try {
        await this.opening;
      } catch {
        /* Drain its actual settlement. */
      }
      try {
        await this.revokeBinding(reason);
      } catch (cause) {
        remember(cause);
      }
      if (failed) throw firstCause;
    })().then(resolve, reject);
    return this.#retirement;
  }

  async #openAndResolve(): Promise<ServerPrincipalProof> {
    const input = {
      runtime: 'claude-code' as const,
      canonicalSessionId: this.#fixedOptions.canonicalSessionId(),
      agentPath: this.#fixedOptions.agentPath,
      canonicalCwd: this.#fixedOptions.cwd,
      signal: this.controller.signal,
    };
    const binding = this.#fixedOptions.nativeOperation
      ? await openOriginalNativeTurn(
          this.#originalPrincipals,
          input,
          this.#fixedOptions.nativeOperation
        )
      : await this.#fixedOptions.tools.principals.openTurn(input, { isCurrent: () => this.active });
    this.binding = binding;
    if (this.controller.signal.aborted) {
      await this.revokeBinding('turn_cancelled');
      throw this.controller.signal.reason;
    }
    this.#assertCurrent();

    const resolved = await this.#fixedOptions.tools.principals.resolve({
      bearer: binding.bearer,
      expectedRuntime: 'claude-code',
      expectedCanonicalCwd: this.#fixedOptions.cwd,
    });
    if (resolved.status === 'refused') {
      await this.revokeBinding('setup_failed');
      throw new Error('Connector tools are unavailable for this Claude turn.');
    }
    this.#assertCurrent();
    const createSupervisor =
      this.#fixedOptions.tools.createLeaseSupervisor ??
      ((options) => new ConnectorTurnLeaseSupervisor(options));
    this.supervisor = createSupervisor({
      principals: this.#fixedOptions.tools.principals,
      bindingId: binding.bindingId,
      permit: binding.renewalPermit,
      runtime: 'claude-code',
      expiresAt: binding.expiresAt,
      signal: this.controller.signal,
      onLost: (loss) => logger.warn('[ClaudeCodeRuntime] Connections lease lost', loss),
    });
    return resolved.principal;
  }

  private async revokeBinding(reason: RevokeConnectorTurnReason): Promise<void> {
    if (!this.binding) return;
    this.revocation ??= Promise.resolve().then(() =>
      this.#fixedOptions.tools.principals.revoke(this.binding!.bindingId, reason)
    );
    await this.revocation;
  }
}

import {
  type InterruptOutcome,
  type InterruptReason,
  type InterruptReceipt,
} from '@dorkos/shared/types';
/**
 * Build one of this store's stop receipts.
 *
 * `runtime` is hardcoded rather than threaded from the facade because this store
 * IS the claude-code adapter's session state — it is reachable from no other
 * runtime, and `ClaudeCodeRuntime.type` is a fixed `'claude-code' as const` that
 * an injection would only be able to agree with.
 *
 * @param outcome - Which of the five endings the stop reached
 * @param reason - Why, when the outcome alone does not say it
 */
export function claudeInterruptReceipt(
  outcome: InterruptOutcome,
  reason?: InterruptReason
): InterruptReceipt {
  return { outcome, ...(reason ? { reason } : {}), runtime: 'claude-code' };
}
