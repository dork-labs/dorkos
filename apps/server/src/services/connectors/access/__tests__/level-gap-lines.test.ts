/**
 * What an agent reads about actions its access level leaves out (DOR-4678):
 * the refusal and list note for actions no level includes, and the line for a
 * level the one-time write upgrade lowered, shown only while that still stands.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  activityEvents,
  and,
  connectionAccessLevels,
  connectionGrantExclusions,
  connectorOperationRevisions,
  connectorReconciliationCandidates,
  connections,
  eq,
  inArray,
  type Db,
} from '@dorkos/db';
import { upgradeComposioWriteLevels } from '../composio-write-upgrade.js';
import {
  CONNECTION_ID,
  grantLevels,
  idOf,
  levelHarness,
  NOW,
} from '../../__tests__/helpers/access-levels-harness.js';
import { createServerPrincipal } from '../../principal/server-principal.js';
import { grantedLine } from '../../resources/agent-request-messages.js';
import { connectorExecutionDomain } from '../../execution/execution-capabilities.js';
import { grantRefusal } from '../../execution/grant-refusal.js';
import {
  isOutsideLevels,
  loweredWriteLine,
  offersReadWrite,
  operationsListNote,
  outsideLevelsListNote,
  outsideLevelsRefusal,
} from '../level-gap-lines.js';

const OUTSIDE_REFUSAL =
  'No access level includes this action, so "Read and write" doesn\'t cover it. It has to ' +
  'be given to this agent on its own: the person chooses it under exact actions for Gmail ' +
  'on the Connections page.';
const OUTSIDE_REFUSAL_NO_RW =
  'No access level includes this action, so it has to be given to this agent on its own: the ' +
  'person chooses it under exact actions for Gmail on the Connections page.';
const LIST_NOTE =
  'Some actions, such as trashing or deleting, are never part of an access level, so ' +
  '"Read and write" doesn\'t cover them. If you need one that isn\'t listed here, ask the ' +
  'person to choose it for you under exact actions for Gmail on the Connections page.';
const LIST_NOTE_NO_RW =
  'Some actions, such as trashing or deleting, are never part of an access level. If you need ' +
  "one that isn't listed here, ask the person to choose it for you under exact actions for " +
  'Gmail on the Connections page.';
const GRANTED_NOTE =
  'Some actions, such as trashing or deleting, are never part of an access level, so ' +
  '"Read and write" doesn\'t cover them. If you need one, ask the person to choose it for you ' +
  'under exact actions for Gmail on the Connections page.';
const LOWERED_OWN =
  'When DorkOS started allowing changes in Linear through "Read and write", it moved your ' +
  'access there from "Read and write" to "Read", and the person hasn\'t chosen again since. ' +
  'If you need to change things in Linear, ask the person to choose "Read and write" for you ' +
  'on the Connections page.';
const LOWERED_SHARED =
  'When DorkOS started allowing changes in Linear through "Read and write", it moved the ' +
  'access every agent shares there from "Read and write" to "Read", and the person hasn\'t ' +
  'chosen again since. If you need to change things in Linear, ask the person to choose ' +
  '"Read and write" for you on the Connections page.';
const NOT_GRANTED = 'This agent is not granted the selected operation.';
const UPGRADED_AT = '2026-11-16T09:00:00.000Z';

const opened: Array<{ db: Db }> = [];
afterEach(() => {
  for (const h of opened.splice(0)) h.db.$client.close();
});

/** A Gmail account whose levels were chosen once: Reader Read, Writer Read and write. */
async function granted(options: { withoutWrites?: boolean } = {}) {
  const h = levelHarness();
  opened.push(h);
  if (options.withoutWrites) {
    h.catalog.splice(
      h.catalog.findIndex((action) => action.classification === 'write'),
      1
    );
  }
  const snapshot = await grantLevels(h);
  return { ...h, snapshot };
}

/** A Linear account through Composio whose levels the upgrade has lowered. */
async function lowered(options: { everyAgent?: boolean } = {}) {
  const h = levelHarness({ type: 'composio' });
  opened.push(h);
  await grantLevels(h);
  h.db
    .update(connections)
    .set({ toolkit: 'linear' })
    .where(eq(connections.id, CONNECTION_ID))
    .run();
  if (options.everyAgent) {
    h.db
      .insert(connectionAccessLevels)
      .values({
        subjectType: 'every_agent',
        subjectId: 'every_agent',
        agentId: null,
        connectionId: CONNECTION_ID,
        level: 'read-write',
        createdBy: 'install-a',
        updatedAt: NOW.toISOString(),
      })
      .run();
  }
  upgradeComposioWriteLevels(h.db, UPGRADED_AT);
  return h;
}

const NOT_HELD = { named: false, everyAgent: false };
const TRASH = {
  toolkit: 'gmail',
  operationSlug: 'gmail.delete',
  classification: 'destructive' as const,
};

