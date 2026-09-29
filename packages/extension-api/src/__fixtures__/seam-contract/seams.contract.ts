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
 * adds the client seams: pages, the status-bar slot, the tab marker, in-app
 * navigation and `currentProject` (1.1.0). Each later phase adds its own
 * members here.
 *
 * @module extension-api/__fixtures__/seam-contract
 */
import type { ComponentType } from 'react';

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
}

/** The `SessionInfo` / `LimitedSessionInfo` members this contract covers. */
export interface SessionInfoSeams {
  /** Every tracker item the session works on, newest first. */
  trackerItems: { id: string; via: 'this-chat' | 'own-chat' }[];
  /** @deprecated The newest `this-chat` item. */
  trackerItem?: { id: string };
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
}
