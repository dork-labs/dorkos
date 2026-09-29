import type { ComponentType } from 'react';
import type { UiCommand, UiCanvasContent } from '@dorkos/shared/types';
import type { ExtensionEventsAPI } from './extension-events.js';

/**
 * Slot identifiers matching the Phase 2 registry.
 *
 * `dashboard.sections` keeps its id but no longer renders on the dashboard
 * page: contributions appear in a "From your extensions" group at the top of
 * the Activity tab, in priority order. Nothing about registration changed. A
 * room-widget successor is deferred to a later phase.
 */
export type ExtensionPointId =
  | 'sidebar.footer'
  | 'dashboard.sections'
  | 'command-palette.items'
  | 'dialog'
  | 'settings.tabs'
  | 'right-panel';

/** A project as core knows it: a git main checkout. */
export interface ProjectRef {
  /** Absolute, canonical path of the main checkout. */
  readonly root: string;
  /**
   * Short display name: URL-safe, unique among known projects, and stable once
   * assigned (basename, or "basename~parent" on a clash). Safe in URLs as-is.
   */
  readonly name: string;
}

/** One tracker item a chat is working on, newest first in lists. */
export interface TrackerItemRef {
  /** The tracker identifier, e.g. `DOR-2387`. */
  readonly id: string;
  /** The flow stage the run is in, or null when it reports none. */
  readonly stage: string | null;
  /** The run's own status, or null when it reports none. */
  readonly runStatus: string | null;
  /** ISO-8601 time the run started. */
  readonly startedAt: string;
  /** 'this-chat': this chat works on it. 'own-chat': this chat started it and it runs in its own chat. */
  readonly via: 'this-chat' | 'own-chat';
  /** That chat's session id: the "Open its chat" target. Null for 'this-chat', or when it is not a DorkOS chat. */
  readonly ownChatSessionId: string | null;
}

/** Read-only projection of host state. */
export interface ExtensionReadableState {
  currentCwd: string | null;
  activeSessionId: string | null;
  agentId: string | null;
  /**
   * Whether Require login is on (`auth.enabled`). When false, anyone on this
   * computer can pass the person bar, so a setting only a person should change
   * (an autonomy dial) should say so: "Anyone on this computer can change this.
   * Turn on Require login so only you can." Probe with `'requireLogin' in
   * api.getState()` to run on hosts from before it.
   */
  requireLogin: boolean;
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
  /** A validated in-app path the host already navigated to, or null. */
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

/** The contract extensions receive on activation. */
export interface ExtensionAPI {
  /** This extension's ID from the manifest. */
  readonly id: string;

  // --- UI Contributions (wraps Phase 2 registry) ---

  /**
   * Register a React component in a UI slot.
   * Returns an unsubscribe function (auto-called on deactivate).
   *
   * @param slot - The UI slot to contribute to.
   * @param id - Slot-local id; the host namespaces it as `${extId}:${id}`.
   * @param component - The React component to render.
   * @param options - `priority` orders the contribution (lower = earlier).
   *   `label` is the human name shown where the slot has a label or tab (e.g.
   *   the right-panel tab strip); it defaults to the namespaced id when omitted,
   *   so set it for any tabbed or labelled slot. `icon` is the tab-strip icon for
   *   slots that render one (currently `right-panel`); it is any component the
   *   host renders with a `className` for sizing — a `lucide-react` icon
   *   satisfies this. Omit it and the host falls back to a default puzzle-piece.
   *   `group` applies only to the `settings.tabs` slot: it names the sidebar
   *   section the tab sits under in the Settings dialog. Omit it and the tab
   *   lands under "Add-ons", the section reserved for contributed tabs — so a
   *   tab written before this field existed still files itself somewhere honest.
   *   `visibleWhen` applies only to the `dashboard.sections` slot: a predicate
   *   the host re-evaluates on render, returning false to hide the section
   *   without unregistering it. Omit it and the section is always visible.
   */
  registerComponent(
    slot: ExtensionPointId,
    id: string,
    component: ComponentType,
    options?: {
      priority?: number;
      label?: string;
      icon?: ComponentType<{ className?: string }>;
      group?: string;
      visibleWhen?: () => boolean;
    }
  ): () => void;

