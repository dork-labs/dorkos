/**
 * Export format 3 (specs/server-merge/03-agents-as-members.md, PR 3; DOR-2876).
 *
 * Format 3 lists every agent as a member of kind `agent`, with its owner, and names a member as
 * every message's author. This file pins what it writes (owner and personal exports), that it
 * imports on this release with the same people, agent members and authors, that a format 2
 * archive (this release's, and v0.117.0's, which has no availability fields) still imports with
 * agent members built for it and re-exports as format 3 with nothing lost, that tampered format 3
 * rows are refused, and that the importer v0.117.0 runs refuses a format 3 archive by name.
 */
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommunityExportEntryRowV3Schema,
  CommunityExportMemberRowV3Schema,
} from '@dorkos/shared/community-wire';
import { bufferReader } from '../archive/__tests__/archive-test-helpers.js';
import { uuidv5 } from '../imports/derived-id.js';
import { sweepImports } from '../imports/worker.js';
import { banEmailKey } from '../moderation/bans.js';
import { responseCookies } from './bootstrap-test-helper.js';
import {
  EXPORT_SETTINGS,
  drainExports,
  openArchive,
  type OpenedArchive,
} from './export-test-helpers.js';
import { readManifestVersionV0117 } from './fixtures/v0117-read-manifest-version.js';
import { createImport, issueKey, readImport, uploadArchive } from './import-fixture.js';
import { body, drainCleanup, post, upload } from './member-erasure-fixture.js';
import {
  TENANCY_PASSWORD,
  admit,
  bootstrapHost,
  expectStatus,
  pairInstall,
  preflightOwnerClaim,
  startTenancyHarness,
  type TenancyHarness,
  type TenancyMember,
} from './tenancy-test-harness.js';

let h: TenancyHarness;
let key = '';
let source = { communityId: '', channelId: '', base: '' };
let owner: TenancyMember;
let mo: TenancyMember;
let moAgent = '';
let moAgentToken = '';
let abeAgent = '';
let agentMessage = '';
let personMessage = '';
let keyCounter = 0;

type Row = Record<string, unknown>;

async function enroll(who: TenancyMember, label: string) {
  const grant = await pairInstall(
    h,
    source.communityId,
    who.cookie,
    ['read', 'post', 'enroll-agent'],
    label
  );
  const enrolled = await body<{ token: string; agent: { memberId: string } }>(
    await h.call(`${source.base}/agents`, {
      bearer: grant,
      body: { localAgentId: `local-${label}`, displayName: `Bot ${label}` },
    }),
    201,
    `enroll ${label}`
  );
  await expectStatus(
    await h.call(`${source.base}/channels/${source.channelId}/agents`, {
      bearer: grant,
      body: { agentId: enrolled.agent.memberId },
    }),
    200,
    `place ${label}`
  );
  return { id: enrolled.agent.memberId, token: enrolled.token };
}

const say = async (auth: { cookie?: string; bearer?: string }, text: string) =>
  (
    await post(h, source.communityId, source.channelId, auth, {
      text,
      idempotencyKey: `k-${++keyCounter}`,
    })
  ).id;

/**
 * Export a space as its owner and return the archive's bytes. `format: 2` writes it as a job
 * queued before format 3 existed does, which is what an older release's archive holds.
 */
async function exportSpace(
  space: { base: string },
  cookie: string,
  options: { format?: 2 | 3; scope?: 'owner' | 'personal' } = {}
): Promise<Buffer> {
  await drainExports(h.pool, h.blobStore);
  await h.pool.query(
    "UPDATE export_archives SET expires_at=now()-interval '1 second' WHERE state='ready'"
  );
  const personal = options.scope === 'personal';
  const created = await body<{ export: { id: string } }>(
    await h.call(`${space.base}/${personal ? 'me' : 'owner'}/export`, {
      cookie,
      body: personal ? {} : { password: TENANCY_PASSWORD },
    }),
    202,
    'export'
  );
  if (options.format === 2)
    await h.pool.query('UPDATE export_archives SET format_version=2 WHERE id=$1', [
      created.export.id,
    ]);
  await drainExports(h.pool, h.blobStore, { settings: EXPORT_SETTINGS });
  const download = await expectStatus(
    await h.call(`${space.base}/exports/${created.export.id}/archive`, { cookie }),
    200,
    'download'
  );
  return Buffer.from(await download.arrayBuffer());
}

