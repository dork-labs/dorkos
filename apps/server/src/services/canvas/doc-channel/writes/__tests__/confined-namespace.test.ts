import { mkdtemp, mkdir, writeFile, readFile, stat, rename, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { canvasDocWriteIntents } from '@dorkos/db';
import { batchFixture, NOW } from '../../__tests__/batch-fixtures.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfinedNamespace,
  publishNamespaceCreate,
  removeOwnedNamespaceTemp,
  type NamespaceAuthority,
} from '../confined-namespace.js';
import { InstallationMutations } from '../installation-mutations.js';
import { filesystemMutationRootProbe } from '../mutation-roots.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const cleanup: Array<() => Promise<void>> = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'namespace-protocol-'));
  const tree = path.join(root, 'tree');
  await mkdir(tree);
  const scheduler = new InstallationMutations(filesystemMutationRootProbe);
  cleanup.push(async () => {
    await scheduler.stop();
    await rm(root, { recursive: true, force: true });
  });
  let allowed = true;
  let blocked = false;
  let prepares = 0;
  const authority: NamespaceAuthority = {
    assertOutsideTransaction: () => undefined,
    async prepare() {
      prepares++;
    },
    requireCurrent() {
      if (!allowed) throw new Error('current-rights-refused');
      return undefined;
    },
    unresolved() {
      return blocked ? 'blocked' : 'clear';
    },
  };
  return {
    root,
    tree,
    scheduler,
    authority,
    protocol: new ConfinedNamespace(scheduler, authority),
    revoke() {
      allowed = false;
    },
    block() {
      blocked = true;
    },
    prepares: () => prepares,
  };
}
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const target = [{ rootIndex: 0, relativePath: 'parent/new.md' }];

