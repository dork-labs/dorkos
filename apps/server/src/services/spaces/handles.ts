import type { PoolClient } from 'pg';
import { deriveHandle } from '@dorkos/shared/handle';

/** Reserve a collision-safe community handle inside the caller's transaction. */
export async function mintHandle(
  client: PoolClient,
  communityId: string,
  name: string
): Promise<string> {
  await client.query('SELECT pg_advisory_xact_lock(77281504)');
  const result = await client.query<{ handle: string }>(
    'SELECT handle FROM community_handles WHERE community_id=$1',
    [communityId]
  );
  const taken = new Set(result.rows.map((row) => row.handle));
  return deriveHandle(name, taken) ?? deriveHandle('member', taken)!;
}