/** Import an archive through the host API and run the worker until it settles. */
async function importArchive(archive: Buffer) {
  const created = await createImport(h, { bearer: key }, { name: 'Moved', autoCommit: true });
  await expectStatus(
    await uploadArchive(h, created.importId, archive, { bearer: created.uploadToken }),
    200,
    'upload'
  );
  const limits = {
    ...h.config.limits,
    banEmailKey: (email: string) => banEmailKey(email, h.config.authSecret),
  };
  for (let round = 0; round < 200; round++) {
    const state = (await readImport(h, created.importId, key)).state as string;
    if (state === 'ready' || state === 'failed') break;
    await h.pool.query(
      'UPDATE community_imports SET next_attempt_at=now() WHERE settled_at IS NULL'
    );
    await drainCleanup(h);
    await sweepImports(h.pool, h.blobStore, limits, new Date());
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { ...created, derive: (id: string) => uuidv5(created.importId, id) };
}

/** An owner no export names. */
const OUTSIDE = '11111111-2222-4333-8444-555555555555';

/**
 * After a failed import, run the worker until its unclaimed space is torn down, then check
 * nothing of it is left: the space, its blobs, and every row an import writes.
 */
async function expectNothingLeft(communityId: string): Promise<void> {
  const limits = {
    ...h.config.limits,
    banEmailKey: (email: string) => banEmailKey(email, h.config.authSecret),
  };
  const left = async (sql: string) =>
    (await h.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) t`, [communityId]))
      .rows[0].n;
  for (let round = 0; round < 200; round++) {
    if ((await left('SELECT 1 FROM communities WHERE id=$1')) === 0) break;
    await h.pool.query(
      'UPDATE community_imports SET next_attempt_at=now() WHERE settled_at IS NULL'
    );
    await drainCleanup(h);
    await sweepImports(h.pool, h.blobStore, limits, new Date());
  }
  await drainCleanup(h);
  expect(await left('SELECT 1 FROM communities WHERE id=$1')).toBe(0);
  expect(await left('SELECT 1 FROM managed_blobs WHERE community_id=$1')).toBe(0);
  for (const table of ['channels', 'entries', 'members', 'agents', 'attachments', 'audit_events'])
    expect([table, await left(`SELECT 1 FROM ${table} WHERE community_id=$1`)]).toEqual([table, 0]);
}

/** Claim an imported space as a new account, so it can be exported again. */
async function claim(communityId: string, label: string): Promise<TenancyMember> {
  const issued = await expectStatus(
    await h.call(`/api/v1/host/communities/${communityId}/owner-claims/reissue`, {
      bearer: key,
      body: {},
    }),
    200,
    'reissue claim'
  );
  const grant = await preflightOwnerClaim(h, (await issued.json()).ownerClaimToken);
  const signedUp = await expectStatus(
    await h.call('/api/auth/sign-up/email', {
      body: { name: label, email: `${label}@format3.test`, password: TENANCY_PASSWORD },
      cookie: grant,
    }),
    200,
    'sign up'
  );
  const cookie = `${grant}; ${responseCookies(signedUp)}`;
  const claimed = await expectStatus(
    await h.call('/api/v1/owner-claims/claim', { cookie, body: {} }),
    200,
    'claim'
  );
  return { cookie, memberId: (await claimed.json()).memberId };
}

/** Change one archive: every entry stays, with `change` applied to the named NDJSON lines. */
function rebuilt(archive: OpenedArchive, change: (name: string, lines: Row[]) => Row[]): Buffer {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });
  for (const name of archive.names) {
    let bytes = Buffer.from(archive.files.get(name)!);
    if (name.endsWith('.ndjson')) {
      const lines = bytes
        .toString('utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Row);
      bytes = Buffer.from(
        change(name, lines)
          .map((line) => `${JSON.stringify(line)}\n`)
          .join('')
      );
    }
    const file =
      name.startsWith('files/') || name === 'community/icon'
        ? new ZipPassThrough(name)
        : new ZipDeflate(name);
    zip.add(file);
    file.push(bytes, true);
  }
  zip.end();
  return Buffer.concat(chunks);
}

/** The imported space's members, agents and message authors, keyed back to the source ids. */
async function restoredShape(communityId: string, derive: (id: string) => string, ids: string[]) {
  const back = new Map(ids.map((id) => [derive(id), id]));
  const source = (id: unknown) => (id === null ? null : (back.get(id as string) ?? 'unknown'));
  const members = await h.pool.query<Row>(
    `SELECT id,kind,owner_member_id,display_name,role FROM members WHERE community_id=$1`,
    [communityId]
  );
  const entries = await h.pool.query<Row>(
    'SELECT id,author_member_id,author_agent_id,text FROM entries WHERE community_id=$1',
    [communityId]
  );
  return {
    members: members.rows
      .filter((row) => back.has(row.id as string))
      .map((row): Row => ({
        ...row,
        id: source(row.id),
        owner_member_id: source(row.owner_member_id),
      }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    entries: entries.rows
      .map((row) => ({
        id: source(row.id),
        author_member_id: source(row.author_member_id),
        author_agent_id: source(row.author_agent_id),
        text: row.text,
      }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
  };
}

beforeAll(async () => {
  h = await startTenancyHarness('format3');
  const host = await bootstrapHost(h, 'Olga Owner', 'olga@format3.test');
  owner = { cookie: host.cookie, memberId: host.memberId };
  source = {
    communityId: host.communityId,
    channelId: host.channelId,
    base: `/api/v1/communities/${host.communityId}`,
  };
  key = await issueKey(h, ['communities:import', 'communities:read', 'communities:write']);
  mo = await admit(h, source.communityId, owner.cookie, { name: 'Mo', email: 'mo@format3.test' });
  await expectStatus(
    await h.call(`${source.base}/channels/${source.channelId}/join`, {
      cookie: mo.cookie,
      body: {},
    }),
    200,
    'join'
  );
  const abe = await admit(h, source.communityId, owner.cookie, {
    name: 'Abe',
    email: 'abe@format3.test',
  });
  ({ id: moAgent, token: moAgentToken } = await enroll(mo, 'mo'));
  ({ id: abeAgent } = await enroll(abe, 'abe'));
  personMessage = await say({ cookie: mo.cookie }, 'a person speaks');
  agentMessage = await say({ bearer: moAgentToken }, 'an agent answers');
  // A thread, mentions of a person and of an agent, and a file, for the full round trip.
  const handles = await h.pool.query<{ handle: string }>('SELECT handle FROM agents WHERE id=$1', [
    moAgent,
  ]);
  const file = await upload(h, source.communityId, source.channelId, mo.cookie, 'notes.txt', 'n');
  await post(
    h,
    source.communityId,
    source.channelId,
    { cookie: owner.cookie },
    {
      text: `thanks @${handles.rows[0].handle}, and @mo`,
      idempotencyKey: 'reply-1',
      parentEntryId: personMessage,
    }
  );
  await post(
    h,
    source.communityId,
    source.channelId,
    { cookie: mo.cookie },
    {
      text: 'the notes',
      idempotencyKey: 'file-1',
      attachmentIds: [file],
    }
  );
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe('export format 3', { timeout: 180_000 }, () => {
  // Purpose: an owner export is format 3: every member row with its kind, each agent's own row
  // with its owner and no handle or email, and every message with a member author.
  it('writes agents as members and a member author on every message', async () => {
    const archive = await openArchive(await exportSpace(source, owner.cookie));
    expect(archive.manifest.version).toBe(3);
    const members = archive
      .rows('members')
      .map((row) => CommunityExportMemberRowV3Schema.parse(row));
    const agents = archive.rows<{ id: string; owner_member_id: string }>('agents');
    expect(
      members
        .filter((row) => row.kind === 'agent')
        .map((row) => ({
          id: row.id,
          owner: row.owner_member_id,
          handle: row.handle,
          email: row.email,
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
    ).toEqual(
      agents
        .map((agent) => ({ id: agent.id, owner: agent.owner_member_id, handle: null, email: null }))
        .sort((a, b) => a.id.localeCompare(b.id))
    );
    expect(archive.manifest.counts.members).toBe(members.length);
    const entries = archive
      .rows('entries')
      .map((row) => CommunityExportEntryRowV3Schema.parse(row));
    expect(entries.find((row) => row.id === agentMessage)).toMatchObject({
      author_member_id: moAgent,
      author_agent_id: moAgent,
    });
    expect(entries.find((row) => row.id === personMessage)).toMatchObject({
      author_member_id: mo.memberId,
      author_agent_id: null,
    });
  });

  // Purpose: a person's own export lists them and their agents as members, as it holds their
  // agents and their agents' messages, and as erasing them erases those agents too. Nobody
  // else's agent is in it.
  it("lists a person's own agents as their members in a personal export", async () => {
    const archive = await openArchive(await exportSpace(source, mo.cookie, { scope: 'personal' }));
    expect(archive.manifest.scope).toBe('personal');
    expect(
      archive
        .rows<{ id: string; kind: string }>('members')
        .map((row) => [row.id, row.kind])
        .sort()
    ).toEqual(
      [
        [mo.memberId, 'person'],
        [moAgent, 'agent'],
      ].sort()
    );
    expect(archive.rows<{ id: string }>('agents').map((row) => row.id)).toEqual([moAgent]);
    expect(archive.rows<{ id: string }>('members').map((row) => row.id)).not.toContain(abeAgent);
  });

  // Purpose: a format 3 export imports on this release with the same people, agent members (built
  // by the trigger from the agents collection, with the agent's id and owner) and authors, and
  // the import report says format 3 and counts people only as historical members.
  it('round-trips format 3 on this release', async () => {
    const bytes = await exportSpace(source, owner.cookie);
    const archive = await openArchive(bytes);
    const imported = await importArchive(bytes);
    const report = await readImport(h, imported.importId, key);
    expect(report.state).toBe('ready');
    const memberRows = archive.rows<{ id: string; kind: string }>('members');
    expect(report.report).toMatchObject({
      manifestVersion: 3,
      historicalMembers: memberRows.filter((row) => row.kind === 'person').length,
      historicalAgents: archive.rows('agents').length,
    });
    const ids = [
      ...memberRows.map((row) => row.id),
      ...archive.rows<{ id: string }>('entries').map((row) => row.id),
    ];
    const restored = await restoredShape(imported.communityId, imported.derive, ids);
    expect(restored.members.filter((row) => row.kind === 'agent')).toEqual(
      memberRows
        .filter((row) => row.kind === 'agent')
        .map((row) =>
          expect.objectContaining({ id: row.id, owner_member_id: (row as Row).owner_member_id })
        )
    );
    expect(restored.members).toHaveLength(memberRows.length);
    expect(restored.entries).toEqual(
      archive
        .rows<Row>('entries')
        .map((row) => ({
          id: row.id,
          author_member_id: row.author_member_id,
          author_agent_id: row.author_agent_id,
          text: row.text,
        }))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    );
  });

  // Purpose: format 3 out, imported, and format 3 out again: every person, agent member, agent,
  // message author, mention, thread link and file comes back the same through the derived ids.
  it('round-trips format 3 through an import and a re-export, threads, mentions and files too', async () => {
    const first = await openArchive(await exportSpace(source, owner.cookie));
    const imported = await importArchive(await exportSpace(source, owner.cookie));
    expect((await readImport(h, imported.importId, key)).state).toBe('ready');
    const claimant = await claim(imported.communityId, 'claimant-round');
    const again = await openArchive(
      await exportSpace({ base: `/api/v1/communities/${imported.communityId}` }, claimant.cookie)
    );
    expect(again.manifest.version).toBe(3);
    const d = imported.derive;
    const opt = (id: unknown) => (id ? d(id as string) : null);
    const byId = <T extends Row>(rows: T[]) => new Map(rows.map((row) => [row.id as string, row]));

    const members = byId(again.rows<Row>('members'));
    for (const row of first.rows<Row>('members'))
      expect(members.get(d(row.id as string)), String(row.id)).toMatchObject({
        kind: row.kind,
        owner_member_id: opt(row.owner_member_id),
        display_name: row.display_name,
        role: row.role,
      });
    const agents = byId(again.rows<Row>('agents'));
    for (const row of first.rows<Row>('agents'))
      expect(agents.get(d(row.id as string))).toMatchObject({
        owner_member_id: d(row.owner_member_id as string),
        display_name: row.display_name,
        handle: row.handle,
      });
    const entries = byId(again.rows<Row>('entries'));
    let mentions = 0;
    let replies = 0;
    for (const row of first.rows<Row>('entries')) {
      mentions += (row.mentions as string[]).length;
      if (row.parent_entry_id) replies++;
      expect(entries.get(d(row.id as string)), String(row.text)).toMatchObject({
        author_member_id: d(row.author_member_id as string),
        author_agent_id: opt(row.author_agent_id),
        text: row.text,
        mentions: (row.mentions as string[]).map((id) => d(id)),
        parent_entry_id: opt(row.parent_entry_id),
        thread_root_entry_id: opt(row.thread_root_entry_id),
      });
    }
    expect(mentions).toBeGreaterThanOrEqual(2);
    expect(replies).toBeGreaterThanOrEqual(1);
    const files = byId(again.rows<Row>('attachments'));
    const firstFiles = first.rows<Row>('attachments');
    expect(firstFiles.length).toBeGreaterThanOrEqual(1);
    for (const row of firstFiles) {
      const back = files.get(d(row.id as string))!;
      expect(back).toMatchObject({
        entryId: d(row.entryId as string),
        uploaderMemberId: opt(row.uploaderMemberId),
        uploaderAgentId: opt(row.uploaderAgentId),
        name: row.name,
        checksum: row.checksum,
        byteSize: row.byteSize,
      });
      expect(again.files.get(back.archivePath as string)).toEqual(
        first.files.get(row.archivePath as string)
      );
    }
  });

  // Purpose: a format 2 archive, this release's and v0.117.0's (whose agent rows have no
  // availability fields), imports on this release with an agent member built for each agent and
  // each agent message naming it, and the space then exports as format 3 with every person, agent
  // member and author it had.
  it.each([
    ['this release', false],
    ['v0.117.0, without availability fields', true],
  ])('imports a format 2 archive from %s and re-exports it as format 3', async (_, old) => {
    const written = await exportSpace(source, owner.cookie, { format: 2 });
    const opened = await openArchive(written);
    expect(opened.manifest.version).toBe(2);
    // v0.117.0 wrote format 2 without the agents' availability fields (#2930 added them).
    const bytes = old
      ? rebuilt(opened, (name, lines) =>
          name.startsWith('agents/')
            ? lines.map(({ runs_on: _runsOn, last_seen_at: _lastSeen, ...agent }) => agent)
            : lines
        )
      : written;
    const imported = await importArchive(bytes);
    const report = await readImport(h, imported.importId, key);
    expect(report.state).toBe('ready');
    expect(report.report).toMatchObject({ manifestVersion: 2 });
    const claimant = await claim(imported.communityId, `claimant-${old ? 'old' : 'new'}`);
    const again = await openArchive(
      await exportSpace({ base: `/api/v1/communities/${imported.communityId}` }, claimant.cookie)
    );
    expect(again.manifest.version).toBe(3);
    const derive = imported.derive;
    const agentRows = again.rows<{ id: string; kind: string; owner_member_id: string | null }>(
      'members'
    );
    expect(
      agentRows
        .filter((row) => row.kind === 'agent')
        .map((row) => [row.id, row.owner_member_id])
        .sort()
    ).toEqual(
      opened
        .rows<{ id: string; owner_member_id: string }>('agents')
        .map((agent) => [derive(agent.id), derive(agent.owner_member_id)])
        .sort()
    );
    const people = opened.rows<{ id: string }>('members').map((row) => derive(row.id));
    for (const id of people) expect(agentRows.map((row) => row.id)).toContain(id);
    const entries = new Map(again.rows<Row>('entries').map((row) => [row.id, row]));
    for (const entry of opened.rows<Row>('entries'))
      expect(entries.get(derive(entry.id as string))).toMatchObject({
        author_member_id: derive((entry.author_member_id ?? entry.author_agent_id) as string),
        author_agent_id: entry.author_agent_id ? derive(entry.author_agent_id as string) : null,
        text: entry.text,
      });
  });

  // Purpose: rows that cannot be right are refused as IMPORT_ARCHIVE_INVALID, never read as a
  // storage failure, and the import's unclaimed space is torn down to nothing: format 3's own
  // rules on agent member rows and authors; an agent's message passed off as a person's (both
  // formats); and an agent owned by an agent, or by someone outside the export (both formats),
  // which 0042's trigger refuses as a foreign-key violation.
  it.each([
    [
      3,
      "an agent's message that names only the agent's member row",
      (name: string, lines: Row[]) =>
        name.startsWith('entries/')
          ? lines.map((entry) =>
              entry.id === agentMessage ? { ...entry, author_agent_id: null } : entry
            )
          : lines,
    ],
    [
      2,
      "an agent's message that names the agent as a member",
      (name: string, lines: Row[]) =>
        name.startsWith('entries/')
          ? lines.map((entry) =>
              entry.id === agentMessage
                ? { ...entry, author_member_id: moAgent, author_agent_id: null }
                : entry
            )
          : lines,
    ],
    [
      3,
      'an agent owned by an agent',
      (name: string, lines: Row[]) =>
        name.startsWith('members/') || name.startsWith('agents/')
          ? lines.map((row) => (row.id === abeAgent ? { ...row, owner_member_id: moAgent } : row))
          : lines,
    ],
    [
      3,
      'an agent owned by someone outside the export',
      (name: string, lines: Row[]) =>
        name.startsWith('members/') || name.startsWith('agents/')
          ? lines.map((row) => (row.id === abeAgent ? { ...row, owner_member_id: OUTSIDE } : row))
          : lines,
    ],
    [
      2,
      'an agent owned by someone outside the export',
      (name: string, lines: Row[]) =>
        name.startsWith('agents/')
          ? lines.map((row) => (row.id === abeAgent ? { ...row, owner_member_id: OUTSIDE } : row))
          : lines,
    ],
  ] as const)('refuses, in format %i, %s', async (format, _, change) => {
    const opened = await openArchive(await exportSpace(source, owner.cookie, { format }));
    expect(opened.manifest.version).toBe(format);
    const imported = await importArchive(rebuilt(opened, change));
    expect(await readImport(h, imported.importId, key)).toMatchObject({
      state: 'failed',
      failureCode: 'IMPORT_ARCHIVE_INVALID',
    });
    await expectNothingLeft(imported.communityId);
  });

  // Purpose: format 3's own rules on rows: an agent member row whose owner is not its agent's, a
  // message whose agent is not its member author, or an agent member row with a handle, is
  // refused, and leaves nothing.
  it.each([
    [
      "an agent member row whose owner is not its agent's",
      (name: string, lines: Row[]) =>
        name.startsWith('members/')
          ? lines.map((row) =>
              row.id === abeAgent ? { ...row, owner_member_id: mo.memberId } : row
            )
          : lines,
    ],
    [
      'an agent message naming another member',
      (name: string, lines: Row[]) =>
        name.startsWith('entries/')
          ? lines.map((entry) =>
              entry.id === agentMessage ? { ...entry, author_member_id: mo.memberId } : entry
            )
          : lines,
    ],
    [
      'an agent member row with a handle',
      (name: string, lines: Row[]) =>
        name.startsWith('members/')
          ? lines.map((row) => (row.id === moAgent ? { ...row, handle: 'sneaky' } : row))
          : lines,
    ],
  ])('refuses %s', async (_, change) => {
    const opened = await openArchive(await exportSpace(source, owner.cookie));
    const imported = await importArchive(rebuilt(opened, change));
    const report = await readImport(h, imported.importId, key);
    expect(report).toMatchObject({ state: 'failed', failureCode: 'IMPORT_ARCHIVE_INVALID' });
    await expectNothingLeft(imported.communityId);
  });

  // Purpose: the importer v0.117.0 runs refuses a format 3 archive by name, so an older host
  // never half-reads one.
  it('is refused by the importer v0.117.0 runs, as an unsupported version', async () => {
    const bytes = await exportSpace(source, owner.cookie);
    await expect(readManifestVersionV0117(bufferReader(bytes))).rejects.toMatchObject({
      code: 'IMPORT_VERSION_UNSUPPORTED',
    });
  });
});
