/**
 * The work graph reads' test stand (W4, DOR-4970): the lineage query's real
 * stores (`../../__tests__/lineage-fixture.ts`), the real visibility resolver
 * over the same database (`wireSessionVisibility`, rooms included), real
 * account ids, and the four reads served by the real capability mount behind
 * the `/api` chain, and over the in-session MCP server. A program key is a
 * real Better Auth API key the session gate verifies, with "Ask for a
 * password on this computer too" on for its request. A chat is "bound" with
 * the origin that decides who may read it, as its first turn's binding writes
 * it.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import type { MiddlewareHandler } from 'hono';
import request, { type Response } from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { authors, roomMembers, roomSessions, rooms, sessionMetadata, user } from '@dorkos/db';
import { noopLogger } from '@dorkos/shared/logger';
import { entityRef, type EntityKind } from '@dorkos/shared/entity-ref';
import { capabilityGroup } from '../../../../http/__tests__/capability-group.js';
import { createCapabilitiesInvokeRoutes } from '../../../../routes/capabilities-invoke.js';
import { honoGroupListener } from '../../../../http/__tests__/hono-group-listener.js';
import type { ApiEnv } from '../../../../http/api-chain.js';
import type { WorkLinkInput } from '../../work-link-store.js';
import { configManager, initConfigManager } from '../../../core/config-manager.js';
import { initAuth } from '../../../core/auth/index.js';
import type { AgentIdentity } from '../../../core/agent-identity/index.js';
import {
  composeRegistry,
  type CapabilityDeps,
  type CapabilityInvocationContext,
} from '../../../core/capabilities/index.js';
import { createCapabilityMcpClient } from '../../../runtimes/claude-code/mcp-tools/__tests__/capability-mcp-client.js';
import { AccountIds } from '../../../audit/account-ids.js';
import { resetSessionVisibility } from '../../../audit/session-visibility.js';
import { wireSessionVisibility } from '../../../audit/wire-session-visibility.js';
import { setSessionStartedByStore } from '../../../session/origin/session-started-by-store.js';
import { getWorkLinkStore, isSpanRelation, type WorkLinkRelation } from '../../index.js';
import { stores, useLineageStores } from '../../__tests__/lineage-fixture.js';
import { workGraphReadDomain } from '../../../core/self-description/dorkos-registry.js';

export { start, stores } from '../../__tests__/lineage-fixture.js';

/** Two agents on the team, by made-up names. */
export const SCOUT = { id: '01JSCVTAGENT00000000000000', home: '/agents/scout' } as const;
export const RANGER = { id: '01JRANGERAGENT000000000000', home: '/agents/ranger' } as const;

/**
 * Who reads, as the request arrives at the mount. `bad-key` presents a key
 * Better Auth never issued; it is refused before any read.
 */
export type Reader = 'owner' | 'scout' | 'ranger' | 'unidentified' | 'api-key' | 'bad-key';

/** Every reader in the conformance table that reaches a read. */
export const READERS: readonly Exclude<Reader, 'bad-key'>[] = [
  'owner',
  'scout',
  'ranger',
  'unidentified',
  'api-key',
];

const target = swappableServer();
let createdAt = Date.parse('2026-11-20T09:00:00.000Z');
let auditDeps: NonNullable<CapabilityDeps['auditDeps']>;
let mintKey: () => Promise<string>;
let issuedKey: string | null = null;

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
    const auth = initAuth(stores.db, home);
    issuedKey = null;
    mintKey = async () => {
      await auth.api.signUpEmail({
        body: {
          email: 'owner' + '@' + 'dork.test',
          password: 'made-up-pass-phrase',
          name: 'Owner',
        },
      });
      const ownerId = stores.db.select().from(user).get()!.id;
      return (await auth.api.createApiKey({ body: { userId: ownerId, name: 'work-graph' } })).key;
    };
    auditDeps = {
      log: {} as NonNullable<CapabilityDeps['auditDeps']>['log'],
      accounts,
      roster: () => ({
        listWithPaths: () => [
          { id: SCOUT.id, name: 'scout', projectPath: SCOUT.home },
          { id: RANGER.id, name: 'ranger', projectPath: RANGER.home },
        ],
      }),
    };
    const invokeRegistry = composeRegistry([workGraphReadDomain], {
      logger: noopLogger,
      auditDeps,
    });
    target.mount(
      honoGroupListener(
        [
          capabilityGroup(workGraphReadDomain, { auditDeps }),
          // `/invoke`, as `dorkos call` reaches a capability.
          { path: '/api/capabilities', routes: createCapabilitiesInvokeRoutes(invokeRegistry) },
        ],
        {
          before: (async (c, next) => {
            const identity = identityOf(c.req.header('x-test-reader') as Reader);
            if (identity) c.set('agentIdentity', identity);
            await next();
          }) satisfies MiddlewareHandler<ApiEnv>,
        }
      )
    );
  });
  afterEach(() => resetSessionVisibility());
}

