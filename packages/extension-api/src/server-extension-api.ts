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
import type { DecisionActions, ProjectRef } from './extension-api.js';
import type { StartWorkInput } from './start-work.js';

export type { DecisionActions, ProjectRef } from './extension-api.js';
export type { StartWorkInput } from './start-work.js';
export { StartWorkError } from './start-work.js';

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
  /**
   * The tracker item it serves, when one is known.
   *
   * @deprecated The newest `this-chat` item of `trackerItems`; removed per spec `flow-multiproject` §6.8's condition.
   */
  trackerItem?: { id: string };
  /** Every tracker item it works on, newest first; `own-chat` items run in chats it started. */
  trackerItems: { id: string; via: 'this-chat' | 'own-chat' }[];
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
  /**
   * The tracker item it serves, when one is known.
   *
   * @deprecated The newest `this-chat` item of `trackerItems`; removed per spec `flow-multiproject` §6.8's condition.
   */
  trackerItem?: { id: string };
  /** Every tracker item it works on, newest first; `own-chat` items run in chats it started. */
  trackerItems: { id: string; via: 'this-chat' | 'own-chat' }[];
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
  /**
   * The projects (git main checkouts) core knows, scoped to this extension.
   * Probe with `ctx.projects !== undefined` to run on hosts from before it.
   */
  readonly projects: ProjectsApi;
  /**
   * Ask a person something in the Activity inbox, and hear their answer
   * (spec `flow-multiproject` §7). Probe with `ctx.inbox !== undefined`.
   */
  readonly inbox: InboxApi;
  /**
   * Express middleware that admits only a person (the same bar as approving an
   * extension, including its login-off residual: with Require login off, a
   * local caller that does not name itself an agent passes, and in any posture
   * this extension's own page code passes). Put it in front of every route
   * that changes state on a person's behalf:
   * `router.put('/settings', ctx.requirePerson, handler)`.
   */
  readonly requirePerson: import('express').RequestHandler;
  /**
   * Read-only view of the per-project settings a person writes through
   * `api.projectSettings.set` (§7.10). No setter exists here, so neither this
   * server half nor any agent it runs can change them.
   */
  readonly projectSettings: ProjectSettingsReader;
  /**
   * Start work in a new chat, decided by this extension's own rules (spec
   * §7.7). Probe with `ctx.sessions !== undefined`.
   */
  readonly sessions: SessionsApi;
}

/** `ctx.sessions`: starting work in a new chat without a person (spec §7.7). */
export interface SessionsApi {
  /**
   * Start work in a new chat in a project, decided by the extension's own rules
   * (no person needed). Same input, limits, eligibility and StartWorkError as
   * the client's api.startWork. The project must hold a copy of this extension
   * or have been reported by it. Limits are restart-safe and include chats
   * started from its started chats. Records startedBy { kind: 'extension' }.
   * Eligibility refusals begin with phase 3.
   */
  start(input: StartWorkInput): Promise<{ sessionId: string }>;
}

/** The server half's read-only view of its per-project settings. */
export interface ProjectSettingsReader {
  /** The stored value for a project (any folder inside it), or null. */
  get<T = unknown>(projectRoot: string): Promise<T | null>;
  /** Called with the project root whenever a person changes that project's value. */
  onChange(listener: (projectRoot: string) => void): () => void;
}

/** What `ctx.inbox.raise` takes. */
export interface DecisionInput {
  /** Extension-local; core namespaces it. /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/ */
  key: string;
  /** A question or an outcome, never a command or id (V8). ≤ 120 chars, plain text. */
  title: string;
  /**
   * REQUIRED. What happens, why now, what a "no" means (V8). Plain text,
   * 1-300 chars. raise() throws InboxLimitError('why') without it.
   */
  why: string;
  /** ≤ 500 chars, plain text; shown behind ⓘ. */
  detail?: string;
  /** Any path inside the project; core resolves it. */
  project?: string;
  /** Muted right-hand label of the project heading, e.g. "Linear DOR". */
  projectLabel?: string;
  /** ISO time the condition began ("since 09:14 · asked after 1h"). */
  since?: string;
  /** How a person answers it. */
  actions: DecisionActions;
  /** In-app path the row's title opens, e.g. "/x/flow/p/dorkos". Core route or '/x/<this extension id>/…' only. */
  link?: string;
}