  /**
   * Register a command palette item.
   * Returns an unsubscribe function.
   */
  registerCommand(
    id: string,
    label: string,
    callback: () => void,
    options?: { icon?: string; shortcut?: string }
  ): () => void;

  /**
   * Register a dialog component.
   * Returns an object with open/close controls.
   */
  registerDialog(id: string, component: ComponentType): { open: () => void; close: () => void };

  /**
   * Register a tab in the settings dialog.
   * Returns an unsubscribe function.
   *
   * @param options - `group` names the sidebar section the tab sits under. Omit
   *   it and the tab lands under "Add-ons", the section reserved for contributed
   *   tabs.
   */
  registerSettingsTab(
    id: string,
    label: string,
    component: ComponentType,
    options?: { group?: string }
  ): () => void;

  // --- UI Control (wraps Phase 1 dispatcher) ---

  /** Execute a UI command (open panel, show toast, etc.). */
  executeCommand(command: UiCommand): void;

  /** Open the canvas with the given content. */
  openCanvas(content: UiCanvasContent): void;

  /** Navigate to a client-side route. */
  navigate(path: string): void;

  // --- State ---

  /** Get a read-only snapshot of host state. */
  getState(): ExtensionReadableState;

  /**
   * Subscribe to state changes. The selector picks a value; the callback
   * fires when that value changes. Returns an unsubscribe function.
   */
  subscribe(
    selector: (state: ExtensionReadableState) => unknown,
    callback: (value: unknown) => void
  ): () => void;

  // --- Events (curated, privacy-safe push channel) ---

  /**
   * Subscribe to curated host events (session/turn/tool lifecycle, relay
   * notifications). This is NOT the raw session stream — every event is a
   * privacy-safe summary that carries no conversation content (see
   * {@link ExtensionEventsAPI} and the `extension-events` module). Access is
   * gated by the manifest's `capabilities.events` declaration.
   */
  readonly events: ExtensionEventsAPI;

  // --- Storage (scoped to this extension) ---

  /** Load persistent data for this extension. Returns null if no data saved. */
  loadData<T>(): Promise<T | null>;

  /** Save persistent data for this extension. */
  saveData<T>(data: T): Promise<void>;

  // --- Notifications ---

  /** Show a toast notification. */
  notify(message: string, options?: { type?: 'info' | 'success' | 'error' }): void;

  // --- Context ---

  /** Check if a UI slot is rendered in the current host context. */
  isSlotAvailable(slot: ExtensionPointId): boolean;

  // --- Inbox decisions (spec `flow-multiproject` §7) ---

  /**
   * Answer one of THIS extension's inbox decisions from its own page. Scoped
   * server-side to this extension's id (another extension's row is 404).
   * Attributed to the extension ("answered in Flow"), never to a person, and
   * never returns an offer. Behind the person bar, with its residuals. A
   * validated `navigate` in the result has already been followed.
   */
  answerDecision(decisionId: string, answer: DecisionAnswer): Promise<DecisionAnswerResult>;

  /** This extension's open decisions (scoped to its id), as the inbox shows them. */
  listDecisions(): Promise<ExtensionDecisionView[]>;

  /**
   * Per-project settings core holds for this extension (spec §7.10): the home
   * of anything only a person should change, such as an autonomy dial. The
   * extension's server half can read them (`ctx.projectSettings`) and can
   * never write them.
   */
  readonly projectSettings: {
    /** The stored value for a project (any folder inside it), or null. */
    get<T = unknown>(projectRoot: string): Promise<T | null>;
    /** The only writer; behind the person bar. Value is JSON, ≤ 16 KiB. */
    set(projectRoot: string, value: unknown): Promise<void>;
  };
}
