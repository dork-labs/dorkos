/**
 * Server-side extension API types.
 *
 * Defines the contract for server-side extension entry points, including
 * the encrypted secret store, scoped storage, lifecycle hooks, read access to
 * the agent accounts DorkOS knows, and the account advisor seam.
 *
 * @module @dorkos/extension-api/server
 */
import type { AccountUsage as CoreAccountUsage } from '@dorkos/shared/account-usage';

/**
 * One account's usage as an extension sees it: identity, resolved color, the
 * readable windows and a single state. It is `AccountUsage` from
 * `@dorkos/shared/account-usage` without `path`: the account's config folder
 * stays on the server, and extensions name accounts by `runtime` and id.
 */
export type AccountUsage = Omit<CoreAccountUsage, 'path'>;

/** Encrypted per-extension secret store. */
export interface SecretStore {
  /** Get a secret value by key. Returns null if not set. */
  get(key: string): Promise<string | null>;
  /** Set a secret value. Writes through to disk immediately. */
  set(key: string, value: string): Promise<void>;
  /** Delete a secret. Writes through to disk immediately. */
  delete(key: string): Promise<void>;
  /** Check if a secret key is set (without decrypting). */
  has(key: string): Promise<boolean>;
}

/** Read/write access to non-secret extension configuration (plaintext JSON). */
export interface SettingsStore {
  /** Get a setting value by key. Returns null if not set. */
  get<T extends string | number | boolean = string | number | boolean>(
    key: string
  ): Promise<T | null>;
  /** Set a setting value. Writes through to disk immediately. */
  set(key: string, value: string | number | boolean): Promise<void>;
  /** Delete a setting value. Writes through to disk immediately. */
  delete(key: string): Promise<void>;
  /** Get all stored settings as a key-value record. */
  getAll(): Promise<Record<string, string | number | boolean>>;
}

/** One account an agent runtime can run on, as {@link AccountsApi.list} reports it. */
export interface AccountSummary {
  /** The runtime the account belongs to, such as `claude-code`, `codex` or `opencode`. */
  readonly runtime: string;
  /** The registry id, or `default` for the runtime's own implicit account. */
  readonly id: string;
  /** What the operator calls the account, or `null` when unnamed. */
  readonly label: string | null;
  /** The resolved display color (`#rrggbb`), never `null`. */
  readonly color: string;
  /** True for a runtime's implicit `default` account (it has no registry row). */
  readonly implicit: boolean;
}

/** One account the advisor is asked to rank, with its current usage. */
export interface AccountCandidate {
  /** The registry id, or `default` for the runtime's implicit account. */
  id: string;
  /** What the operator calls the account, or `null` when unnamed. */
  label: string | null;
  /** The resolved display color. */
  color: string;
  /** The account's usage as DorkOS last read it. */
  usage: AccountUsage;
}

/** What core is deciding when it asks the advisor to rank accounts. */
export interface AdvisorContext {
  /** `launch`: a new session names an account. `continue`: work moves off a limited account. */
  purpose: 'launch' | 'continue';
  /** Who is asking. Only `agent` and `relay` picks are refused on the advisor's word. */
  caller: 'person' | 'agent' | 'relay' | 'advisor';
  /** The working directory of the session being launched or continued. */
  cwd: string;
  /** The runtime the ranked accounts belong to. */
  runtime: string;
  /** The session being continued, when there is one. */
  sessionId?: string;
  /** An account to leave out, such as the one that just ran out. */
  excludeAccountId?: string;
}

/** The advisor's ordered answer to {@link AccountAdvisor.rank}. */
export interface AdvisorRanking {
  /**
   * Accounts in the order to offer them. An id left out is hidden. `runtime`
   * defaults to the context's runtime; another runtime's account is a
   * cross-runtime fallback. Ids DorkOS does not know are dropped.
   */
  accounts: {
    runtime?: string;
    id: string;
    eligible: boolean;
    reason: string;
    badge?: 'recommended' | 'reserved';
  }[];
  /** The account to suggest first, or `null` for none. */
  recommendedId: string | null;
}

/** A session core may move or park, as the advisor sees it. */
export interface SessionInfo {
  /** The session's id. */
  sessionId: string;
  /** Its working directory. */
  cwd: string;
  /** Its runtime. */
  runtime: string;
  /** The account it runs on, or `null` for an unregistered one. */
  accountId: string | null;
  /** The tracker item it serves, when one is known. */
  trackerItem?: { id: string };
}

/** A session that stopped because its account or model ran out of usage. */
export interface LimitedSessionInfo {
  /** The session's id. */
  sessionId: string;
  /** Its working directory. */
  cwd: string;
  /** The account that ran out, or `null` for an unregistered one. */
  accountId: string | null;
  /** The usage window that stopped the turn, such as `seven_day`. */
  window: string;
  /** When that window resets, or `null` when unknown. */
  resetsAt: string | null;
  /** `model` when only one model's bucket ran out; `account` otherwise. */
  scope: 'account' | 'model';
  /** The session's model, or `null` when unknown. */
  model: string | null;
  /** The tracker item it serves, when one is known. */
  trackerItem?: { id: string };
}

/**
 * What to do when a session runs out: move it to `target` after
 * `delaySeconds` (clamped to 0..3600), wait for the reset (and resume at
 * `resumeAt` when given), or ask the person.
 */
