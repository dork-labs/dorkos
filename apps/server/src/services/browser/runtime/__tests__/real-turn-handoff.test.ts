import { expect, it, vi } from 'vitest';
import { parseBrowserCommand } from '@dorkos/browser';
import type { CodexTransport } from '../../../runtimes/codex/transport/index.js';
import {
  guardOriginalCodexTransport,
  resolveOriginalInputAcceptanceObserver,
} from './real-turn-handoff.fixture.js';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, type PublicNativeInput } from './public-native-input.js';
import { onTestFinished } from 'vitest';

// These controlled transport controls cannot count as any real human-agent transition.
it('refuses before original provider entry and remembers the actual attempted call', () => {
  const provider = vi.fn();
  const original: CodexTransport = {
    kind: 'exec',
    capabilities: {},
    async *runTurn() {
      provider();
      throw new Error('Original provider must not run');
    },
    async interrupt() {
      return { outcome: 'not-running', reason: 'no-open-turn', runtime: 'codex' };
    },
    async shutdown() {},
  };
  const guarded = guardOriginalCodexTransport(original);
  guarded.assertNotEntered();
  expect(() => Reflect.apply(guarded.transport.runTurn, guarded.transport, [])).toThrow(
    'HANDOFF_PROVIDER_ENTRY_FORBIDDEN'
  );
  expect(provider).not.toHaveBeenCalled();
  expect(() => guarded.assertNotEntered()).toThrow('HANDOFF_PROVIDER_WAS_REACHED');
});
it('retains original non-provider method receivers through the private guard', async () => {
  class Original implements CodexTransport {
    readonly kind = 'exec' as const;
    readonly capabilities = {};
    #closed = false;
    async *runTurn() {
      throw new Error('No provider in this control');
    }
    async interrupt() {
      return {
        outcome: 'not-running' as const,
        reason: 'no-open-turn' as const,
        runtime: 'codex' as const,
      };
    }
    async shutdown() {
      this.#closed = true;
    }
    closed() {
      return this.#closed;
    }
  }
  const original = new Original();
  const guarded = guardOriginalCodexTransport(original);
  await guarded.transport.shutdown();
  expect(original.closed()).toBe(true);
  guarded.assertNotEntered();
});

it('private observer resolves the same original emitted package bank rather than a source copy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'handoff-original-emits-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const url = new URL('./input/acceptance-observer.js', import.meta.resolve('@dorkos/browser'));
  const path = fileURLToPath(url);
  const guardBytes = Buffer.from(
    JSON.stringify({ files: { [path]: sha256(await readFile(path)) } })
  );
  const emittedGuard = join(directory, 'guard.json');
  await writeFile(emittedGuard, guardBytes);
  const input: PublicNativeInput = {
    kind: 'production-public-native-acceptance',
    home: directory,
    cliEntry: join(directory, 'unused-cli.js'),
    cliSHA256: '0'.repeat(64),
    emittedGuard,
    emittedGuardSHA256: sha256(guardBytes),
    workspaceId: 'controlled-files-only',
    email: 'public-native@dork.test',
    password: 'public-native-fixture-password-only',
    port: 4242,
  };
  const install = await resolveOriginalInputAcceptanceObserver(input, () => {});
  const reset = vi.fn();
  const owner = install({
    matches: () => true,
    admitted: () => {},
    resetPublished: reset,
    afterNativeAcknowledgement: async () => {},
    dispose: () => {},
  });
  onTestFinished(() => owner.close());
  const original: typeof import('../../../../../../../packages/browser/src/input/acceptance-observer.js') =
    await import(url.href);
  const command = parseBrowserCommand({
    kind: 'input',
    requestId: crypto.randomUUID(),
    binding: {
      browserId: 'browser_fixture_original_0001',
      browserGeneration: 1,
      tabId: 'tab_fixture_original_00000001',
      viewportVersion: 1,
      navigationGeneration: 0,
      epoch: 0,
      inputGeneration: 0,
    },
    steps: [{ kind: 'text', text: 'controlled' }],
  });
  if (command.kind !== 'input') throw new Error('CONTROLLED_ORIGINAL_INPUT_REQUIRED');
  original.observeOriginalReset(command.binding);
  expect(reset).toHaveBeenCalledOnce();
  owner.assertHealthy();
  await writeFile(emittedGuard, JSON.stringify({ files: {} }));
  await expect(resolveOriginalInputAcceptanceObserver(input, () => {})).rejects.toThrow(
    'HANDOFF_ORIGINAL_EMITS_CHANGED'
  );
});
