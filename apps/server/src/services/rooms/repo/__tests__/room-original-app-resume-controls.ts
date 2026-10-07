/** Real authenticated session HTTP requests over the original isolated native construction. */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { agents, sessionMetadata, apikey, authors, eq } from '@dorkos/db';
import request from '@dorkos/test-utils/supertest';
import {
  OpenCodeRuntime,
  type OpenCodeRuntimeOptions,
} from '../../../runtimes/opencode/opencode-runtime.js';
import { OpenCodeSessionMap } from '../../../runtimes/opencode/sessions/session-map.js';
import sessionsRouter from '../../../../routes/sessions.js';
import { runtimeRegistry, readOriginalRegisteredRuntime } from '../../../core/runtime-registry.js';
import { readTestModeOriginalPlacementOptions } from '../../../runtimes/test-mode/test-mode-runtime.js';
import { readTestModeOriginalActiveStream } from '../../../runtimes/test-mode/test-mode-runtime.js';
import { isTurnInFlight } from '../../../session/message-dispatcher.js';
import { peekProjector } from '../../../session/session-state-projector.js';
import { configManager } from '../../../core/config-manager.js';
import { RoomWorktreeManager } from '../room-worktree-manager.js';
import type { OriginalNativeLaunchFixture } from './room-original-native-launch-fixture.js';

/** Preserve the original positive predicate wait limit; no turn-count timing guesses. */
async function waitForOriginal<T>(read: () => T | undefined): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() - started >= 1000)
      throw new Error('Original app-resume observation unavailable');
    await pause(1);
  }
}

