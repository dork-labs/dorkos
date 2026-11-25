/**
 * The work graph reads' test stand (W4, DOR-4970): the lineage query's real
 * stores (`../../__tests__/lineage-fixture.ts`), the real visibility resolver
 * over the same database (`wireSessionVisibility`, rooms included), real
 * account ids, and the four reads served by the real capability mount behind
 * the `/api` chain. A chat is "bound" with the origin that decides who may
 * read it, as its first turn's binding writes it.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import type { MiddlewareHandler } from 'hono';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { authors, roomMembers, roomSessions, rooms, sessionMetadata } from '@dorkos/db';
import { entityRef, type EntityKind } from '@dorkos/shared/entity-ref';
import { capabilityGroup } from '../../../../http/__tests__/capability-group.js';
import { honoGroupListener } from '../../../../http/__tests__/hono-group-listener.js';
import type { ApiEnv } from '../../../../http/api-chain.js';
import { initConfigManager } from '../../../core/config-manager.js';
import type { AgentIdentity } from '../../../core/agent-identity/index.js';
import type { CapabilityDeps } from '../../../core/capabilities/index.js';
import { AccountIds } from '../../../audit/account-ids.js';
import { resetSessionVisibility } from '../../../audit/session-visibility.js';
import { wireSessionVisibility } from '../../../audit/wire-session-visibility.js';
import { setSessionStartedByStore } from '../../../session/origin/session-started-by-store.js';
import { getWorkLinkStore, type WorkLinkRelation } from '../../index.js';
import { stores, useLineageStores } from '../../__tests__/lineage-fixture.js';
import { workGraphReadDomain } from '../work-graph-read-capabilities.js';

export { start, stores } from '../../__tests__/lineage-fixture.js';

/** Two agents on the team, by made-up names. */
export const SCOUT = { id: '01JSCVTAGENT00000000000000', home: '/agents/scout' } as const;
export const RANGER = { id: '01JRANGERAGENT000000000000', home: '/agents/ranger' } as const;

/** Who reads, as the request arrives at the mount. */
export type Reader = 'owner' | 'scout' | 'ranger' | 'unidentified' | 'api-key';

/** Every reader in the conformance table. */
export const READERS: readonly Reader[] = ['owner', 'scout', 'ranger', 'unidentified', 'api-key'];

const target = swappableServer();
let createdAt = Date.parse('2026-11-20T09:00:00.000Z');

/** The identity the chain resolved for an agent reader. */
function identityOf(reader: Reader): AgentIdentity | undefined {
  const home = reader === 'scout' ? SCOUT.home : reader === 'ranger' ? RANGER.home : null;
  if (home === null) return undefined;
  return { agentPath: home, displayName: reader, createdAt: '2026-11-20T09:00:00.000Z' };
}

/** Give each test fresh stores, the visibility resolver and the mount. */
export function useWorkGraphReads(): void {
  let home: string;
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-work-graph-reads-'));
    initConfigManager(home);
  });
  afterAll(() => fs.rm(home, { recursive: true, force: true }));
  useLineageStores();
  beforeEach(() => {
    createdAt = Date.parse('2026-11-20T09:00:00.000Z');
    setSessionStartedByStore(stores.starts);
    const accounts = new AccountIds({
      db: stores.db,
      installId: 'work-graph-test',
      readOwnerAccount: () => null,
    });
    wireSessionVisibility({ db: stores.db, accounts });
    const auditDeps = {
      log: {} as NonNullable<CapabilityDeps['auditDeps']>['log'],
      accounts,
      roster: () => ({
        listWithPaths: () => [
          { id: SCOUT.id, name: 'scout', projectPath: SCOUT.home },
          { id: RANGER.id, name: 'ranger', projectPath: RANGER.home },
        ],
      }),
    };
    target.mount(
      honoGroupListener(capabilityGroup(workGraphReadDomain, { auditDeps }), {
        before: (async (c, next) => {
          const identity = identityOf(c.req.header('x-test-reader') as Reader);
          if (identity) c.set('agentIdentity', identity);
          await next();
        }) satisfies MiddlewareHandler<ApiEnv>,
      })
    );
  });
  afterEach(() => resetSessionVisibility());
}

/**
 * GET a path as `reader`. An agent presents its header (and the chain resolved
 * its identity); `unidentified` presents a header nobody could resolve; the
 * API key presents a key and no agent.
 */
export function get(url: string, reader: Reader = 'owner') {
  const req = request(target.server).get(url).set('x-test-reader', reader);
  if (reader === 'scout' || reader === 'ranger' || reader === 'unidentified') {
    req.set('X-DorkOS-Agent', `${reader}-token`);
  }
  if (reader === 'api-key') req.set('Authorization', 'Bearer dork_made_up_key');
  return req;
}

/** Who may read a bound chat: decided by its origin, as its binding stores it. */
export type ChatKind = 'space' | 'private' | 'room';

/**
 * Bind a chat to an agent's folder, as its first turn does, with the origin
 * that decides who reads it. A `room` chat answers in a channel whose only
 * agent member is Scout.
 */
export function bind(chatId: string, kind: ChatKind, agentHome: string = SCOUT.home): void {
  createdAt += 60_000;
  const origin = kind === 'space' ? 'agent-launch' : kind === 'private' ? 'interactive' : 'room';
  stores.db
    .insert(sessionMetadata)
    .values({
      sessionId: chatId,
      runtime: 'claude-code',
      agentPath: agentHome,
      launchOrigin: origin,
      createdAt: new Date(createdAt).toISOString(),
    })
    .run();
  if (kind === 'room') roomFor(chatId);
}

/** A channel whose one agent member is Scout, with `chatId` its session. */
function roomFor(chatId: string): void {
  const at = '2026-11-20T09:00:00.000Z';
  const roomId = `room-${chatId}`;
  if (
    !stores.db
      .select()
      .from(authors)
      .all()
      .some((row) => row.id === 'scout')
  ) {
    stores.db
      .insert(authors)
      .values({
        id: 'scout',
        kind: 'agent',
        naturalKey: SCOUT.home,
        displayName: 'scout',
        createdAt: at,
      })
      .run();
  }
  stores.db
    .insert(rooms)
    .values({
      id: roomId,
      kind: 'channel',
      title: roomId,
      slug: roomId,
      createdAt: at,
      lastActivityAt: at,
    })
    .run();
  stores.db
    .insert(roomMembers)
    .values({ roomId, authorId: 'scout', responseMode: 'always', joinedAt: at })
    .run();
  stores.db
    .insert(roomSessions)
    .values({ roomId, authorId: 'scout', sessionId: chatId, createdAt: at })
    .run();
}

/** Record that a chat is `relation` to a pull request or ticket, through the store. */
export function link(
  chatId: string,
  relation: WorkLinkRelation,
  kind: Extract<EntityKind, 'pr' | 'ticket'>,
  id: string
): void {
  const from = entityRef('chat', chatId);
  const to = entityRef(kind, id);
  if (!from.ok || !to.ok) throw new Error('bad ref in a test link');
  const result = getWorkLinkStore()!.record({
    from: from.value,
    relation,
    to: to.value,
    source: 'open-pr',
    recordingChatId: chatId,
  });
  if (!result.ok) throw new Error(`link refused: ${result.reason}`);
}
