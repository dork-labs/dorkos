/**
 * Migration 0050 (DOR-3624): reports of a member. Proves the rules the table itself holds, so a
 * route with a bug still cannot store a self-report, a second open report, or a broken resolution.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrate } from '../migrate.js';
import { huskModerationRecords } from '../moderation/erasure.js';

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for real Postgres tests');
const admin = new Pool({ connectionString: adminUrl });
const name = `community_member_reports_${randomUUID().replaceAll('-', '')}`;
let db: Pool;
let spaceA = '';
let spaceB = '';
let ann = '';
let bea = '';
let otherSpaceMember = '';

async function member(communityId: string, label: string): Promise<string> {
  const userId = randomUUID();
  await db.query(`INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$2,$3,true)`, [
    userId,
    label,
    `${label}-${userId}@example.test`,
  ]);
  const row = await db.query<{ id: string }>(
    `INSERT INTO members(community_id,user_id,display_name,handle,role)
     VALUES($1,$2,$3,$4,'member') RETURNING id`,
    [communityId, userId, label, `${label}-${userId.slice(0, 8)}`]
  );
  return row.rows[0].id;
}

const report = (subject: string, reporter: string | null, communityId = spaceA) =>
  db.query<{ id: string }>(
    `INSERT INTO member_reports(community_id,subject_member_id,reporter_member_id,reason)
     VALUES($1,$2,$3,'harassment') RETURNING id`,
    [communityId, subject, reporter]
  );

beforeAll(async () => {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE ${name}`);
  await migrate(url.toString());
  db = new Pool({ connectionString: url.toString() });
  const space = async (label: string) =>
    (
      await db.query<{ id: string }>(
        "INSERT INTO communities(name,lifecycle) VALUES($1,'pending_owner') RETURNING id",
        [label]
      )
    ).rows[0].id;
  spaceA = await space('A');
  spaceB = await space('B');
  ann = await member(spaceA, 'ann');
  bea = await member(spaceA, 'bea');
  otherSpaceMember = await member(spaceB, 'cy');
}, 60_000);

afterAll(async () => {
  await db?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
});

describe('member_reports (0050)', () => {
  it('refuses a report of yourself', async () => {
    await expect(report(ann, ann)).rejects.toThrow(/member_reports_not_self/u);
  });

  it('refuses a person from another space, as subject or as reporter', async () => {
    await expect(report(otherSpaceMember, ann)).rejects.toThrow(/subject_tenant_fk/u);
    await expect(report(ann, otherSpaceMember)).rejects.toThrow(/reporter_tenant_fk/u);
  });

  it('holds one open report per reporter and person, and allows another once resolved', async () => {
    const first = await report(bea, ann);
    await expect(report(bea, ann)).rejects.toThrow(/member_reports_open_once/u);
    await db.query(
      "UPDATE member_reports SET status='dismissed',resolved_at=now(),resolver_member_id=$2 WHERE id=$1",
      [first.rows[0].id, ann]
    );
    expect((await report(bea, ann)).rowCount).toBe(1);
  });

  it('allows a report with no reporter only as an import that left it out', async () => {
    await expect(report(ann, null)).rejects.toThrow(/member_reports_reporter_shape/u);
    const imported = () =>
      db.query(
        `INSERT INTO member_reports(community_id,subject_member_id,reason,origin)
         VALUES($1,$2,'other','imported')`,
        [spaceA, ann]
      );
    expect((await imported()).rowCount).toBe(1);
    expect((await imported()).rowCount).toBe(1);
  });

  it('clears the note when the reporter or the person reported is erased, keeping the record', async () => {
    const dee = await member(spaceA, 'dee');
    const eli = await member(spaceA, 'eli');
    const fay = await member(spaceA, 'fay');
    const noted = (subject: string, reporter: string) =>
      db.query<{ id: string }>(
        `INSERT INTO member_reports(community_id,subject_member_id,reporter_member_id,reason,note)
         VALUES($1,$2,$3,'other','A note') RETURNING id`,
        [spaceA, subject, reporter]
      );
    const byDee = (await noted(eli, dee)).rows[0].id;
    const aboutDee = (await noted(dee, fay)).rows[0].id;
    const neither = (await noted(eli, fay)).rows[0].id;
    const client = await db.connect();
    try {
      await huskModerationRecords(client, spaceA, dee);
    } finally {
      client.release();
    }
    const notes = await db.query<{ id: string; note: string | null; reason: string }>(
      'SELECT id,note,reason FROM member_reports WHERE id=ANY($1::uuid[])',
      [[byDee, aboutDee, neither]]
    );
    const noteOf = (id: string) => notes.rows.find((row) => row.id === id);
    expect(noteOf(byDee)).toMatchObject({ note: null, reason: 'other' });
    expect(noteOf(aboutDee)).toMatchObject({ note: null, reason: 'other' });
    expect(noteOf(neither)).toMatchObject({ note: 'A note' });
  });

  it('is deleted before the members it names when a space goes', async () => {
    // The deletion worker's order: a row here must not outlast, or block, the members' delete.
    const source = await readFile(join(import.meta.dirname, '../deletion-worker.ts'), 'utf8');
    expect(source.indexOf("'member_reports'")).toBeGreaterThan(-1);
    expect(source.indexOf("'member_reports'")).toBeLessThan(source.indexOf('DELETE FROM members'));
  });

  it('keeps a resolution whole, with only the actions a person can take', async () => {
    const { rows } = await report(ann, bea);
    await expect(
      db.query("UPDATE member_reports SET status='actioned' WHERE id=$1", [rows[0].id])
    ).rejects.toThrow(/member_reports_status_shape/u);
    await expect(
      db.query(
        "UPDATE member_reports SET status='actioned',action='remove',resolved_at=now() WHERE id=$1",
        [rows[0].id]
      )
    ).rejects.toThrow(/member_reports_action_check/u);
  });

  it('makes every native action record who took it; an import may not know', async () => {
    const { rows } = await report(await member(spaceA, 'gus'), ann);
    await expect(
      db.query(
        "UPDATE member_reports SET status='actioned',action='mute',resolved_at=now() WHERE id=$1",
        [rows[0].id]
      )
    ).rejects.toThrow(/member_reports_status_shape/u);
    await db.query(
      `UPDATE member_reports SET status='actioned',action='mute',resolved_at=now(),
         resolver_member_id=$2 WHERE id=$1`,
      [rows[0].id, ann]
    );
    const imported = await db.query(
      `INSERT INTO member_reports(community_id,subject_member_id,reason,status,action,origin,
         resolved_at) VALUES($1,$2,'other','actioned','ban','imported',now())`,
      [spaceA, ann]
    );
    expect(imported.rowCount).toBe(1);
  });
});