export type LimitedPlan =
  | { mode: 'auto'; target: string; delaySeconds: number }
  | { mode: 'wait'; resumeAt?: string }
  | { mode: 'ask' };

/** The background and first message a session continued on another account starts with. */
export interface CarryOverSeed {
  /** Background for the new session; refused when longer than the seed-context limit. */
  seedContext: string;
  /** The first message; core's default when absent. */
  prompt?: string;
}

/**
 * An extension's say in account decisions. One advisor at a time: registering
 * a second replaces the first. Every call is bounded at 2 seconds and every
 * answer is validated; a throw, a timeout or an invalid answer means core's
 * default, except when an agent or a relay message names an account, which is
 * then refused. A person's own pick is never refused because of the advisor.
 */
export interface AccountAdvisor {
  /** Order and filter the accounts a session may launch or continue on. */
  rank(
    candidates: AccountCandidate[],
    ctx: AdvisorContext
  ): AdvisorRanking | Promise<AdvisorRanking>;
  /** Choose what happens when a session runs out. Default: ask the person. */
  onLimited?(info: LimitedSessionInfo): LimitedPlan | Promise<LimitedPlan>;
  /** Offer another model when only one model's bucket ran out. */
  modelFallback?(
    info: LimitedSessionInfo
  ): { model: string } | null | Promise<{ model: string } | null>;
  /** Seed the new session when work moves to another account. */
  carryOver?(
    info: LimitedSessionInfo,
    targetAccountId: string
  ): CarryOverSeed | Promise<CarryOverSeed>;
  /** Whether this extension owns the session, so only it moves the session. */
  claims?(info: SessionInfo): boolean | Promise<boolean>;
  /**
   * A person asked to move a claimed session to another account. Resolving
   * within the 2 second bound means the extension ACCEPTED the move; core
   * then shows the session as handing off. The handoff itself may take much
   * longer (a minute or more): when it is done, report the new session with
   * {@link AccountsApi.markContinued}. A throw or timeout refuses the move.
   */
  move?(info: SessionInfo, target: { runtime: string; accountId: string }): void | Promise<void>;
  /**
   * A person cancelled a pending automatic handoff on a claimed session.
   * Resolving within the 2 second bound means it is cancelled and core asks the
   * person again; a throw or timeout refuses the cancel.
   */
  cancelAuto?(info: SessionInfo): void | Promise<void>;
  /** A person chose to wait for the reset on a claimed session. */
  wait?(info: SessionInfo, resumeAt: string | null, autoResume: boolean): void | Promise<void>;
}

/** Read access to the agent accounts DorkOS knows, and the advisor seam. */
export interface AccountsApi {
  /** Every runtime's accounts: registered rows, then each runtime's implicit `default`. */
  list(): Promise<AccountSummary[]>;
  /** Every account's current usage, or one runtime's when `runtime` is given. */
  usage(runtime?: string): Promise<AccountUsage[]>;
  /**
   * Listen for changes to what an account's usage shows. Removed automatically
   * when the extension shuts down or reloads.
   *
   * @returns A function that stops listening.
   */
  onUsage(listener: (usage: AccountUsage) => void): () => void;
  /**
   * Tell DorkOS this extension moved a session it claimed to a new session, so
   * the source session shows where its work went. This is how a move accepted
   * by {@link AccountAdvisor.move} (or an automatic handoff the extension ran
   * itself) finishes: call it once the new session exists. Core puts a handoff
   * back to asking the person if no report arrives within 10 minutes, and still
   * accepts a report that comes later.
   */
  markContinued(
    sourceSessionId: string,
    to: { sessionId: string; runtime: string; accountId: string }
  ): Promise<void>;
  /**
   * Become the account advisor. Replaces any advisor another extension
   * registered (with a warning in the server log). Unregistered automatically
   * when the extension shuts down or reloads.
   *
   * @returns A function that removes this advisor (and only this one).
   */
  registerAdvisor(advisor: AccountAdvisor): () => void;
}

/** Context injected into server-side extension code. */
export interface DataProviderContext {
  /** Encrypted per-extension secret store. */
  readonly secrets: SecretStore;
  /** Non-secret extension configuration store (plaintext JSON). */
  readonly settings: SettingsStore;
  /** Scoped persistent storage for extension data. */
  readonly storage: {
    loadData<T = unknown>(): Promise<T | null>;
    saveData<T = unknown>(data: T): Promise<void>;
  };
  /** Schedule a recurring function. Returns an unsubscribe/cancel function. */
  schedule(intervalSeconds: number, fn: () => Promise<void>): () => void;
  /** Emit an event to subscribed clients. */
  emit(event: string, data: unknown): void;
  /** This extension's ID from the manifest. */
  readonly extensionId: string;
  /** Absolute path to the extension's directory on disk. */
  readonly extensionDir: string;
  /**
   * The resolved DorkOS data directory (`~/.dork` by default), so an extension
   * can keep a file other tools also read, such as `<dorkHome>/flow/fleet.json`.
   */
  readonly dorkHome: string;
  /** The agent accounts DorkOS knows, their usage, and the account advisor seam. */
  readonly accounts: AccountsApi;
}

/** Server-side extension entry point signature. */
export type ServerExtensionRegister = (
  router: import('express').Router,
  ctx: DataProviderContext
) => void | (() => void) | Promise<void | (() => void)>;