export async function runOriginalNativeAppResumeControl(
  owning: OriginalNativeLaunchFixture,
  mode: string
): Promise<void> {
  const target = await owning.bootNativeAgent();
  const label = mode === 'app-resume-label' ? 'Ana the Reviewer' : 'Native Agent';
  owning.db
    .update(authors)
    .set({ displayName: label })
    .where(eq(authors.id, target.authorId))
    .run();
  const copy = path.join(
    owning.repos.worktreesPath(owning.roomId),
    RoomWorktreeManager.slugFor(label, target.agentPath)
  );
  const repo = owning.repos.repoPath(owning.roomId);
  let originalSessionReads = 0;
  let providerStarts = 0;
  if (mode === 'app-resume-opencode-copy') {
    // Durable legacy session DATA belongs to an actual OpenCode constructor.
    // Only the external sidecar SDK reads are substituted; no native sender,
    // private Room request or permission predicate is manufactured.
    owning.db
      .update(agents)
      .set({ runtime: 'opencode' })
      .where(eq(agents.projectPath, target.agentPath))
      .run();
    owning.db
      .update(sessionMetadata)
      .set({ runtime: 'opencode' })
      .where(eq(sessionMetadata.sessionId, target.sessionId))
      .run();
    const map = new OpenCodeSessionMap(owning.db);
    const ocId = 'ses_original_room_copy';
    map.bind(target.sessionId, ocId);
    const client = {
      session: {
        list: async () => ({ data: [] }),
        get: async (input: { path: { id: string } }) => {
          assert.equal(input.path.id, ocId);
          originalSessionReads++;
          return {
            data: {
              id: ocId,
              projectID: 'prj_original',
              directory: copy,
              title: 'Original Room copy',
              version: '1.17.13',
              time: { created: Date.now(), updated: Date.now() },
            },
          };
        },
        prompt: async () => {
          providerStarts++;
          throw new Error('Refused turn must not start');
        },
        promptAsync: async () => {
          providerStarts++;
          throw new Error('Refused turn must not start');
        },
      },
    } as unknown as Awaited<ReturnType<OpenCodeRuntimeOptions['provider']['getClient']>>;
    runtimeRegistry.register(
      new OpenCodeRuntime({
        sessionMap: map,
        provider: {
          peekClient: () => client,
          getClient: async (cwd) => {
            assert.equal(cwd, target.agentPath);
            return client;
          },
          turnSettled: async () => {},
        },
      })
    );
  }
  const selected = await runtimeRegistry.resolveForSession(target.sessionId);
  const runtime = readOriginalRegisteredRuntime(selected);
  assert.ok(runtime, 'Original registered native runtime required');
  if (mode === 'app-resume-opencode-copy') assert.ok(runtime instanceof OpenCodeRuntime);

  owning.app.locals.docChannelHttp = owning.http;
  owning.app.use('/api/sessions', sessionsRouter);
  const send = (cwd?: string) =>
    request(owning.server)
      .post(`/api/sessions/${target.sessionId}/messages`)
      .set('Authorization', `Bearer ${owning.ownerKey.key}`)
      .send({ content: 'Resume the room conversation.', ...(cwd !== undefined ? { cwd } : {}) });
  const observe = () => readTestModeOriginalPlacementOptions(runtime, target.sessionId);
  const finish = async () => {
    await owning.finishNativeSession(target.sessionId);
    await waitForOriginal(() =>
      !readTestModeOriginalActiveStream(runtime, target.sessionId) ? true : undefined
    );
    // The native stream retires before the dispatcher/projector final drain.
    // Require the actual original sender to settle before a successor request.
    await waitForOriginal(() =>
      !isTurnInFlight(target.sessionId, selected) &&
      peekProjector(target.sessionId)?.getStatus().lifecycle === 'idle'
        ? true
        : undefined
    );
  };
  let failed = false;
  let first: unknown;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  const originalLstat = fs.lstat;
  let release: (() => void) | undefined;
  let wire: Promise<unknown> | undefined;
  try {
    if (mode === 'app-resume-config-off') {
      configManager.set('rooms', {
        ...configManager.get('rooms'),
        repo: { ...configManager.get('rooms').repo, enabled: false },
      });
    }
    if (mode === 'app-resume-copy') {
      // A genuine earlier app request created this original copy. Its completed
      // HTTP token is retired; the resumed request must acquire a fresh one.
      owning.holdNativeSession(target.sessionId);
      const seeded = await send();
      assert.equal(seeded.status, 202);
      const prior = await waitForOriginal(observe);
      assert.ok(prior.additionalDirectories?.some((grant) => grant.path === copy));
      await finish();
    }
    if (mode === 'app-resume-opencode-copy') {
      const response = await send();
      assert.equal(response.status, 409);
      assert.equal(response.body.code, 'ROOM_SESSION_MOVED');
      assert.equal(originalSessionReads, 1);
      assert.equal(providerStarts, 0);
      assert.equal(isTurnInFlight(target.sessionId, selected), false);
      assert.equal(peekProjector(target.sessionId), undefined);
      assert.equal(observe(), undefined);
      assert.equal(readTestModeOriginalActiveStream(runtime, target.sessionId), undefined);
    } else if (mode === 'app-resume-credential-revoked' || mode === 'app-resume-target-retired') {
      let acquired = false;
      const home = await fs.realpath(owning.repos.homeDir(owning.roomId));
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let armed = true;
      // Pass through the real original primitive and retain its acquired stat.
      // This observer supplies no identity/path/permission result to the writer.
      fs.lstat = new Proxy(originalLstat, {
        apply(target, receiver, args) {
          const result: Promise<unknown> = Reflect.apply(target, receiver, args);
          return result.then(async (stat) => {
            if (
              armed &&
              (String(args[0]) === home || String(args[0]) === owning.repos.homeDir(owning.roomId))
            ) {
              armed = false;
              acquired = true;
              await held;
            }
            return stat;
          });
        },
      });
      const pending = send().then((response) => response);
      void pending.catch(() => {});
      // Store the original wire join before either revocation or assertion.
      wire = pending;
      await waitForOriginal(() => (acquired ? true : undefined));
      if (mode === 'app-resume-credential-revoked') {
        owning.db
          .update(apikey)
          .set({ enabled: false })
          .where(eq(apikey.id, owning.ownerKey.id))
          .run();
      } else {
        owning.subsystem.service.removeMember(owning.roomId, owning.operator.id, target.authorId);
      }
      const releaseOriginal = release;
      if (!releaseOriginal) throw new Error('Original placement barrier is absent');
      releaseOriginal();
      const refused = await pending;
      assert.equal(refused.status, mode === 'app-resume-credential-revoked' ? 401 : 404);
      assert.equal(observe(), undefined);
      assert.equal(readTestModeOriginalActiveStream(runtime, target.sessionId), undefined);
    } else {
      owning.holdNativeSession(target.sessionId);
      const response = await send(mode === 'app-resume-copy' ? copy : undefined);
      assert.equal(response.status, 202);
      const opts = await waitForOriginal(observe);
      assert.equal(opts.cwd, target.agentPath);
      assert.equal(opts.forAgent, target.agentPath);
      if (mode === 'app-resume-no-repo' || mode === 'app-resume-config-off') {
        assert.equal(opts.additionalDirectories, undefined);
        assert.equal(
          await fs.lstat(copy).then(
            () => true,
            (cause) => {
              if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
              throw cause;
            }
          ),
          false
        );
      } else {
        assert.ok(
          opts.additionalDirectories?.some(
            (grant) => grant.path === copy && grant.access === 'write'
          )
        );
        assert.ok(
          opts.additionalDirectories?.some(
            (grant) => grant.path === repo && grant.access === 'read'
          )
        );
      }
      if (mode === 'app-resume-label') {
        assert.ok(path.basename(copy).startsWith('ana-the-reviewer-'));
        assert.equal((await fs.lstat(copy)).isDirectory(), true);
      }
      await finish();
    }
  } catch (cause) {
    remember(cause);
  } finally {
    release?.();
    fs.lstat = originalLstat;
    if (wire) {
      try {
        await wire;
      } catch (cause) {
        remember(cause);
      }
    }
  }
  if (failed) throw first;
}
