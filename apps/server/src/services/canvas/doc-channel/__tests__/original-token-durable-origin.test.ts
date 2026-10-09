/** Genuine original issuance/restart provenance controls; actorless disclosure is a separate unfinished gate. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openServerDatabase } from '@dorkos/db/internal-server';
import { runMigrations, type Db } from '@dorkos/db';
import { nativeRoomAuthorityFixture } from '../writes/__tests__/authority-fixtures.js';
import { issueServiceOriginalDocToken, currentRoomDueServicePort } from '../service.js';
import { stopInstallationFileWrites } from '../writes/installation-file-writes.js';
import {
  DocChannelTokenStore,
  readOriginalNativeDocTokenHeaderByHash,
} from '../tokens/token-store.js';
import { initAuth, verifyOriginalDocTokenNativeCapsule } from '../../../core/auth/index.js';

type Fixture = Awaited<ReturnType<typeof nativeRoomAuthorityFixture>>;
async function withOriginalIssuedToken(
  run: (
    h: Fixture,
    store: DocChannelTokenStore,
    hash: string,
    reopen: () => Promise<{ db: Db; store: DocChannelTokenStore }>
  ) => Promise<void>,
  expiresAfterMs = 3600000
) {
  const agentPath = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'native-token-origin-agent-'))
  );
  let h: Fixture | undefined;
  let reopened: Db | undefined;
  let failed = false;
  let first: unknown;
  let ownershipClosed = true;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  try {
    h = await nativeRoomAuthorityFixture(
      agentPath,
      'codex',
      'native-token-origin-session',
      'native-token-origin-agent'
    );
    const response = await issueServiceOriginalDocToken(
      h.http.service,
      h.operator,
      {
        documentId: h.documentId,
        allowedTypes: ['md.comment'],
        directions: ['upstream'],
        permissions: ['replay', 'stream'],
        expiresAt: new Date(Date.now() + expiresAfterMs).toISOString(),
      },
      [h.granted.grant.grantId]
    );
    const hash = createHash('sha256').update(response.token).digest('hex');
    const store = new DocChannelTokenStore(h.db);
    const actual = h;
    await run(h, store, hash, async () => {
      // Original retained stages/pump must positively close before the original physical Db.
      let drainFailed = false;
      let drainCause: unknown;
      const retained = (cause: unknown) => {
        if (!drainFailed) {
          drainFailed = true;
          drainCause = cause;
        }
      };
      await Promise.allSettled([
        Promise.resolve()
          .then(() =>
            stopInstallationFileWrites(actual.http.fileWrites, actual.db, actual.http.channels)
          )
          .catch(retained),
        Promise.resolve()
          .then(() => currentRoomDueServicePort(actual.http.service).stopPump())
          .catch(retained),
      ]);
      if (drainFailed) {
        ownershipClosed = false;
        throw drainCause;
      }
      try {
        actual.db.$client.close();
      } catch (cause) {
        ownershipClosed = false;
        throw cause;
      }
      const opened = openServerDatabase(actual.file);
      reopened = opened.db;
      // Real persisted schema and key are reused. No inline DDL, row issuer or fabricated principal.
      initAuth(reopened, actual.dir);
      return { db: reopened, store: new DocChannelTokenStore(reopened) };
    });
  } catch (cause) {
    if (!h) ownershipClosed = false;
    remember(cause);
  } finally {
    if (reopened) {
      try {
        if (reopened.$client.open) reopened.$client.close();
      } catch (cause) {
        ownershipClosed = false;
        remember(cause);
      }
    }
    if (ownershipClosed && h) {
      try {
        await h.cleanup();
      } catch (cause) {
        ownershipClosed = false;
        remember(cause);
      }
    }
    if (ownershipClosed) {
      try {
        await fs.rm(agentPath, { recursive: true, force: true });
      } catch (cause) {
        remember(cause);
      }
    }
    // Any failed native drain/close retains actual Db files and original key/source evidence.
  }
  if (failed) throw first;
}

describe('original durable native token issuance provenance', () => {
  it('verifies the genuine original capsule after positive close and fresh original Db/auth construction', async () => {
    await withOriginalIssuedToken(async (h, store, hash, reopen) => {
      const before = readOriginalNativeDocTokenHeaderByHash(store, h.db, hash)!;
      const payload = verifyOriginalDocTokenNativeCapsule(h.db, before);
      const fresh = await reopen();
      const after = readOriginalNativeDocTokenHeaderByHash(fresh.store, fresh.db, hash)!;
      expect(after).toEqual(before);
      expect(verifyOriginalDocTokenNativeCapsule(fresh.db, after)).toBe(payload);
      expect(JSON.parse(payload).nativeFacts.physical.id).toBe(h.documentId);
    });
  });
  it('refuses a copied header DTO even when all signed bytes are identical', async () => {
    await withOriginalIssuedToken(async (h, store, hash) => {
      const header = readOriginalNativeDocTokenHeaderByHash(store, h.db, hash)!;
      expect(() => verifyOriginalDocTokenNativeCapsule(h.db, { ...header })).toThrow(
        'Original native token header unavailable'
      );
      expect(verifyOriginalDocTokenNativeCapsule(h.db, header)).toBeTypeOf('string');
    });
  });
  it.each([
    ['allowed_types', '["md.changed"]'],
    ['expires_at', '2099-01-01T00:00:00.000Z'],
    ['approved_grant_bindings', '[]'],
  ] as const)(
    'refuses native persisted %s tampering after genuine issuance',
    async (column, value) => {
      await withOriginalIssuedToken(async (h, store, hash) => {
        const before = readOriginalNativeDocTokenHeaderByHash(store, h.db, hash)!;
        expect(verifyOriginalDocTokenNativeCapsule(h.db, before)).toBeTypeOf('string');
        h.db.$client
          .prepare(`UPDATE canvas_doc_channel_tokens SET "${column}"=? WHERE token_hash=?`)
          .run(value, hash);
        const changed = readOriginalNativeDocTokenHeaderByHash(store, h.db, hash)!;
        expect(() => verifyOriginalDocTokenNativeCapsule(h.db, changed)).toThrow(
          'Original token provenance unavailable'
        );
      });
    }
  );
  it('refuses a held old original header after actual native restriction tampering', async () => {
    await withOriginalIssuedToken(async (h, store, hash) => {
      const held = readOriginalNativeDocTokenHeaderByHash(store, h.db, hash)!;
      expect(verifyOriginalDocTokenNativeCapsule(h.db, held)).toBeTypeOf('string');
      h.db.$client
        .prepare('UPDATE canvas_doc_channel_tokens SET allowed_types=? WHERE token_hash=?')
        .run('["md.changed"]', hash);
      expect(held.allowedTypesJson).toBe('["md.comment"]');
      expect(() => verifyOriginalDocTokenNativeCapsule(h.db, held)).toThrow(
        'Original token provenance unavailable'
      );
    });
  });
  it('refuses a held old original header after its real native expiry deadline', async () => {
    await withOriginalIssuedToken(async (h, store, hash) => {
      const held = readOriginalNativeDocTokenHeaderByHash(store, h.db, hash)!;
      expect(held.nativeExpiryCurrent).toBe(true);
      expect(verifyOriginalDocTokenNativeCapsule(h.db, held)).toBeTypeOf('string');
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.max(0, Date.parse(held.expiresAt) - Date.now() + 25))
      );
      expect(held.nativeExpiryCurrent).toBe(true);
      expect(() => verifyOriginalDocTokenNativeCapsule(h.db, held)).toThrow(
        'Original token is not current'
      );
    }, 1000);
  });
  it('refuses a held old original header after actual native revocation', async () => {
    await withOriginalIssuedToken(async (h, store, hash) => {
      const held = readOriginalNativeDocTokenHeaderByHash(store, h.db, hash)!;
      expect(verifyOriginalDocTokenNativeCapsule(h.db, held)).toBeTypeOf('string');
      h.db.$client
        .prepare('UPDATE canvas_doc_channel_tokens SET revoked_at=? WHERE token_hash=?')
        .run(new Date().toISOString(), hash);
      expect(held.revokedAt).toBeNull();
      expect(() => verifyOriginalDocTokenNativeCapsule(h.db, held)).toThrow(
        'Original token is not current'
      );
    });
  });
  it('preserves ordinary original native memory Db auth construction', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-memory-auth-')));
    let db: Db | undefined;
    let failed = false;
    let first: unknown;
    let closed = true;
    try {
      db = openServerDatabase(':memory:').db;
      runMigrations(db);
      expect(() => initAuth(db!, dir)).not.toThrow();
    } catch (cause) {
      failed = true;
      first = cause;
    } finally {
      if (db)
        try {
          db.$client.close();
        } catch (cause) {
          closed = false;
          if (!failed) {
            failed = true;
            first = cause;
          }
        }
      if (closed)
        try {
          await fs.rm(dir, { recursive: true, force: true });
        } catch (cause) {
          if (!failed) {
            failed = true;
            first = cause;
          }
        }
    }
    if (failed) throw first;
  });
  it('refuses actual native revocation without promoting the retained signed capsule', async () => {
    await withOriginalIssuedToken(async (h, store, hash) => {
      h.db.$client
        .prepare('UPDATE canvas_doc_channel_tokens SET revoked_at=? WHERE token_hash=?')
        .run(new Date().toISOString(), hash);
      const header = readOriginalNativeDocTokenHeaderByHash(store, h.db, hash)!;
      expect(header.revokedAt).not.toBeNull();
      expect(() => verifyOriginalDocTokenNativeCapsule(h.db, header)).toThrow(
        'Original token is not current'
      );
    });
  });
});
