/** Separate process deliberately terminated at a durable boundary; no catch simulates recovery. */
import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createDb, canvasDocGrants, eq } from '@dorkos/db';
import { DocChannelStore } from '../../store.js';
import { CanonicalFileWriteCoordinator } from '../canonical-writer.js';
import {
  DocCheckboxWriteService,
  type CheckboxRequest,
  type VerifiedCheckboxAuthority,
} from '../checkbox-service.js';
import { createServerPrincipal } from '../../../../connectors/principal/server-principal.js';
const point = process.argv[2];
const seed = JSON.parse(process.argv[3]!) as {
  dir: string;
  documentId: string;
  grantId: string;
  approved: VerifiedCheckboxAuthority;
  request: CheckboxRequest;
};
const db = createDb(join(seed.dir, 'db.sqlite')),
  store = new DocChannelStore(db);
const current = () => {
  const grant = db
    .select()
    .from(canvasDocGrants)
    .where(eq(canvasDocGrants.grantId, seed.grantId))
    .get();
  if (!grant || grant.revokedAt || store.getChannel(seed.documentId)?.closedAt !== null)
    throw new Error('Fixture authority refused');
  return seed.approved;
};
const service = new DocCheckboxWriteService(
  db,
  store,
  new CanonicalFileWriteCoordinator({
    assertOutsideTransaction: () => {
      if (db.$client.inTransaction) throw new Error('FS inside SQL');
    },
    resolve: async (path) => {
      const canonicalPath = await realpath(path),
        info = await stat(canonicalPath, { bigint: true });
      return { canonicalPath, device: String(info.dev), inode: String(info.ino) };
    },
  }),
  {
    isAuthorityRefusal: () => false,
    preflight: async () => {},
    requireAccess: () => undefined,
    prepare: async () => current(),
    requireCurrent: () => current(),
    prepareRecovery: async () => current(),
    requireRecoveryCurrent: () => current(),
  },
  {
    completeVerified: () => {
      throw new Error('Crash worker must never complete');
    },
  },
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
  }
);
// The fixture final gate above is explicit and does not manufacture production authority.
await service.toggle(seed.request, {
  surface: 'capability',
  principal: createServerPrincipal({
    kind: 'runtime',
    owner: { kind: 'local_install', installationId: 'installation' },
    bindingId: 'binding',
    runtime: 'claude-code',
    canonicalSessionId: 'session-1',
    agentId: 'agent-1',
    agentPath: '/agents/one',
  }),
});
throw new Error('Crash boundary was not reached.');
