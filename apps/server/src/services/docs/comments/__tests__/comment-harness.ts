/**
 * A doc comment service over a real migrated database and the real room
 * author registry, with Mesh, the dispatcher and notifications faked: what the
 * trust, loop-guard and notification tests drive.
 */
import { vi } from 'vitest';
import type { MeshCore } from '@dorkos/mesh';
import type { TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import { createTestDb } from '@dorkos/test-utils/db';
import { AuthorRegistry } from '../../../rooms/author-registry.js';
import type { RoomAgent } from '../../../rooms/room-errors.js';
import type {
  DispatchSessionMessageOpts,
  DispatchSessionMessageResult,
} from '../../../session/launch/launch-session.js';
import type { DispatchLifecycleEvent } from '../../../session/message-dispatcher.js';
import type { DocCommentNotifyInput } from '../../../notifications/emitters/doc-comments.js';
import { CommentDirectory } from '../comment-directory.js';
import { DocCommentService } from '../comment-service.js';
import { DocCommentStore } from '../comment-store.js';
import { CommentWaker, type CommentWakeLimits } from '../comment-wake.js';
import type { DocLocation } from '../doc-location.js';

/** One agent the fake Mesh knows. */
export interface HarnessAgent {
  id: string;
  name: string;
  path: string;
}

/** The doc every test writes on. */
export const DOC: DocLocation = {
  space: { root: '/work/project', key: 'space-key' },
  path: 'notes/plan.md',
  key: 'doc-key',
  file: '/work/project/notes/plan.md',
};

/** An anchor the editor would make. */
export const ANCHOR = { v: 1, quote: 'Friday', prefix: 'Ship on ', suffix: '.', start: 8, end: 14 };

/**
 * Build the harness.
 *
 * @param opts.agents - The agents Mesh knows.
 * @param opts.limits - The reply limits; defaults to depth 3, two turns each.
 * @param opts.levels - The level each chat's latest turn ran at.
 */
export function createCommentHarness(
  opts: {
    agents?: HarnessAgent[];
    limits?: Partial<CommentWakeLimits>;
    levels?: Record<string, TurnPermissionLevel>;
    /** How many automatic turns the hour has left; unlimited when omitted. */
    turnsLeft?: number;
  } = {}
) {
  const db = createTestDb();
  const agents = opts.agents ?? [
    { id: 'agent-scout', name: 'scout', path: '/agents/scout' },
    { id: 'agent-quill', name: 'quill', path: '/agents/quill' },
  ];
  const byPath = (path: string) => agents.find((agent) => agent.path === path);
  const authors = new AuthorRegistry(db, {
    byPath: (path): RoomAgent | null => {
      const agent = byPath(path);
      return agent
        ? {
            id: agent.id,
            name: agent.name,
            displayName: agent.name,
            responseMode: 'always',
            emoji: null,
            color: null,
          }
        : null;
    },
  });
  const meshCore = {
    listWithPaths: () =>
      agents.map((agent) => ({ id: agent.id, name: agent.name, projectPath: agent.path })),
    getByPath: (path: string) => {
      const agent = byPath(path);
      return agent ? { id: agent.id, name: agent.name, displayName: agent.name } : undefined;
    },
  } as unknown as MeshCore;

  const store = new DocCommentStore(db);
  const directory = new CommentDirectory({
    authors: () => authors,
    ownerUserId: () => null,
    meshCore: () => meshCore,
  });
  const limits: CommentWakeLimits = {
    enabled: true,
    maxAgentDepth: 3,
    maxTurnsPerAgentPerCascade: 2,
    ...opts.limits,
  };

  const dispatched: DispatchSessionMessageOpts[] = [];
  const dispatch = vi.fn(
    async (sent: DispatchSessionMessageOpts): Promise<DispatchSessionMessageResult> => {
      dispatched.push(sent);
      return {
        accepted: true,
        queued: false,
        messageId: sent.messageId ?? 'm',
        canonicalId: sent.sessionId,
      } as unknown as DispatchSessionMessageResult;
    }
  );
  let lifecycle: ((event: DispatchLifecycleEvent) => void) | undefined;
  // The rooms' hourly budget, as the waker sees it: what was charged, and to which window.
  const reserved: string[] = [];
  let turnsLeft = opts.turnsLeft ?? Number.POSITIVE_INFINITY;
  const budget = {
    tryReserve: (key: string) => {
      if (turnsLeft <= 0) return { allowed: false, scope: 'global' as const, counted: false };
      turnsLeft -= 1;
      reserved.push(key);
      return { allowed: true, counted: true };
    },
  };
  const waker = new CommentWaker({
    store,
    limits: () => limits,
    budget: () => budget,
    turnLevelOf: (sessionId) => opts.levels?.[sessionId],
    meshCore: () => meshCore,
    dispatch,
    onLifecycle: (listener) => {
      lifecycle = listener;
      return () => undefined;
    },
  });
  const notified: DocCommentNotifyInput[] = [];
  const service = new DocCommentService({
    store,
    directory,
    waker,
    limits: () => limits,
    notify: (input) => notified.push(input),
  });

  const owner = authors.localHuman();
  /** The owner, writing in person through the app. */
  const ownerInPerson = { author: owner, inPerson: true };
  const agentAuthor = (name: string) => {
    const agent = agents.find((candidate) => candidate.name === name)!;
    return authors.resolveAgent(agent.path, agent.name);
  };

  /** Start the turn a dispatched wake asked for, as the dispatcher would. */
  function startTurn(sent: DispatchSessionMessageOpts) {
    lifecycle?.({ phase: 'started', messageId: sent.messageId!, sessionId: sent.sessionId });
  }

  return {
    authors,
    store,
    directory,
    service,
    waker,
    dispatch,
    dispatched,
    notified,
    limits,
    owner,
    ownerInPerson,
    reserved,
    agentAuthor,
    startTurn,
  };
}