describe('actions no access level includes', () => {
  it('counts every destructive action and every paid action, and nothing a level covers', () => {
    const op = (
      toolkit: string,
      operationSlug: string,
      classification: 'read' | 'write' | 'destructive'
    ) => ({
      toolkit,
      operationSlug,
      classification,
    });
    expect(isOutsideLevels(op('gmail', 'GMAIL_MOVE_TO_TRASH', 'destructive'))).toBe(true);
    expect(isOutsideLevels(op('apify', 'APIFY_RUN_ACTOR', 'write'))).toBe(true);
    expect(isOutsideLevels(op('gmail', 'GMAIL_SEND_EMAIL', 'write'))).toBe(false);
    expect(isOutsideLevels(op('gmail', 'GMAIL_FETCH_EMAILS', 'read'))).toBe(false);
  });

  it('keeps its "trashing or deleting" examples true: deletes stay out of every level', async () => {
    // The agent lines name trashing and deleting as actions no level includes.
    // If DOR-4451 admits deletes into "Read and write", rewrite outsideLevelsLine
    // in level-gap-lines.ts ("Some actions, such as trashing or deleting, are
    // never part of an access level") and the refusal before flipping this.
    // Imported from the package source by URL so WRITE_INCLUDES_DELETES stays out of its published API.
    const classes = (await import(
      new URL(
        '../../../../../../../packages/connector-providers/src/composio/action-classes.ts',
        import.meta.url
      ).href
    )) as {
      WRITE_INCLUDES_DELETES: boolean;
      classifyComposioAction: (toolkit: string, slug: string, tags: string[]) => string;
    };
    expect(
      classes.WRITE_INCLUDES_DELETES,
      'level-gap-lines.ts says "such as trashing or deleting" are never part of an access level'
    ).toBe(false);
    for (const slug of ['GMAIL_MOVE_TO_TRASH', 'GOOGLEDRIVE_DELETE_FILE']) {
      expect(classes.classifyComposioAction('gmail', slug, ['destructiveHint'])).toBe(
        'destructive'
      );
    }
  });

  it('refuses one the agent was not given by saying how the person gives it', async () => {
    const h = await granted();
    const target = {
      connectionId: CONNECTION_ID,
      operationRevisionId: idOf(h.snapshot, 'gmail.delete'),
      arguments: {},
    };
    expect(grantRefusal(h.db, 'writer', target, NOT_HELD, TRASH)).toBe(OUTSIDE_REFUSAL);
    // Given on its own, it still runs.
    expect(
      grantRefusal(h.db, 'exact', target, { named: true, everyAgent: false }, TRASH)
    ).toBeNull();
  });

  it('names no level for an app that offers no "Read and write"', async () => {
    const h = await granted({ withoutWrites: true });
    expect(offersReadWrite(h.db, CONNECTION_ID)).toBe(false);
    const target = {
      connectionId: CONNECTION_ID,
      operationRevisionId: idOf(h.snapshot, 'gmail.delete'),
      arguments: {},
    };
    expect(grantRefusal(h.db, 'writer', target, NOT_HELD, TRASH)).toBe(OUTSIDE_REFUSAL_NO_RW);
    expect(outsideLevelsRefusal('gmail', false)).toBe(OUTSIDE_REFUSAL_NO_RW);
    expect(operationsListNote(h.db, 'reader', CONNECTION_ID, 'gmail')).toBe(LIST_NOTE_NO_RW);
  });

  it('keeps the plain refusal for an action the person could not pick either', async () => {
    const h = await granted();
    const deleteId = idOf(h.snapshot, 'gmail.delete');
    h.db
      .update(connectorReconciliationCandidates)
      .set({ supported: false })
      .where(eq(connectorReconciliationCandidates.operationRevisionId, deleteId))
      .run();
    const target = { connectionId: CONNECTION_ID, operationRevisionId: deleteId, arguments: {} };
    expect(grantRefusal(h.db, 'writer', target, NOT_HELD, TRASH)).toBe(NOT_GRANTED);
    const unknown = { ...target, operationRevisionId: 'not-in-any-review' };
    expect(grantRefusal(h.db, 'writer', unknown, NOT_HELD, TRASH)).toBe(NOT_GRANTED);
  });

  it('keeps the plain refusal for an ordinary action the agent was not given', async () => {
    const h = await granted();
    const send = {
      toolkit: 'gmail',
      operationSlug: 'gmail.send',
      classification: 'write' as const,
    };
    const target = {
      connectionId: CONNECTION_ID,
      operationRevisionId: idOf(h.snapshot, 'gmail.send'),
      arguments: {},
    };
    expect(grantRefusal(h.db, 'reader', target, NOT_HELD, send)).toBe(NOT_GRANTED);
  });

  it('notes on every list of granted actions what a level leaves out and how to ask', async () => {
    const list = connectorExecutionDomain.capabilities.find(
      (entry) => entry.id === 'connectors.list_granted_operations'
    )!;
    expect(list.description).toContain('such as trashing or deleting');
    const principal = createServerPrincipal({
      kind: 'runtime',
      owner: { kind: 'local_install', installationId: 'install-a' },
      bindingId: 'binding-a',
      runtime: 'claude-code',
      canonicalSessionId: 'session-a',
      agentId: 'writer',
      agentPath: '/agents/writer',
    });
    const operation = {
      operationRevisionId: 'rev-1',
      toolkit: 'gmail',
      operationSlug: 'GMAIL_SEND_EMAIL',
      toolkitVersion: 'v1',
      capabilityClassification: 'write' as const,
      retryPolicy: 'never' as const,
      inputSchema: {},
    };
    const seen: unknown[] = [];
    const run = (operationsNote?: (...args: unknown[]) => string) =>
      list.invoke(
        {
          connectorExecutionDeps: {
            authorization: { assertAvailable: () => undefined },
            access: {
              listRuntimeOperations: async () => ({
                connectionId: CONNECTION_ID,
                operations: [operation],
              }),
            },
            ...(operationsNote && { operationsNote }),
          },
        } as never,
        { connectionId: CONNECTION_ID } as never,
        { serverPrincipal: principal } as never
      );
    // With no database to read the app from, the note names no level.
    await expect(run()).resolves.toMatchObject({ note: LIST_NOTE_NO_RW });
    await expect(
      run((...args) => {
        seen.push(args);
        return 'From the app.';
      })
    ).resolves.toMatchObject({ note: 'From the app.' });
    expect(seen).toEqual([['writer', CONNECTION_ID, 'gmail']]);

    const h = await granted();
    expect(offersReadWrite(h.db, CONNECTION_ID)).toBe(true);
    expect(operationsListNote(h.db, 'writer', CONNECTION_ID, 'gmail')).toBe(LIST_NOTE);
    expect(outsideLevelsListNote('gmail', true)).toBe(LIST_NOTE);
  });
});

