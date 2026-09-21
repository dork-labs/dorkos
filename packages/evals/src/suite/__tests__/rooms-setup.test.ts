/**
 * What a seeded room agent's manifest says its RUNTIME is — the one line that
 * decided which runtime every rooms case has ever been measured on.
 *
 * A room turn's session is minted by the room runner, not by the harness, so
 * `--runtime` cannot reach it as a request field: the only input
 * `resolveAgentRuntimeType` reads is the manifest on disk (file-first,
 * ADR-0043). Until DOR-2207 that manifest said `claude-code` whatever the run
 * asked for, so `--suite rooms --runtime opencode` booted an OpenCode server and
 * then ran every room turn on claude-code — which, inside the sandbox's pinned
 * empty `CLAUDE_CONFIG_DIR` (DOR-1712), has no sign-in at all. Every case died
 * before reaching a model, and the suite's whole history is claude-code numbers.
 *
 * So this file asserts the manifest FOLLOWS the run, for each runtime and for a
 * run that named none. It is the test that would have been red on 2026-09-20.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readManifest } from '@dorkos/shared/manifest';
import type { EvalRuntime, EvalSandbox } from '../../types.js';
import { agentDir, seedRoomAgents } from '../rooms-setup.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'dorkos-evals-rooms-setup-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A sandbox in this test's temp root, carrying the run's runtime (or none). */
function sandboxFor(runtime?: EvalRuntime): EvalSandbox {
  return {
    dorkHome: path.join(root, '.dork'),
    projectCwd: path.join(root, 'project'),
    ...(runtime ? { runtime } : {}),
  };
}

/** Seed one agent into a sandbox on `runtime` and read its manifest back off disk. */
async function seededRuntime(runtime?: EvalRuntime): Promise<string | undefined> {
  const sandbox = sandboxFor(runtime);
  await seedRoomAgents(sandbox, [
    { slug: 'ada', displayName: 'Ada', description: 'answers questions in the room' },
  ]);
  const manifest = await readManifest(agentDir(sandbox, 'ada'));
  return manifest?.runtime;
}

describe('seedRoomAgents — the seeded manifest follows the run', () => {
  it('seats the agent on the runtime the run asked for', async () => {
    // The 🔴 of DOR-2207: each of these was `claude-code` before the fix, so an
    // OpenCode or Codex leg measured neither.
    await expect(seededRuntime('opencode')).resolves.toBe('opencode');
  });

  it.each(['claude-code', 'codex', 'opencode'] as const)(
    'writes runtime %s when the run named it',
    async (runtime) => {
      await expect(seededRuntime(runtime)).resolves.toBe(runtime);
    }
  );

  it('falls back to claude-code when the run named no runtime', async () => {
    // Not `undefined`: on the `test-mode` tier none of the three runtimes is
    // registered, so the server default (`test-mode`) wins whatever the manifest
    // says — and on a credentialed tier that named nothing, claude-code is the
    // config schema's own default, which is what the run booted with.
    await expect(seededRuntime()).resolves.toBe('claude-code');
  });

  it('seeds every agent the case seats, not just the first', async () => {
    const sandbox = sandboxFor('codex');
    await seedRoomAgents(sandbox, [
      { slug: 'ada', displayName: 'Ada', description: 'answers questions' },
      { slug: 'rex', displayName: 'Rex', description: 'watches the deploys' },
    ]);
    for (const slug of ['ada', 'rex']) {
      const manifest = await readManifest(agentDir(sandbox, slug));
      expect(manifest?.runtime, `${slug} was seated on the wrong runtime`).toBe('codex');
    }
  });
});
