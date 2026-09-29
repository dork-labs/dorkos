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
 * Phase 2 PR (a) declares the project and tracker-item seams. Each later phase
 * adds its own members here.
 *
 * @module extension-api/__fixtures__/seam-contract
 */

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