describe('the granted note after a request', () => {
  const held = (...classes: string[]) => new Set(classes);
  it('adds what no level covers once the answer holds a level write the app offers', () => {
    expect(
      grantedLine('Gmail', {
        held: held('read', 'write'),
        heldLevelWrite: true,
        offers: { read: 'level', write: 'level' },
      })
    ).toBe(`You can now read and change things in Gmail. ${GRANTED_NOTE}`);
  });
  it('says nothing more for an answer of one-at-a-time actions only', () => {
    expect(
      grantedLine('Gmail', {
        held: held('read', 'write'),
        heldLevelWrite: false,
        offers: { read: 'level', write: 'level' },
      })
    ).toBe('You can now read and change things in Gmail.');
  });
  it('says nothing more in an app that offers changes only one at a time', () => {
    expect(
      grantedLine('Gmail', {
        held: held('read', 'write'),
        heldLevelWrite: true,
        offers: { read: 'level', write: 'exact' },
      })
    ).toBe('You can now read and change things in Gmail.');
  });
});

describe('a level the one-time write upgrade lowered', () => {
  it('tells the agent whose own level it lowered', async () => {
    const h = await lowered();
    expect(loweredWriteLine(h.db, 'writer', CONNECTION_ID)).toBe(LOWERED_OWN);
  });

  it('says nothing to an agent the upgrade did not touch', async () => {
    const h = await lowered();
    expect(loweredWriteLine(h.db, 'reader', CONNECTION_ID)).toBeNull();
    expect(loweredWriteLine(h.db, 'exact', CONNECTION_ID)).toBeNull();
  });

  it('stops once the person chooses again, even "Read"', async () => {
    const h = await lowered();
    h.db
      .update(connectionAccessLevels)
      .set({ updatedAt: '2026-11-17T10:00:00.000Z' })
      .where(eq(connectionAccessLevels.subjectId, 'writer'))
      .run();
    expect(loweredWriteLine(h.db, 'writer', CONNECTION_ID)).toBeNull();
  });

  it('stops while any level there includes changes', async () => {
    const h = await lowered({ everyAgent: true });
    h.db
      .update(connectionAccessLevels)
      .set({ level: 'read-write', updatedAt: '2026-11-17T10:00:00.000Z' })
      .where(eq(connectionAccessLevels.subjectType, 'every_agent'))
      .run();
    expect(loweredWriteLine(h.db, 'writer', CONNECTION_ID)).toBeNull();
  });

  it('names the shared level for an agent that holds none of its own', async () => {
    const h = await lowered({ everyAgent: true });
    expect(loweredWriteLine(h.db, 'exact', CONNECTION_ID)).toBe(LOWERED_SHARED);
  });

  it('says nothing about the shared level to an agent left out of sharing here', async () => {
    const h = await lowered({ everyAgent: true });
    h.db
      .insert(connectionGrantExclusions)
      .values({
        id: 'exclusion-1',
        agentId: 'exact',
        connectionId: CONNECTION_ID,
        createdBy: 'install-a',
        createdAt: '2026-11-17T10:00:00.000Z',
      })
      .run();
    expect(loweredWriteLine(h.db, 'exact', CONNECTION_ID)).toBeNull();
    // Let back in, it reads the line again.
    h.db
      .update(connectionGrantExclusions)
      .set({ revokedAt: '2026-11-17T11:00:00.000Z', revokedBy: 'install-a' })
      .where(eq(connectionGrantExclusions.id, 'exclusion-1'))
      .run();
    expect(loweredWriteLine(h.db, 'exact', CONNECTION_ID)).toBe(LOWERED_SHARED);
  });

  it('follows the agent’s own level over a lowered shared one', async () => {
    // Reader's own "Read" was the person's choice, not the upgrade's.
    const h = await lowered({ everyAgent: true });
    expect(loweredWriteLine(h.db, 'reader', CONNECTION_ID)).toBeNull();
  });

  it('reads only the upgrade row for this account and this subject', async () => {
    const h = await granted();
    const reader = h.db
      .select()
      .from(connectionAccessLevels)
      .where(
        and(
          eq(connectionAccessLevels.subjectId, 'reader'),
          eq(connectionAccessLevels.connectionId, CONNECTION_ID)
        )
      )
      .get()!;
    const upgradeRow = (id: string, resourceId: string, subjectId: string) => ({
      id,
      occurredAt: reader.updatedAt,
      createdAt: reader.updatedAt,
      actorType: 'system' as const,
      actorLabel: 'DorkOS',
      category: 'permissions' as const,
      eventType: 'connectors.write_upgrade',
      resourceType: 'connection',
      resourceId,
      resourceLabel: 'Gmail',
      summary: 'Changed Gmail access to Read',
      metadata: JSON.stringify({
        subjectType: 'agent',
        subjectId,
        before: 'read-write',
        after: 'read',
      }),
    });
    h.db
      .insert(activityEvents)
      .values(upgradeRow('a1', 'connection-b', 'reader'))
      .run();
    h.db
      .insert(activityEvents)
      .values(upgradeRow('a2', CONNECTION_ID, 'writer'))
      .run();
    expect(loweredWriteLine(h.db, 'reader', CONNECTION_ID)).toBeNull();
    h.db
      .insert(activityEvents)
      .values(upgradeRow('a3', CONNECTION_ID, 'reader'))
      .run();
    expect(loweredWriteLine(h.db, 'reader', CONNECTION_ID)).toContain('it moved your access');
  });

  it('says nothing on an app that offers no "Read and write" to choose again', async () => {
    // The upgrade also lowered apps whose every change is paid or one at a time.
    const h = await lowered();
    h.db
      .update(connectorReconciliationCandidates)
      .set({ supported: false })
      .where(
        inArray(
          connectorReconciliationCandidates.operationRevisionId,
          h.db
            .select({ id: connectorOperationRevisions.id })
            .from(connectorOperationRevisions)
            .where(eq(connectorOperationRevisions.capabilityClassification, 'write'))
        )
      )
      .run();
    expect(offersReadWrite(h.db, CONNECTION_ID)).toBe(false);
    expect(loweredWriteLine(h.db, 'writer', CONNECTION_ID)).toBeNull();
    expect(operationsListNote(h.db, 'writer', CONNECTION_ID, 'linear')).not.toContain(
      'moved your access'
    );
    const change = {
      toolkit: 'linear',
      operationSlug: 'LINEAR_CREATE_ISSUE',
      classification: 'write' as const,
    };
    const target = { connectionId: CONNECTION_ID, operationRevisionId: 'rev-1', arguments: {} };
    expect(grantRefusal(h.db, 'writer', target, NOT_HELD, change)).toBe(NOT_GRANTED);
  });

  it('adds the line to the refusal of a write it took away', async () => {
    const h = await lowered();
    const change = {
      toolkit: 'linear',
      operationSlug: 'LINEAR_CREATE_ISSUE',
      classification: 'write' as const,
    };
    const target = { connectionId: CONNECTION_ID, operationRevisionId: 'rev-1', arguments: {} };
    expect(grantRefusal(h.db, 'writer', target, NOT_HELD, change)).toBe(
      `${NOT_GRANTED} ${LOWERED_OWN}`
    );
    expect(grantRefusal(h.db, 'reader', target, NOT_HELD, change)).toBe(NOT_GRANTED);
  });
});
