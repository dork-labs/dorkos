import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Pool } from 'pg';
import { createCommunityApp } from './app.js';
import { parseConfig } from './config.js';
import { migrate } from './migrate.js';
import { createSignalHandler, createStop } from './shutdown.js';
import { reservedBoundShortNames, shortNameHoldKey } from './host/short-names.js';
import { registerShortNamePages } from './short-names/pages.js';
import { createBlobStore } from './storage/index.js';
import { sweepExpiredAttachments } from './routes/attachments.js';
import { sweepExpiredExports } from './routes/exports.js';
import { sweepExpiredAdmissions } from './routes/invites.js';
import { sweepPendingBlobDeletions } from './storage/pending-deletions.js';
import { sweepCommunityDeletions, sweepCommunityDeletionTombstones } from './deletion-worker.js';
import { ERASURE_POLL_MS, pruneErasureRequests, sweepErasures } from './erasure/worker.js';
import { sweepExpiredPairings } from './routes/pairings.js';
import {
  createEvidenceSink,
  FileSystemEvidenceSink,
  sweepEvidenceStagingFolders,
} from './takedown/evidence/sink.js';
import { sweepTakedownEvidence } from './takedown/worker.js';

const config = parseConfig(process.env);
await migrate(config.databaseUrl);
const pool = new Pool({ connectionString: config.databaseUrl });
// A database restart or failover drops idle connections. The pool has already discarded the
// broken one and opens a fresh one for the next query, so log it rather than crash the server.
pool.on('error', (error: Error & { code?: string }) => {
  console.error('Community database connection lost', error.code ?? error.name);
});
const blobStore = createBlobStore(config);
const evidenceSink = createEvidenceSink(config.evidence);
// A write that stopped midway leaves a temporary file in the evidence folder; remove the old ones.
// They are the only files the server ever deletes there.
if (evidenceSink instanceof FileSystemEvidenceSink) await evidenceSink.sweepTemporaryFiles();
// The S3 sink stages each file in the temporary folder; a crash can leave one behind.
else if (evidenceSink) await sweepEvidenceStagingFolders();
const app = createCommunityApp({ config, pool, blobStore });
const staticRoot = fileURLToPath(new URL('../dist/', import.meta.url));
app.use('/assets/*', serveStatic({ root: staticRoot }));
app.get('/', serveStatic({ path: fileURLToPath(new URL('../dist/index.html', import.meta.url)) }));
app.get(
  '/host',
  serveStatic({ path: fileURLToPath(new URL('../dist/index.html', import.meta.url)) })
);
app.get(
  '/join',
  serveStatic({ path: fileURLToPath(new URL('../dist/index.html', import.meta.url)) })
);
app.get(
  '/claim',
  serveStatic({ path: fileURLToPath(new URL('../dist/index.html', import.meta.url)) })
);
app.get(
  '/pairing',
  serveStatic({ path: fileURLToPath(new URL('../dist/index.html', import.meta.url)) })
);
app.get(
  '/c/:communityId',
  serveStatic({ path: fileURLToPath(new URL('../dist/index.html', import.meta.url)) })
);
app.get(
  '/c/:communityId/*',
  serveStatic({ path: fileURLToPath(new URL('../dist/index.html', import.meta.url)) })
);
registerShortNamePages(app, {
  indexPath: fileURLToPath(new URL('../dist/index.html', import.meta.url)),
  reservedNames: config.reservedShortNames,
});
// A name a community already holds may have become reserved since, by an upgrade or the host's
// own list; that address no longer opens the community, so say so where the host will see it.
for (const bound of await reservedBoundShortNames(pool, config.reservedShortNames)) {
  console.warn(
    `Community ${bound.communityId} has the web address /${bound.shortName}, which is now reserved and no longer opens it. Give the community another address on the host page.`
  );
}
const shortNameHolds = {
  key: shortNameHoldKey(config.authSecret),
  cooloffDays: config.limits.shortNameCooloffDays,
};
const server = serve({ fetch: app.fetch, port: config.port });
const cleanup = setInterval(() => {
  void sweepExpiredAttachments(pool, blobStore).catch((error: unknown) => {
    console.error(
      'Community attachment cleanup unavailable',
      error instanceof Error ? error.name : 'unknown'
    );
  });
  void sweepExpiredExports(pool, blobStore).catch((error: unknown) => {
    console.error(
      'Community export cleanup unavailable',
      error instanceof Error ? error.name : 'unknown'
    );
  });
  void sweepExpiredAdmissions(pool).catch((error: unknown) => {
    console.error(
      'Community admission cleanup unavailable',
      error instanceof Error ? error.name : 'unknown'
    );
  });
  void sweepPendingBlobDeletions(pool, blobStore).catch((error: unknown) => {
    console.error(
      'Community pending blob cleanup unavailable',
      error instanceof Error ? error.name : 'unknown'
    );
  });
  void sweepCommunityDeletions(pool, blobStore, undefined, { shortNameHolds }).catch(
    (error: unknown) => {
      console.error(
        'Community deletion unavailable',
        error instanceof Error ? error.name : 'unknown'
      );
    }
  );
  void sweepCommunityDeletionTombstones(pool).catch((error: unknown) => {
    console.error(
      'Community deletion receipt cleanup unavailable',
      error instanceof Error ? error.name : 'unknown'
    );
  });
  void sweepExpiredPairings(pool).catch((error: unknown) => {
    console.error(
      'Community pairing cleanup unavailable',
      error instanceof Error ? error.name : 'unknown'
    );
  });
  void pruneErasureRequests(pool).catch((error: unknown) => {
    console.error(
      'Community erasure record cleanup unavailable',
      error instanceof Error ? error.name : 'unknown'
    );
  });
}, 60_000);
cleanup.unref();
let erasing = false;
const erasures = setInterval(() => {
  if (erasing) return;
  erasing = true;
  void (async () => {
    // Drain what is due, a bounded number per tick so one tick never runs unbounded.
    for (let claimed = 0; claimed < 10; claimed++) {
      const result = await sweepErasures(pool, { journalPath: config.erasureJournal });
      if (!result.claimed) break;
    }
  })()
    .catch((error: unknown) => {
      console.error(
        'Community erasure unavailable',
        error instanceof Error ? error.name : 'unknown'
      );
    })
    .finally(() => {
      erasing = false;
    });
}, ERASURE_POLL_MS);
erasures.unref();
let copyingEvidence = false;
const takedownEvidence = setInterval(() => {
  if (copyingEvidence) return;
  copyingEvidence = true;
  void sweepTakedownEvidence(pool, blobStore, evidenceSink, {
    alertHours: config.limits.takedownEvidenceAlertHours,
  })
    .catch((error: unknown) => {
      console.error(
        'Community takedown evidence unavailable',
        error instanceof Error ? error.name : 'unknown'
      );
    })
    .finally(() => {
      copyingEvidence = false;
    });
}, 15_000);
takedownEvidence.unref();
const onSignal = createSignalHandler(
  createStop({ server, pool, timers: [cleanup, erasures, takedownEvidence] })
);
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
