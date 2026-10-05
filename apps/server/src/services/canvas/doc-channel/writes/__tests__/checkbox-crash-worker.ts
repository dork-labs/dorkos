/** Genuine persistent consumed approval; SIGKILL, not a caught exception, creates process loss. */
import { fixture } from './checkbox-fixture.js';
import { once } from 'node:events';
import type { CheckboxRequest } from '../checkbox-service.js';
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