/**
 * GET a path as `reader`. An agent presents its header (and the chain resolved
 * its identity); `unidentified` presents a header nobody could resolve. A key
 * reader asks with the session gate on, so the key is what lets it in: a real
 * one for `api-key`, one nobody issued for `bad-key`.
 */
export async function get(url: string, reader: Reader = 'owner'): Promise<Response> {
  const req = request(target.server).get(url).set('x-test-reader', reader);
  if (reader === 'scout' || reader === 'ranger' || reader === 'unidentified') {
    req.set('X-DorkOS-Agent', `${reader}-token`);
  }
  if (reader !== 'api-key' && reader !== 'bad-key') return req;
  issuedKey ??= await mintKey();
  const key = reader === 'api-key' ? issuedKey : 'dork_never_issued_key';
  configManager.set('auth', { enabled: true });
  try {
    return await req.set('Authorization', `Bearer ${key}`);
  } finally {
    configManager.set('auth', { enabled: false });
  }
}

/** GET a path with login off and these headers only, as a program at this computer might. */
export async function getWith(url: string, headers: Record<string, string>): Promise<Response> {
  return request(target.server).get(url).set(headers);
}

/**
 * Call a capability through `POST /api/capabilities/:id/invoke`, as
 * `dorkos call` does, with no key and no agent token.
 */
export async function invoke(id: string, input: Record<string, unknown>): Promise<Response> {
  return request(target.server).post(`/api/capabilities/${id}/invoke`).send(input);
}

/**
 * Call a read's tool over the in-session MCP server, with no turn bound to the
 * call: the caller `readerFor` reads as an agent nobody could name. Over the
 * `external` server, the caller is one no agent token or person names.
 * `context` is what the surface bound to the call, such as the user a key
 * resolved to.
 *
 * @returns Whether the tool answered an error, and the JSON it carried.
 */
export async function callInSession(
  name: string,
  args: Record<string, unknown>,
  server: 'in-session' | 'external' = 'in-session',
  context?: CapabilityInvocationContext
): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  const registry = composeRegistry([workGraphReadDomain], { logger: noopLogger, auditDeps });
  const { client } = await createCapabilityMcpClient(
    registry,
    server,
    context ? async () => context : undefined
  );
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content?: { type: string; text?: string }[];
  };
  const text = result.content?.find((part) => part.type === 'text')?.text ?? '{}';
  return {
    isError: result.isError === true,
    body: result.structuredContent ?? (JSON.parse(text) as Record<string, unknown>),
  };
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

/** Record that a chat is `relation` to a pull request or ticket, through the store, with the recording turn's marks if given. */
export function link(
  chatId: string,
  relation: WorkLinkRelation,
  kind: Extract<EntityKind, 'pr' | 'ticket'>,
  id: string,
  turnMarks?: NonNullable<WorkLinkInput['turnMarks']>
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
    ...(turnMarks ? { turnMarks } : {}),
    // A claim is written by the claim tool, at the claim's own time.
    ...(isSpanRelation(relation)
      ? { source: 'claim-tool', recordedAt: new Date().toISOString() }
      : {}),
  });
  if (!result.ok) throw new Error(`link refused: ${result.reason}`);
}
