import type { PoolClient } from 'pg';
import { dropSegments, endExportJob } from '../exports/store.js';

/**
 * Queue a new evidence export for a whole-community takedown and link it to the takedown. The
 * export worker builds it like an owner export of the whole community; nobody can list or
 * download it, and the takedown worker copies it to the evidence store.
 *
 * @returns The new export's id.
 */
export async function queueEvidenceExport(
  client: PoolClient,
  takedown: { id: string; communityId: string }
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO export_archives(community_id,requester_member_id,scope,format_version,state,
       evidence_takedown_id)
     VALUES($1,NULL,'evidence',2,'queued',$2) RETURNING id`,
    [takedown.communityId, takedown.id]
  );
  await client.query('UPDATE community_takedowns SET evidence_export_id=$2 WHERE id=$1', [
    takedown.id,
    inserted.rows[0].id,
  ]);
  return inserted.rows[0].id;
}

/**
 * Let go of a takedown's evidence export, whatever state it is in: one still being built is
 * cancelled, and a finished one has its segments queued for deletion and its row removed. Used
 * once the copy is stored, and when a copy is given up.
 */
export async function dropEvidenceExport(
  client: PoolClient,
  takedown: { id: string; communityId: string },
  now: Date
): Promise<void> {
  const exports = await client.query<{ id: string; state: string }>(
    `SELECT id,state FROM export_archives
     WHERE community_id=$1 AND scope='evidence' AND evidence_takedown_id=$2 FOR UPDATE`,
    [takedown.communityId, takedown.id]
  );
  for (const job of exports.rows) {
    if (job.state === 'queued' || job.state === 'building')
      await endExportJob(client, job.id, { state: 'cancelled' }, now);
    else await dropSegments(client, job.id, takedown.communityId);
    await client.query('DELETE FROM export_archives WHERE id=$1', [job.id]);
  }
  await client.query('UPDATE community_takedowns SET evidence_export_id=NULL WHERE id=$1', [
    takedown.id,
  ]);
}
