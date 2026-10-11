import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Db } from './index.js';
import {
  docs,
  consolidatedDoc,
  reportBack,
  publishedRoom,
  publishedRoom151,
  agentReports,
  reviewedSql,
  refuse,
  type MigrationEntry,
  type MigrationRow,
} from './doc-migration-identities.js';
import { requirePublishedMigrationOwner } from './doc-migration-history.js';
import { verifyCanonicalSchema } from './doc-migration-schema.js';

/**
 * Recognize only the exact published Room150/151 histories before timestamp-based migration.
 * Both may suppress shipped Main DDL. Install missing exact Main steps and move the original
 * Room watermark atomically; row identity/hash remain intact and Room DDL is never replayed.
 */
export function bridgePublishedRoomMigration(ownerKey: object): boolean {
  const { db, folder, rows } = requirePublishedMigrationOwner(ownerKey);
  const published = [publishedRoom, publishedRoom151];
  const oldRows = rows.filter((row) =>
    published.some((entry) => row.hash === entry.hash && row.created_at === entry.when)
  );
  const journal = JSON.parse(readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8')) as {
    entries: MigrationEntry[];
  };
  const shipped = [reportBack, agentReports];
  const canonical = new Map(
    journal.entries.slice(150).map((entry) => [
      createHash('sha256')
        .update(readFileSync(path.join(folder, `${entry.tag}.sql`)))
        .digest('hex'),
      entry.when,
    ])
  );
  if (!oldRows.length) {
    if (
      rows.some(
        (row) => row.created_at >= reportBack.when && canonical.get(row.hash) !== row.created_at
      )
    )
      refuse('unrecognized published or newer watermark');
    const completed = rows.filter((row) => row.hash === consolidatedDoc.hash);
    if (!completed.length) return false;
    reviewedSql(folder, consolidatedDoc);
    if (completed.length !== 1 || completed[0]!.created_at !== consolidatedDoc.when)
      refuse('canonical Room completion differs');
    let previousIdentity = 0;
    for (const entry of journal.entries.slice(0, 150)) {
      const hash = createHash('sha256')
        .update(readFileSync(path.join(folder, `${entry.tag}.sql`)))
        .digest('hex');
      const matching = rows.filter((row) => row.hash === hash);
      if (
        matching.length !== 1 ||
        matching[0]!.created_at !== entry.when ||
        matching[0]!.rowIdentity <= previousIdentity ||
        matching[0]!.rowIdentity >= completed[0]!.rowIdentity
      )
        refuse('canonical Room shipped prefix differs');
      previousIdentity = matching[0]!.rowIdentity;
    }
    let previousShippedIdentity = previousIdentity;
    for (const entry of shipped) {
      reviewedSql(folder, entry);
      const matching = rows.filter((row) => row.hash === entry.hash);
      if (
        matching.length !== 1 ||
        matching[0]!.created_at !== entry.when ||
        matching[0]!.rowIdentity <= previousShippedIdentity
      )
        refuse('canonical Room completion lacks exact shipped Main history');
      previousShippedIdentity = matching[0]!.rowIdentity;
    }
    const known = new Map(
      journal.entries.map((entry) => [
        createHash('sha256')
          .update(readFileSync(path.join(folder, `${entry.tag}.sql`)))
          .digest('hex'),
        entry.when,
      ])
    );
    for (const doc of docs) known.set(doc.hash, doc.when);
    if (
      rows.some(
        (row) =>
          known.get(row.hash) !== row.created_at ||
          rows.filter((other) => other.hash === row.hash).length !== 1
      )
    )
      refuse('canonical Room history has unknown or duplicate rows');
    // Future schema is admitted only by an exact, ordered, actually recorded prefix.
    // Pending later journal entries must not change the restart reference schema.
    let futureGap = false;
    let referenceEnd = consolidatedDoc.idx + 1;
    let futureIdentity = Math.max(completed[0]!.rowIdentity, previousShippedIdentity);
    let futureStamp = consolidatedDoc.when;
    const referenceHashes = new Set(
      journal.entries.slice(0, referenceEnd).map((entry) =>
        createHash('sha256')
          .update(readFileSync(path.join(folder, `${entry.tag}.sql`)))
          .digest('hex')
      )
    );
    for (const [offset, entry] of journal.entries.slice(referenceEnd).entries()) {
      const hash = createHash('sha256')
        .update(readFileSync(path.join(folder, `${entry.tag}.sql`)))
        .digest('hex');
      if (
        entry.idx !== consolidatedDoc.idx + 1 + offset ||
        entry.when <= futureStamp ||
        referenceHashes.has(hash)
      )
        refuse('future canonical journal is not an ordered unique prefix');
      referenceHashes.add(hash);
      futureStamp = entry.when;
      const matching = rows.filter((row) => row.hash === hash);
      if (!matching.length) {
        futureGap = true;
        continue;
      }
      if (
        futureGap ||
        matching.length !== 1 ||
        matching[0]!.created_at !== entry.when ||
        matching[0]!.rowIdentity <= futureIdentity
      )
        refuse('future canonical history is not an exact recorded prefix');
      futureIdentity = matching[0]!.rowIdentity;
      referenceEnd = entry.idx + 1;
    }
    verifyCanonicalSchema(db, folder, undefined, [], referenceEnd);
    return false;
  }
  if (oldRows.length !== 1) refuse('published Room bookkeeping differs');
  const original = oldRows[0]!;
  const legacy = published.find(
    (entry) => entry.hash === original.hash && entry.when === original.created_at
  )!;
  if (consolidatedDoc.idx !== 152 || consolidatedDoc.when <= publishedRoom151.when)
    refuse('new Doc migration does not follow both published Room watermarks');
  if (consolidatedDoc.hash !== legacy.hash)
    refuse('canonical Room SQL identity differs from reviewed published SQL');
  reviewedSql(folder, consolidatedDoc);
  const shippedSql = shipped.map((entry) => reviewedSql(folder, entry));
  const archived = readFileSync(path.join(folder, 'legacy-doc', `${legacy.tag}.sql`));
  if (createHash('sha256').update(archived).digest('hex') !== legacy.hash)
    refuse('archived published Room SQL differs');
  const expected = new Map<string, Set<number>>();
  const allow = (hash: string, stamp: number) => {
    const stamps = expected.get(hash) ?? new Set<number>();
    stamps.add(stamp);
    expected.set(hash, stamps);
  };
  let previousIdentity = 0;
  for (const entry of journal.entries.slice(0, 150)) {
    const hash = createHash('sha256')
      .update(readFileSync(path.join(folder, `${entry.tag}.sql`)))
      .digest('hex');
    const matching = rows.filter((row) => row.hash === hash);
    if (
      matching.length !== 1 ||
      matching[0]!.created_at !== entry.when ||
      matching[0]!.rowIdentity <= previousIdentity ||
      matching[0]!.rowIdentity >= original.rowIdentity
    )
      refuse('published Room shipped prefix differs');
    previousIdentity = matching[0]!.rowIdentity;
    allow(hash, entry.when);
  }
  const historical = docs.map((doc) => rows.filter((row) => row.hash === doc.hash));
  if (
    historical.some((matching) => matching.length) &&
    historical.some(
      (matching, i) =>
        matching.length !== 1 ||
        matching[0]!.created_at !== docs[i]!.when ||
        matching[0]!.rowIdentity >= original.rowIdentity ||
        (i > 0 && matching[0]!.rowIdentity <= historical[i - 1]![0]!.rowIdentity)
    )
  )
    refuse('published Room historical Doc prefix differs');
  for (const doc of docs) allow(doc.hash, doc.when);
  allow(legacy.hash, legacy.when);
  for (const entry of journal.entries.slice(150)) {
    const hash = createHash('sha256')
      .update(readFileSync(path.join(folder, `${entry.tag}.sql`)))
      .digest('hex');
    allow(hash, entry.when);
  }
  if (
    rows.some(
      (row) =>
        !expected.get(row.hash)?.has(row.created_at) ||
        rows.filter((other) => other.hash === row.hash).length !== 1
    )
  )
    refuse('unrecognized or duplicate published Room history');
  const shippedRows = shipped.map((entry) => rows.filter((row) => row.hash === entry.hash));
  // Old151 may retain the original Room row before the appended Main150 row.
  if (legacy === publishedRoom151 && shippedRows[0]!.length !== 1)
    refuse('published Room151 lacks exact shipped Main150 history');
  let precedingIdentity = previousIdentity;
  let missing = false;
  for (const [i, matching] of shippedRows.entries()) {
    if (!matching.length) {
      missing = true;
      continue;
    }
    if (
      missing ||
      matching[0]!.created_at !== shipped[i]!.when ||
      matching[0]!.rowIdentity <= precedingIdentity ||
      (shipped[i]!.idx >= legacy.idx && matching[0]!.rowIdentity <= original.rowIdentity)
    )
      refuse('published Room shipped completion has a gap');
    precedingIdentity = matching[0]!.rowIdentity;
  }
  const futureHashes = journal.entries.slice(consolidatedDoc.idx + 1).map((entry) =>
    createHash('sha256')
      .update(readFileSync(path.join(folder, `${entry.tag}.sql`)))
      .digest('hex')
  );
  if (rows.some((row) => futureHashes.includes(row.hash)))
    refuse('future migration precedes canonical Room completion');
  db.$client.transaction(() => {
    // Exact history selects the authentic pre-upgrade schema; columns alone never authorize DDL.
    verifyCanonicalSchema(
      db,
      folder,
      legacy,
      shipped.filter((_, i) => shippedRows[i]!.length > 0)
    );
    for (const [i, entry] of shipped.entries()) {
      if (shippedRows[i]!.length) continue;
      for (const statement of shippedSql[i]!.toString('utf8').split('--> statement-breakpoint'))
        if (statement.trim()) db.$client.exec(statement);
      db.$client
        .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
        .run(entry.hash, entry.when);
    }
    verifyCanonicalSchema(db, folder);
    if (
      db.$client
        .prepare(
          'UPDATE __drizzle_migrations SET created_at = ? WHERE rowid = ? AND hash = ? AND created_at = ?'
        )
        .run(consolidatedDoc.when, original.rowIdentity, legacy.hash, legacy.when).changes !== 1
    )
      refuse('exact published Room row changed before canonical timestamp move');
  })();
  return true;
}
