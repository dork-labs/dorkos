/**
 * The extension-seam contract (spec `flow-multiproject` §10.5): the host types
 * the flow extension builds against, declared here exactly and types only.
 *
 * `@dorkos/extension-api` is not published, so flow mirrors these in its own
 * `lib/host-types.ts`. Core's `src/__tests__/seam-contract.test.ts` fails when
 * the real types stop matching these declarations in either direction; flow
 * vendors this file and runs the same check against its mirror, so a drift
 * fails in whichever repo moved. Bump `CONTRACT_VERSION` in the PR that
 * changes it: minor for an added member, major for a removal or a narrowing.
 *
 * Phase 2 PR (a) declared the project and tracker-item seams (1.0.0). PR (c)
 * added the client seams: pages, the status-bar slot, the tab marker, in-app
 * navigation and `currentProject` (1.1.0). PR (b) adds the inbox,
 * `requirePerson`, per-project settings and `requireLogin` (1.2.0). Each later
 * phase adds its own members here.
 *
 * @module extension-api/__fixtures__/seam-contract
 */
import type { ComponentType } from 'react';
import type { RequestHandler } from 'express';

/** A project as core knows it: a git main checkout. */
export interface ProjectRef {
  /** Absolute, canonical path of the main checkout. */
  readonly root: string;
  /** Short display name: URL-safe, unique, and stable once assigned. */
  readonly name: string;
}

/** One tracker item a chat is working on, newest first in lists. */
export interface TrackerItemRef {
  /** The tracker identifier. */
  readonly id: string;
  /** The flow stage, or null. */
  readonly stage: string | null;
  /** The run's own status, or null. */
  readonly runStatus: string | null;
  /** ISO-8601 time the run started. */
  readonly startedAt: string;
  /** How the chat relates to the item. */
  readonly via: 'this-chat' | 'own-chat';
  /** The chat the work runs in, or null. */
  readonly ownChatSessionId: string | null;
}

/** A known project, with what core learned about it. */
export interface ProjectInfo extends ProjectRef {
  /** "owner/name" from the origin remote, or null. */
  readonly originRepo: string | null;
  /** ISO-8601 time core last saw it. */
  readonly lastSeenAt: string;
}

/** Core's project registry, as one extension sees it (`ctx.projects`). */
export interface ProjectsApi {
  /** The project a folder belongs to. */
  resolve(cwd: string): Promise<ProjectRef | null>;
  /** Known projects that hold a copy of this extension or were reported by it. */
  list(): Promise<ProjectInfo[]>;
  /** Tell core about a project it may not have seen. */
  report(path: string): Promise<ProjectRef | null>;
  /** Called when the list changes. */
  onChange(listener: () => void): () => void;
}

/** The `DataProviderContext` members this contract covers. */
export interface DataProviderContextSeams {
  /** The projects core knows, scoped to this extension. */
  readonly projects: ProjectsApi;
  /** The inbox. */
  readonly inbox: InboxApi;
  /** Admits only a person. */
  readonly requirePerson: RequestHandler;
  /** Read-only per-project settings. */
  readonly projectSettings: ProjectSettingsReader;
}

/** The `SessionInfo` / `LimitedSessionInfo` members this contract covers. */
export interface SessionInfoSeams {
  /** Every tracker item the session works on, newest first. */
  trackerItems: { id: string; via: 'this-chat' | 'own-chat' }[];
  /** @deprecated The newest `this-chat` item. */
  trackerItem?: { id: string };
}

/**
 * How a person can answer an inbox decision (spec `flow-multiproject` §11.2).
 *
 * - `yes-no`: 👎 and 👍, each labelled as its outcome ("Send it back", "Ship
 *   it"). `rejectAsksForNote` opens a short note before 👎 sends.
 * - `word`: one small text button ("Sign in"). `href` opens an in-app path
 *   (a core route or `/x/<this extension id>/…`); `input` instead shows an
 *   inline text field whose text reaches `onAction`.
 * - `choice`: a question with 2 to 5 chips (labels ≤ 40), the agent's pick
 *   (`defaultChoice`) marked "agent's pick", an optional deadline
 *   (`decideBy`, which needs `defaultChoice`), and an optional "Reply…".
 */
export type DecisionActions =
  | { kind: 'yes-no'; approveLabel: string; rejectLabel: string; rejectAsksForNote?: boolean }
  | {
      kind: 'word';
      label: string;
      /** In-app path; core route or '/x/<this extension id>/…'. Ignored when `input` is set. */
      href?: string;
      /** Show an inline text field ("Answer"); its text reaches onAction. maxLength ≤ 2000. */
      input?: { placeholder: string; maxLength: number };
    }
  | {
      /** A question: chips, the agent's pick marked, and a deadline. */
      kind: 'choice';
      /** 2-5 choices; label ≤ 40. */
      choices: { id: string; label: string }[];
      /** The agent's pick, marked "agent's pick". Required when decideBy is set. */
      defaultChoice?: string;
      /**
       * ISO time; absent = no deadline line and no timer. Earlier than raise + 5
       * minutes (or past) is clamped to raise + 5 minutes; > 7 days throws.
       * At the deadline core calls onAction with defaultChoice, decidedBy 'deadline'.
       */
      decideBy?: string;
      /** Offer "Reply…" (free text reaches onAction as `text`). */
      allowReply?: boolean;
    };

