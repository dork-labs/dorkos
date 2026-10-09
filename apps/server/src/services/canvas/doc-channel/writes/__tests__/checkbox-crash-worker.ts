/** Genuine persistent consumed approval; SIGKILL, not a caught exception, creates process loss. */
import { once } from 'node:events';
import type { CheckboxRequest } from '../checkbox-service.js';
// Temporary fixed phase DATA: no Db, approval, effect or caller context is emitted.
const startupAt = performance.now();
const startupPhase = (phase: 'worker-entry' | 'fixture-import-start' | 'fixture-import-ready') => {
  if (process.argv[2] === '--await-original-case')
    process.send?.({ kind: 'startup-phase', phase, elapsedMs: performance.now() - startupAt });
};
startupPhase('worker-entry');
startupPhase('fixture-import-start');
const { fixture } = await import('./checkbox-fixture.js');
startupPhase('fixture-import-ready');
let point = process.argv[2];
let rawSeed = process.argv[3];
if (point === '--await-original-case') {
  if (!process.send) throw new Error('Original worker IPC is unavailable.');
  const starting = once(process, 'message');
  process.send({ kind: 'ready' });
  const [data] = await starting;
  if (
    !data ||
    typeof data !== 'object' ||
    data.kind !== 'start' ||
    !['prepared', 'staged', 'replaced'].includes(data.point) ||
    typeof data.seed !== 'string'
  )
    throw new Error('Original worker case changed.');
  point = data.point;
  rawSeed = data.seed;
}
const seed = JSON.parse(rawSeed!) as {
  dir: string;
  documentId: string;
  grantId: string;
  request: CheckboxRequest;
};
const h = await fixture(
  {
    checkpoint: async (current, intent) => {
      if (current === point) {
        process.send!({
          dir: seed.dir,
          documentId: seed.documentId,
          grantId: seed.grantId,
          eventId: intent.eventId,
        });
        await new Promise<void>(() => {});
      }
    },
  },
  seed
);
await h.service.toggle(seed.request, h.actor);
throw new Error('Crash boundary was not reached.');