/** One decision as core stored it. */
export interface RaisedDecision {
  /** Core's id for the row (what `answerDecision` takes). */
  readonly id: string;
  /** The extension's own key. */
  readonly key: string;
  /** A question or an outcome. */
  readonly title: string;
  /** The second line. */
  readonly why: string;
  /** Shown behind ⓘ, or null. */
  readonly detail: string | null;
  /** The project core resolved, or null. */
  readonly project: ProjectRef | null;
  /** The project heading's muted label, or null. */
  readonly projectLabel: string | null;
  /** When the condition began, or null. */
  readonly since: string | null;
  /** How a person answers it (a `decideBy` already clamped). */
  readonly actions: DecisionActions;
  /** In-app path the title opens, or null. */
  readonly link: string | null;
  /** When it was first raised. */
  readonly raisedAt: string;
  /** When it was last raised or changed. */
  readonly updatedAt: string;
}

/** `cleared` = resolved on its own; `cancelled` = no longer needed. */
export type DecisionOutcome = 'approved' | 'rejected' | 'answered' | 'cleared' | 'cancelled';

/** Who settled a decision, when it was not a person. */
export type DecisionActor =
  | {
      kind: 'agent' | 'rule';
      /** In words, ≤ 60: "the reviewer agent", "your 'Tell me after' setting". */
      label: string;
    }
  /** The agent's default applied at a deadline; core words it "decided by the agent at <time>". */
  | { kind: 'deadline' };

/** What the `onAction` handler is told. */
export interface DecisionActionEvent {
  /** The decision's key. */
  readonly key: string;
  /** 'offer' is the second call when a person said Yes to a follow-up offer. */
  readonly action: 'approve' | 'reject' | 'word' | 'choice' | 'offer';
  /** The chosen chip, for 'choice'. */
  readonly choiceId: string | null;
  /** 'person', or 'deadline' when core applied defaultChoice at decideBy. */
  readonly decidedBy: 'person' | 'deadline';
  /** The offer being accepted, for 'offer'. */
  readonly offerId: string | null;
  /**
   * Set when a person answered in core's UI: pass it back as
   * resolve(key, { answering }) after a keepOpen, so history credits the person.
   */
  readonly pendingActionId: string | null;
  /** The "Needs changes" note (≤ 2000), when the reject asked for one. */
  readonly note: string | null;
  /** The typed answer (word `input`, or a choice's "Reply…"). */
  readonly text: string | null;
  /** The decision's project, or null. */
  readonly project: ProjectRef | null;
}

/** "Sorting 12 ideas… · Watch": a chat this extension started, drawn on the row. label ≤ 40. */
export interface DecisionWatch {
  /** The chat's session id. */
  sessionId: string;
  /** What it is doing, ≤ 40: "Sorting 12 ideas…". */
  label: string;
}

/**
 * What the `onAction` handler answers.
 *
 * `navigate` must pass the same rule as `link`, else the answer is treated as
 * a handler error. `offer` is honoured only for an answer attributed to a
 * person; for 'offer' calls only `message` is read. At a deadline, `keepOpen`
 * is honoured: the timer stops, nothing retries, the row stays open.
 */
export type DecisionActionResult =
  | {
      resolve: 'approved' | 'rejected' | 'answered';
      navigate?: string;
      offer?: DecisionOffer;
      message?: string;
      watch?: DecisionWatch;
    }
  | { keepOpen: true; message?: string; navigate?: string; watch?: DecisionWatch }
  /** "Already settled" (by this extension, or moot). Valid at a deadline; core cancels the timer and does nothing else. */
  | { settled: true };

/** V9: a one-time "do this on its own next time" line under the answered row. */
export interface DecisionOffer {
  /** Plain text, ≤ 160: "Shipped. Next time, ship on its own when the reviewer agent approves?" */
  text: string;
  /** ≤ 64; comes back as DecisionActionEvent.offerId when the person says Yes. */
  offerId: string;
  /**
   * Applied by core on the person's Yes, before the 'offer' handler call: a
   * shallow merge into this extension's per-project settings (§7.10), attributed
   * to the person, validated like api.projectSettings.set.
   */
  settingsPatch?: { project: string; patch: Record<string, unknown> };
}

/** Which limit an {@link InboxLimitError} names. */
export type InboxLimit =
  'why' | 'title' | 'detail' | 'open' | 'key' | 'choices' | 'decideBy' | 'rate';