/** An answer given on the extension's own page (`api.answerDecision`). */
export type DecisionAnswer =
  | { action: 'approve' }
  /** `note` ≤ 2000. */
  | { action: 'reject'; note?: string }
  /** `text` ≤ the action's `input.maxLength`. */
  | { action: 'word'; text?: string }
  /** A chip, or "Reply…" text (≤ 2000). */
  | { action: 'choice'; choiceId?: string; text?: string };

/** What `api.answerDecision` answers. */
export interface DecisionAnswerResult {
  /** Whether the answer settled it. */
  readonly resolved: boolean;
  /** Something to tell the person, or null. */
  readonly message: string | null;
  /**
   * The checked in-app path the extension answered with, or null. The host
   * follows it when it is a page this app serves.
   */
  readonly navigate: string | null;
  /** "Sorting 12 ideas… · Watch", when the handler returned one. */
  readonly watch: { sessionId: string; label: string } | null;
}

/** One open decision as the client sees it (scoped to the calling extension). */
export interface ExtensionDecisionView {
  /** Core's id for the row: what `answerDecision` takes. */
  readonly id: string;
  /** The extension's own key. */
  readonly key: string;
  /** A question or an outcome. */
  readonly title: string;
  /** What happens, why now, what "no" means. */
  readonly why: string;
  /** Shown behind ⓘ, or null. */
  readonly detail: string | null;
  /** The project it belongs to, or null. */
  readonly project: ProjectRef | null;
  /** The project heading's muted label, or null. */
  readonly projectLabel: string | null;
  /** When the condition began, or null. */
  readonly since: string | null;
  /** How to answer it. */
  readonly actions: DecisionActions;
  /** In-app path the title opens, or null. */
  readonly link: string | null;
  /** When it was first raised. */
  readonly raisedAt: string;
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

/** The UI slots an extension can probe with `isSlotAvailable`. */
export type ExtensionPointId =
  | 'sidebar.footer'
  | 'dashboard.sections'
  | 'command-palette.items'
  | 'dialog'
  | 'settings.tabs'
  | 'right-panel'
  | 'status-bar';

/** The `ExtensionReadableState` members this contract covers. */
export interface ExtensionReadableStateSeams {
  /** The project of `currentCwd`; null for no project or while resolving. */
  currentProject: ProjectRef | null;
  /** Whether Require login is on. */
  requireLogin: boolean;
}

/** Props every extension page receives. */
export interface ExtensionPageProps {
  /** Values of the page path's `:param` segments. */
  readonly params: Readonly<Record<string, string>>;
  /** The URL's query, flat. */
  readonly search: Readonly<Record<string, string>>;
  /** Replace query keys; null removes a key. Writes the URL. */
  setSearch(next: Record<string, string | null>): void;
}

/** How an extension page is named and listed. */
export interface ExtensionPageOptions {
  /** Title for the page bar, tab, palette and phone menu. */
  title: string;
  /** Icon, sized by the host with `className`. */
  icon?: ComponentType<{ className?: string }>;
  /** List it in the palette and the phone "Add-ons" menu. Default true. */
  menu?: boolean;
}

/** What a status-bar item is given, for the chat whose status bar it sits in. */
export interface StatusBarSlotContext {
  /** The chat's session id. */
  readonly sessionId: string;
  /** The chat's working folder, or null. */
  readonly cwd: string | null;
  /** The project of `cwd`, or null. */
  readonly project: ProjectRef | null;
  /** Every tracker item the chat works on, newest first. */
  readonly trackerItems: readonly TrackerItemRef[];
  /** True at phone width. */
  readonly compact: boolean;
}

/** How a status-bar item is named, ordered and shown. */
export interface StatusBarItemOptions {
  /** Accessible name of the item's region. */
  label: string;
  /** Order among extension items; lower first. Default 100. */
  priority?: number;
  /** Whether to show for this chat. Pure; reads only `ctx`. */
  when?(ctx: StatusBarSlotContext): boolean;
  /** Whether it needs attention. Pure; reads only `ctx`. */
  urgent?(ctx: StatusBarSlotContext): boolean;
}

/** The `ExtensionAPI` members this contract covers. */
export interface ExtensionAPISeams {
  /** Mount a full page at /x/<extensionId>/<path>. */
  registerPage(
    path: string,
    component: ComponentType<ExtensionPageProps>,
    options: ExtensionPageOptions
  ): () => void;
  /** Add an item to the chat status bar. */
  registerStatusBarItem(
    id: string,
    component: ComponentType<StatusBarSlotContext>,
    options: StatusBarItemOptions
  ): () => void;
  /** Mark one of this extension's right-panel tabs; null clears it. */
  setTabMarker(tabId: string, marker: 'attention' | null): void;
  /** Navigate in-app: core routes and this extension's own '/x/<id>/…' pages. */
  navigate(path: string): void;
  /** Whether a UI slot is rendered in the current host context. */
  isSlotAvailable(slot: ExtensionPointId): boolean;
  /** Answer one of this extension's decisions from its own page. */
  answerDecision(decisionId: string, answer: DecisionAnswer): Promise<DecisionAnswerResult>;
  /** This extension's open decisions. */
  listDecisions(): Promise<ExtensionDecisionView[]>;
  /** Per-project settings core holds for this extension. */
  readonly projectSettings: {
    /** The stored value for a project, or null. */
    get<T = unknown>(projectRoot: string): Promise<T | null>;
    /** The only writer; behind the person bar. */
    set(projectRoot: string, value: unknown): Promise<void>;
  };
}