describe('ConfinedNamespace', () => {
  it('uses nearest existing parent identity for absence and publishes without overwriting', async () => {
    const { tree, protocol } = await fixture();
    await mkdir(path.join(tree, 'parent'));
    const temp = path.join(tree, 'temporary');
    await writeFile(temp, 'source');
    await protocol.withNamespace([{ directory: tree }], target, async (owned) => {
      expect(owned.initial[0]!.missing).toEqual(['new.md']);
      expect(owned.initial[0]!.components).toHaveLength(1);
      await owned.step(owned.initial, () =>
        publishNamespaceCreate(temp, owned.initial[0]!.absolutePath)
      );
    });
    expect(await readFile(path.join(tree, 'parent/new.md'), 'utf8')).toBe('source');
  });

  it('refuses an external create collision and preserves external bytes', async () => {
    const { tree, protocol } = await fixture();
    await mkdir(path.join(tree, 'parent'));
    const temp = path.join(tree, 'temporary');
    await writeFile(temp, 'ours');
    await expect(
      protocol.withNamespace([{ directory: tree }], target, async (owned) => {
        await owned.step(owned.initial, async () => {
          // An external process arrives after the protocol checks. link must still not overwrite it.
          await writeFile(owned.initial[0]!.absolutePath, 'external');
          await publishNamespaceCreate(temp, owned.initial[0]!.absolutePath);
        });
      })
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(path.join(tree, 'parent/new.md'), 'utf8')).toBe('external');
  });

  it('refuses symlinked ancestors, traversal, root retarget and changed nearest parent', async () => {
    const { root, tree, protocol } = await fixture();
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, path.join(tree, 'parent'));
    await expect(
      protocol.withNamespace([{ directory: tree }], target, async () => {})
    ).rejects.toMatchObject({ code: 'invalid-path' });
    await expect(
      protocol.withNamespace(
        [{ directory: tree }],
        [{ rootIndex: 0, relativePath: '../outside/new' }],
        async () => {}
      )
    ).rejects.toMatchObject({ code: 'invalid-path' });
    await rm(path.join(tree, 'parent'));
    await mkdir(path.join(tree, 'parent'));
    await expect(
      protocol.withNamespace([{ directory: tree }], target, async (owned) => {
        await rename(path.join(tree, 'parent'), path.join(tree, 'old-parent'));
        await mkdir(path.join(tree, 'parent'));
        await owned.step(owned.initial, async () => {
          throw new Error('must-not-effect');
        });
      })
    ).rejects.toMatchObject({ code: 'namespace-changed' });
    await expect(
      protocol.withNamespace([{ directory: tree }], target, async (owned) => {
        await rename(tree, `${tree}-old`);
        await mkdir(tree);
        await owned.step(owned.initial, async () => {
          throw new Error('must-not-effect');
        });
      })
    ).rejects.toMatchObject({ code: 'root-changed' });
  });

  it('rechecks absent parent after awaited authority and refuses a new symlink', async () => {
    const { root, tree, protocol, authority } = await fixture();
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    let effects = 0;
    await expect(
      protocol.withNamespace([{ directory: tree }], target, async (owned) => {
        expect(owned.initial[0]!.missing).toEqual(['parent', 'new.md']);
        authority.prepare = async () => {
          await symlink(outside, path.join(tree, 'parent'));
        };
        await owned.step(owned.initial, async () => {
          effects++;
        });
      })
    ).rejects.toMatchObject({ code: 'invalid-path' });
    expect(effects).toBe(0);
    await expect(readFile(path.join(outside, 'new.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires current authority after preparation awaits and refuses async current checks', async () => {
    const { tree, protocol, authority, revoke } = await fixture();
    let effects = 0;
    await expect(
      protocol.withNamespace([{ directory: tree }], target, async (owned) => {
        authority.prepare = async () => {
          revoke();
        };
        await owned.step(owned.initial, async () => {
          effects++;
        });
      })
    ).rejects.toThrow('current-rights-refused');
    expect(effects).toBe(0);
    const asynchronous = new ConfinedNamespace(
      new InstallationMutations(filesystemMutationRootProbe),
      {
        ...authority,
        requireCurrent: (() =>
          Promise.reject(new Error('late'))) as unknown as NamespaceAuthority['requireCurrent'],
      }
    );
    await expect(
      asynchronous.withNamespace([{ directory: tree }], target, async () => {
        effects++;
      })
    ).rejects.toMatchObject({ code: 'unresolved' });
    expect(effects).toBe(0);
  });

  it('refuses unknown/blocked/failed census and a newly unresolved intent after await', async () => {
    const { tree, protocol, authority, block } = await fixture();
    let effects = 0;
    await expect(
      protocol.withNamespace([{ directory: tree }], target, async (owned) => {
        block();
        await owned.step(owned.initial, async () => {
          effects++;
        });
      })
    ).rejects.toMatchObject({ code: 'unresolved' });
    authority.unresolved = () => {
      throw new Error('SQLITE_BUSY');
    };
    await expect(
      protocol.withNamespace([{ directory: tree }], target, async () => {
        effects++;
      })
    ).rejects.toThrow('SQLITE_BUSY');
    expect(effects).toBe(0);
  });

  it('never removes a substituted temp pathname and cleans up only its actual owned inode', async () => {
    const { tree } = await fixture();
    const temp = path.join(tree, 'temp');
    await writeFile(temp, 'owned');
    const info = await stat(temp, { bigint: true });
    const key = `${info.dev}:${info.ino}`;
    await rename(temp, `${temp}-owned`);
    await writeFile(temp, 'external');
    await expect(removeOwnedNamespaceTemp(temp, key)).rejects.toMatchObject({
      code: 'cleanup-ownership',
    });
    expect(await readFile(temp, 'utf8')).toBe('external');
    await removeOwnedNamespaceTemp(`${temp}-owned`, key);
    await expect(readFile(`${temp}-owned`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('drains launched steps through rollback before releasing exclusive ownership', async () => {
    const { tree, protocol, scheduler } = await fixture();
    const entered = deferred();
    const release = deferred();
    const owned = protocol.withNamespace([{ directory: tree }], target, async (namespace) => {
      void namespace.step(namespace.initial, async () => {
        entered.resolve();
        await release.promise;
      });
    });
    await entered.promise;
    let slipped = false;
    const waiter = scheduler.withMutation('files', [{ directory: tree }], async () => {
      slipped = true;
    });
    await new Promise<void>((done) => setImmediate(done));
    expect(slipped).toBe(false);
    release.resolve();
    await Promise.all([owned, waiter]);
    expect(slipped).toBe(true);
  });

  it('refuses an intent committed by a second connection during its final root await', async () => {
    const { root, tree, authority } = await fixture();
    const batch = batchFixture(path.join(root, 'final-gate.sqlite'));
    const competing = new Database(path.join(root, 'final-gate.sqlite'));
    cleanup.push(async () => {
      competing.close();
      batch.db.$client.close();
    });
    batch.db
      .insert(canvasDocWriteIntents)
      .values({
        intentId: 'late-intent',
        documentId: batch.documentId,
        grantId: batch.grantId,
        eventId: 'event',
        envelopeHash: 'e'.repeat(64),
        sourceIdentity: {},
        resolvedCwd: '/other/root',
        treeKind: 'main',
        canonicalPath: '/other/root/file',
        operation: 'checkbox-toggle',
        input: {},
        beforeHash: 'a'.repeat(64),
        afterHash: 'b'.repeat(64),
        expectedVersion: 'a'.repeat(64),
        status: 'conflict',
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    const held = deferred();
    const release = deferred();
    let arm = false;
    let stepReads = 0;
    let inStep = false;
    const scheduler = new InstallationMutations({
      async resolve(root) {
        if (arm) {
          arm = false;
          held.resolve();
          await release.promise;
        }
        return filesystemMutationRootProbe.resolve(root);
      },
    });
    cleanup.push(() => scheduler.stop());
    authority.unresolved = () => {
      const blocked = batch.db.$client
        .prepare(
          "SELECT 1 FROM canvas_doc_write_intents WHERE status NOT IN ('committed','no_op','conflict','failed') LIMIT 1"
        )
        .get();
      if (inStep && ++stepReads === 3) arm = true;
      return blocked ? 'blocked' : 'clear';
    };
    let effects = 0;
    const protocol = new ConfinedNamespace(scheduler, authority);
    await expect(
      protocol.withNamespace([{ directory: tree }], target, async (owned) => {
        inStep = true;
        const step = owned.step(owned.initial, async () => {
          effects++;
        });
        void step.catch(() => {});
        await held.promise;
        competing
          .prepare('UPDATE canvas_doc_write_intents SET status = ? WHERE intent_id = ?')
          .run('in_doubt', 'late-intent');
        release.resolve();
        await step;
      })
    ).rejects.toMatchObject({ code: 'unresolved' });
    expect(effects).toBe(0);
    expect(stepReads).toBe(4);
  });

  it('rejects an asynchronous census without effects or unhandled rejection', async () => {
    const { tree, authority, scheduler } = await fixture();
    let effects = 0;
    authority.unresolved = (() =>
      Promise.reject(new Error('late-census'))) as unknown as NamespaceAuthority['unresolved'];
    await expect(
      new ConfinedNamespace(scheduler, authority).withNamespace(
        [{ directory: tree }],
        target,
        async () => {
          effects++;
        }
      )
    ).rejects.toMatchObject({ code: 'unresolved' });
    expect(effects).toBe(0);
  });

  it('reads a fresh real-file SQLite sole-ledger census across roots rather than cached permission', async () => {
    const { root, tree, scheduler, authority } = await fixture();
    const dbPath = path.join(root, 'intents.sqlite');
    const batch = batchFixture(dbPath);
    const db = batch.db.$client;
    authority.assertOutsideTransaction = () => {
      if (db.inTransaction) throw new Error('filesystem-inside-sql');
      return undefined;
    };
    const competing = new Database(dbPath);
    cleanup.push(async () => {
      if (competing.open) competing.close();
      db.close();
    });
    // Genuine migrated original ledger and existing grant/document foreign keys.
    authority.unresolved = () =>
      db
        .prepare(
          "SELECT 1 FROM canvas_doc_write_intents WHERE status NOT IN ('committed','no_op','conflict','failed') LIMIT 1"
        )
        .get()
        ? 'blocked'
        : 'clear';
    const protocol = new ConfinedNamespace(scheduler, authority);
    let effects = 0;
    await expect(
      protocol.withNamespace([{ directory: tree }], target, async (namespace) => {
        batch.db
          .insert(canvasDocWriteIntents)
          .values({
            intentId: 'other-tree-intent',
            documentId: batch.documentId,
            grantId: batch.grantId,
            eventId: 'original-event',
            envelopeHash: 'e'.repeat(64),
            sourceIdentity: {},
            resolvedCwd: '/other/root',
            treeKind: 'main',
            canonicalPath: '/other/root/file',
            operation: 'checkbox-toggle',
            input: {},
            beforeHash: 'a'.repeat(64),
            afterHash: 'b'.repeat(64),
            expectedVersion: 'a'.repeat(64),
            status: 'in_doubt',
            createdAt: NOW,
            updatedAt: NOW,
          })
          .run();
        await namespace.step(namespace.initial, async () => {
          effects++;
        });
      })
    ).rejects.toMatchObject({ code: 'unresolved' });
    expect(effects).toBe(0);
    competing
      .prepare('UPDATE canvas_doc_write_intents SET status = ? WHERE intent_id = ?')
      .run('conflict', 'other-tree-intent');
    await protocol.withNamespace([{ directory: tree }], target, async (namespace) => {
      await namespace.step(namespace.initial, async () => {
        effects++;
      });
    });
    expect(effects).toBe(1);
    let transactionAdmission!: Promise<void>;
    db.transaction(() => {
      transactionAdmission = protocol.withNamespace([{ directory: tree }], target, async () => {
        effects++;
      });
      void transactionAdmission.catch(() => {});
    })();
    await expect(transactionAdmission).rejects.toThrow('filesystem-inside-sql');
    expect(effects).toBe(1);
    competing
      .prepare('UPDATE canvas_doc_write_intents SET status = ? WHERE intent_id = ?')
      .run('legacy_unknown', 'other-tree-intent');
    await expect(
      protocol.withNamespace([{ directory: tree }], target, async () => {
        effects++;
      })
    ).rejects.toMatchObject({ code: 'unresolved' });
    competing
      .prepare('UPDATE canvas_doc_write_intents SET status = ? WHERE intent_id = ?')
      .run('conflict', 'other-tree-intent');
    competing.close();
    db.pragma('journal_mode=DELETE');
    const locker = new Database(dbPath);
    db.pragma('busy_timeout=0');
    locker.exec('BEGIN EXCLUSIVE');
    try {
      await expect(
        protocol.withNamespace([{ directory: tree }], target, async () => {
          effects++;
        })
      ).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
    } finally {
      locker.exec('ROLLBACK');
      locker.close();
    }
  });
});
