import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Pool } from 'pg';
import { createCommunityApp } from './app.js';
import { parseConfig } from './config.js';
import { oidcCallbackUrl } from './oidc.js';
import { migrate } from './migrate.js';
import { createSignalHandler, createStop } from './shutdown.js';
import { reservedBoundShortNames, shortNameHoldKey } from './host/short-names.js';
import { registerShortNamePages } from './short-names/pages.js';
import { createBlobStore } from './storage/index.js';
import { sweepExpiredAttachments } from './routes/community/attachments.js';
import { sweepExpiredExports } from './exports/sweep.js';
import { startExportWorker } from './exports/worker.js';
import { sweepExpiredAdmissions } from './routes/community/invites.js';
import { sweepPendingBlobDeletions } from './storage/pending-deletions.js';
import { sweepCommunityDeletions, sweepCommunityDeletionTombstones } from './deletion-worker.js';
import { ERASURE_POLL_MS, pruneErasureRequests, sweepErasures } from './erasure/worker.js';
import { pruneErasureJournal } from './erasure/journal.js';
import { sweepExpiredPairings } from './routes/community/pairings.js';
import { IMPORT_POLL_MS, pruneImports, sweepImports } from './imports/worker.js';
import { IMPORT_UPLOAD_LEASE_MS } from './imports/store.js';
import { sweepImportTempDirs } from './imports/upload.js';
import { configureServerTimeouts } from './http.js';
import { createEvidenceSink, tidyEvidenceSink } from './takedown/evidence/sink.js';
import { sweepTakedownEvidence } from './takedown/worker.js';
import { startMailDelivery, type NoticeComposers } from './mail/worker.js';
import { ownerReplacementComposers } from './owner-replacement/notices.js';
import { startOwnerReplacementTimeline } from './owner-replacement/worker.js';
import { pruneNoticeOutbox } from './mail/outbox.js';

const config = parseConfig(process.env);
await migrate(config.databaseUrl);
// Each running export holds one connection for its collection read (one REPEATABLE READ
// snapshot) and briefly a second to commit a segment, so the pool grows with export concurrency
// and requests keep the ten connections they had before.
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10 + 2 * config.exports.concurrency,
});
// A database restart or failover drops idle connections. The pool has already discarded the
// broken one and opens a fresh one for the next query, so log it rather than crash the server.
pool.on('error', (error: Error & { code?: string }) => {
  console.error('Community database connection lost', error.code ?? error.name);
});
const blobStore = createBlobStore(config);
const evidenceSink = createEvidenceSink(config.evidence);
await tidyEvidenceSink(evidenceSink);
// The mail worker's composers, by notice kind. The same set goes to the app, which refuses to
// start anything whose notice the worker could not compose.
const noticeComposers: NoticeComposers = { ...ownerReplacementComposers(config) };
// Whether a host may start an owner replacement. It stays off until the owner can answer the
// notice end to end: the notice's "Keep ownership" link must open a page that works. The
// server's routes for keeping ownership and for the claim are in place; task 3.1 (the
// /keep-ownership and /owner-replacement pages) turns it on. Until then the worker still sends
// the notices of any request already open, and every new request is refused.
const ownerReplacementOpen = false;
const app = createCommunityApp({
  config,
  pool,
  blobStore,
  noticeComposers,
  ownerReplacementOpen,
});
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
// The owner's object-only link from the email, and the new owner's claim link. Both carry their
// token after `#`, so it never reaches this server's logs.
app.get(
  '/keep-ownership',
  serveStatic({ path: fileURLToPath(new URL('../dist/index.html', import.meta.url)) })
);
app.get(
  '/owner-replacement',
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
if (config.oidc)
  // Discovery waits for the first sign-in, so this line is the only startup trace of the issuer.
  console.info(
    `Community single sign-on: register ${oidcCallbackUrl(config.publicUrl)} as the redirect URI`
  );
configureServerTimeouts(server);
// A crash while an export was arriving or being restored leaves its temporary folder behind.
void sweepImportTempDirs(IMPORT_UPLOAD_LEASE_MS * 2).catch(() => undefined);
let sweepingPendingBlobs = false;
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
  // One pending-deletion sweep at a time on this replica: a slow one (a batch of slow storage
  // deletes) is never joined by the next tick's, which would pick the same files.
  if (!sweepingPendingBlobs) {
    sweepingPendingBlobs = true;
    void sweepPendingBlobDeletions(pool, blobStore)
      .catch((error: unknown) => {
        console.error(
          'Community pending blob cleanup unavailable',
          error instanceof Error ? error.name : 'unknown'
        );
      })
      .finally(() => {
        sweepingPendingBlobs = false;
      });
  }
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
  void pruneImports(pool).catch((error: unknown) => {
    console.error(
      'Community import record cleanup unavailable',
      error instanceof Error ? error.name : 'unknown'
    );
  });
  void pruneErasureJournal(pool, config.erasureJournalRetentionDays).catch((error: unknown) => {
    console.error(
      'Community erasure journal cleanup unavailable',
      error instanceof Error ? error.name : 'unknown'
    );
  });
  void pruneErasureRequests(pool).catch((error: unknown) => {
    console.error(
      'Community erasure record cleanup unavailable',
      error instanceof Error ? error.name : 'unknown'
    );
  });
  void pruneNoticeOutbox(pool).catch((error: unknown) => {
    console.error(
      'Community notice cleanup unavailable',
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
// A job a stopped replica leaves behind is picked up by any replica once its lease expires.
const exports = startExportWorker({
  pool,
  blobStore,
  settings: config.exports,
  concurrency: config.exports.concurrency,
});
let importing = false;
const imports = setInterval(() => {
  if (importing) return;
  importing = true;
  void (async () => {
    // One import at a time on this replica, a bounded number per tick.
    for (let claimed = 0; claimed < 10; claimed++) {
      const result = await sweepImports(pool, blobStore, config.limits);
      if (!result.claimed) break;
    }
  })()
    .catch((error: unknown) => {
      console.error(
        'Community import unavailable',
        error instanceof Error ? error.name : 'unknown'
      );
    })
    .finally(() => {
      importing = false;
    });
}, IMPORT_POLL_MS);
imports.unref();
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
// Off unless the host configured SMTP. Each feature that queues mail adds its composers to
// `noticeComposers` above.
const mail = startMailDelivery({ config, pool, composers: noticeComposers });
// Moves owner replacements through their notice, wait, reminder, claim window, and expiry.
const ownerReplacements = startOwnerReplacementTimeline({ pool, config });
const onSignal = createSignalHandler(
  createStop({
    server,
    pool,
    timers: [
      cleanup,
      erasures,
      exports,
      imports,
      takedownEvidence,
      ownerReplacements,
      ...(mail ? [mail] : []),
    ],
  })
);
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
