/** Genuine persistent consumed approval; SIGKILL, not a caught exception, creates process loss. */
import { fixture } from './checkbox-fixture.js';
import type { CheckboxRequest } from '../checkbox-service.js';
const point = process.argv[2];
const seed = JSON.parse(process.argv[3]!) as {
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