/**
 * Thrown by `raise`/`record` when a limit is broken: missing or long why,
 * title > 120, detail > 500, > 50 open, a bad key, a bad choice set or
 * decideBy, or more than 60 new decisions (raised or recorded) in an hour
 * (`rate`). Nothing is written. Match on `err.code === 'inbox_limit'` rather
 * than `instanceof`: an extension bundle carries its own copy of this class.
 */
export class InboxLimitError extends Error {
  /** Always `inbox_limit`. */
  readonly code = 'inbox_limit' as const;
  /** Which limit was broken. */
  readonly limit: InboxLimit;

  /**
   * Refuse a decision that broke a limit.
   *
   * @param limit - Which limit was broken.
   * @param message - What was wrong, in plain words.
   */
  constructor(limit: InboxLimit, message: string) {
    super(message);
    this.name = 'InboxLimitError';
    this.limit = limit;
  }
}

/**
 * Thrown by `raise` when `link` or a word action's `href` is not an allowed
 * in-app path. Nothing is written. Match on `err.code === 'inbox_link'`.
 */
export class InboxLinkError extends Error {
  /** Always `inbox_link`. */
  readonly code = 'inbox_link' as const;

  /**
   * Refuse a link.
   *
   * @param message - Which link was refused, and why.
   */
  constructor(message: string) {
    super(message);
    this.name = 'InboxLinkError';
  }
}

/** What `ctx.inbox.record` takes: a decision made without asking. */
export type RecordedDecisionInput = Omit<DecisionInput, 'actions' | 'since'> & {
  outcome: 'approved' | 'rejected' | 'answered';
  by: DecisionActor;
  /** true ("Tell me after"): unread in Activity until seen. false/absent ("Just do it"): quiet, already read. */
  tell?: boolean;
  /** What was chosen, in words (≤ 40), e.g. "Shipped". */
  choiceLabel?: string;
};

/** Core's inbox, as one extension sees it (`ctx.inbox`). */
export interface InboxApi {
  /** Raise, or update in place, the one open decision for `key`. Max 50 open per extension. */
  raise(input: DecisionInput): Promise<RaisedDecision>;
  /**
   * Settle it; `cleared` = "resolved on its own". `by` says an agent or rule of
   * the person's decided (history shows its label). False when nothing was open.
   */
  resolve(
    key: string,
    opts: {
      outcome: DecisionOutcome;
      by?: DecisionActor;
      /** A pendingActionId from a person's answer that got keepOpen: credits that person. */
      answering?: string;
      /** Only with a valid `answering`: the one-time V9 follow-up for that person. */
      offer?: DecisionOffer;
      watch?: DecisionWatch;
    }
  ): Promise<boolean>;
  /**
   * Write a history-only row for something decided without asking ("While you
   * were away"): never in "Needs you", never a push. `why` and `by` are required.
   */
  record(input: RecordedDecisionInput): Promise<void>;
  /** This extension's open decisions. */
  list(): Promise<RaisedDecision[]>;
  /** The one handler for a person's answer; bounded at 5s. A second call replaces the first. */
  onAction(
    handler: (event: DecisionActionEvent) => DecisionActionResult | Promise<DecisionActionResult>
  ): () => void;
}

/** A known project, with what core learned about it. */
export interface ProjectInfo extends ProjectRef {
  /** "owner/name" from the origin remote, or null. */
  readonly originRepo: string | null;
  /** ISO-8601 time core last saw a session, agent, workspace or install in it. */
  readonly lastSeenAt: string;
}

/** Core's project registry, as one extension sees it (`ctx.projects`). */
export interface ProjectsApi {
  /** The project a folder belongs to (worktrees and subfolders map to their main checkout). */
  resolve(cwd: string): Promise<ProjectRef | null>;
  /**
   * Known projects whose folder exists and that either hold a copy of this
   * extension or were reported by it, by name.
   */
  list(): Promise<ProjectInfo[]>;
  /**
   * Tell core about a project it may not have seen. Boundary-checked; must be
   * inside a git repo, else null. Reported-only roots are never scanned for
   * extensions. Carries no label.
   */
  report(path: string): Promise<ProjectRef | null>;
  /** Called when the list changes. */
  onChange(listener: () => void): () => void;
}

/** Server-side extension entry point signature. */
export type ServerExtensionRegister = (
  router: import('express').Router,
  ctx: DataProviderContext
) => void | (() => void) | Promise<void | (() => void)>;
