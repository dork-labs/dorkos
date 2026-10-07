import { beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BrowserBindingSchema,
  BrowserControlSchema,
  BrowserProductionOpenRequestSchema,
  BrowserProductionOpenReceiptSchema,
  BrowserProductionNavigateRequestSchema,
  BrowserProductionNavigateReceiptSchema,
} from '@dorkos/shared/browser-schemas';
import { SemanticSnapshotV1Schema } from '@dorkos/shared/browser-semantic-schemas';
import { joinOriginalPublicNativeReturn } from './public-native-return.js';

const ports = vi.hoisted(() => ({
  run: vi.fn(),
  verify: vi.fn(),
  published: vi.fn(),
  config: Buffer.alloc(0),
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      await fs.writeFile(...args);
      ports.published();
    },
  };
});
vi.mock('./public-native-input.js', () => ({
  boundedOriginalFile: async () => ports.config,
  readPublicNativeInput: async () => ({
    home: '/original-input',
    cliEntry: '/original-cli',
    workspaceId: 'external_workspace_fixture_001',
  }),
  verifyPublicNativeEmits: (...args: unknown[]) => ports.verify(...args),
}));
vi.mock('@dorkos/browser/runtime-installation', () => ({
  resolveInstalledRuntimeConfiguration: async () => ({}),
  createRuntimeInstallation: () => ({
    inspectExisting: async () => ({ state: 'installed-files' }),
  }),
  verifyInstalledNativeJournal: async () => ({}),
}));
vi.mock('./private-storage-runner.fixture.js', () => ({
  withOriginalInstalledBrowserRound: (...args: unknown[]) => ports.run(...args),
}));
beforeEach(() => {
  vi.resetModules();
  ports.run.mockReset();
  ports.published.mockReset();
  ports.verify.mockReset();
  ports.verify.mockImplementation((_input: unknown, current: () => void) => current());
});

type EntryPorts = {
  signal: AbortSignal;
  current(): void;
  retain(value: unknown): Promise<void>;
  retainRetirement(value: unknown): Promise<void>;
};
async function originalEntry() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'original-external-https-entry-')));
  const artifacts = join(root, 'exclusive');
  ports.config = Buffer.from(
    JSON.stringify({ input: '/original-input.json', node: process.execPath, artifacts })
  );
  const argv = process.argv;
  const exitCode = process.exitCode;
  process.argv = [process.execPath, '/original-entry', '/original-config.json'];
  const stop = new Map<string, () => void>();
  // Capture only this entry's original registered callback. Do not signal the Vitest owner.
  const originalOn = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation(((event: string, callback: () => void) => {
    if (event === 'SIGTERM' || event === 'SIGINT') {
      stop.set(event, callback);
      return process;
    }
    return originalOn(event, callback);
  }) as typeof process.on);
  let completed!: () => void;
  const done = new Promise<void>((resolve) => {
    completed = resolve;
  });
  const published = new Promise<void>((resolve) => ports.published.mockImplementation(resolve));
  const error = vi.spyOn(console, 'error').mockImplementation(() => {
    completed();
  });
  onTestFinished(async () => {
    process.argv = argv;
    process.exitCode = exitCode;
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });
  return { artifacts, stop, done, published, error };
}

it('actual direct entry cancellation retains independent retirement facts before original return', async () => {
  const entry = await originalEntry();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const captured: { original?: EntryPorts } = {};
  ports.run.mockImplementation(async (options: EntryPorts) => {
    captured.original = options;
    entered();
    await held;
    await options.retainRetirement({
      kind: 'original-storage-retirement',
      round: 0,
      knownBirths: [],
      observed: [],
    });
    options.current();
  });
  try {
    await import('./private-external-https-entry.fixture.js');
    await Promise.race([
      started,
      entry.done.then(() => {
        throw new Error('Original entry failed before held runner');
      }),
    ]);
    expect(entry.stop.has('SIGTERM')).toBe(true);
    entry.stop.get('SIGTERM')!();
    expect(captured.original?.signal.aborted).toBe(true);
    expect(() => captured.original?.current()).toThrow('EXTERNAL_HTTPS_ORIGINAL_PARENT_STOP');
    expect(entry.error).not.toHaveBeenCalled();
  } finally {
    release();
    await entry.done;
  }
  const result = JSON.parse(await readFile(join(entry.artifacts, 'RESULT.json'), 'utf8'));
  expect(result).toMatchObject({
    returned: 'FAIL',
    reports: [{ kind: 'original-storage-retirement', round: 0 }],
  });
  expect(entry.error.mock.calls[0][1]).toBe(captured.original?.signal.reason);
});

it.each([false, undefined])(
  'actual direct entry exports joined cleanup report and exact primary %s',
  async (value) => {
    const entry = await originalEntry();
    ports.run.mockImplementation(async (options: EntryPorts) => {
      await options.retainRetirement({
        kind: 'original-storage-retirement',
        round: 2,
        knownBirths: [],
        observed: [],
      });
      throw value;
    });
    await import('./private-external-https-entry.fixture.js');
    await entry.done;
    const result = JSON.parse(await readFile(join(entry.artifacts, 'RESULT.json'), 'utf8'));
    expect(result).toMatchObject({
      returned: 'FAIL',
      reports: [{ kind: 'original-storage-retirement', round: 2 }],
    });
    expect(entry.error.mock.calls[0][1]).toBe(value);
    expect(ports.verify).toHaveBeenCalledOnce();
  }
);

// Registration-boundary ports consume the actual entry body. Shared schemas certify
// public messages; these controls confer no production/native authority.
it.each(['accepted', 'changed-page', 'wrong-heading'] as const)(
  'actual public HTTPS body %s retains original retirement before publication',
  async (variant) => {
    const entry = await originalEntry();
    const binding = BrowserBindingSchema.parse({
      browserId: 'external_browser_fixture_001',
      browserGeneration: 1,
      tabId: 'external_tab_fixture_000001',
      navigationGeneration: 0,
      viewportVersion: 1,
      epoch: 1,
      inputGeneration: 1,
    });
    const successor = BrowserBindingSchema.parse({ ...binding, navigationGeneration: 1 });
    let release!: () => void;
    const heldRetirement = new Promise<void>((resolve) => {
      release = resolve;
    });
    let returned!: () => void;
    const bodyReturned = new Promise<void>((resolve) => {
      returned = resolve;
    });
    const original: { failure?: { value: unknown } } = {};
    const request = vi.fn(async (path: string, document: unknown): Promise<unknown> => {
      if (path === '/api/browser/runtime/open') {
        const value = BrowserProductionOpenRequestSchema.parse(document);
        expect(value.workspaceId).toBe('external_workspace_fixture_001');
        expect(value.request.mode).toBe('ephemeral');
        return BrowserProductionOpenReceiptSchema.parse({
          requestId: value.request.requestId,
          instance: {
            browserId: binding.browserId,
            browserGeneration: 1,
            mode: 'ephemeral',
            status: 'running',
          },
          binding,
        });
      }
      if (path === '/api/browser/control') {
        expect(BrowserBindingSchema.parse(document)).toEqual(binding);
        return BrowserControlSchema.parse({
          binding,
          controllerId: 'external_controller_fixture_001',
          status: 'ready',
        });
      }
      if (path === '/api/browser/runtime/navigate') {
        const value = BrowserProductionNavigateRequestSchema.parse(document);
        expect(value.command.url).toBe('https://example.com/');
        expect(value.command.binding).toEqual(binding);
        return BrowserProductionNavigateReceiptSchema.parse({
          requestId: value.command.requestId,
          binding:
            variant === 'changed-page'
              ? { ...successor, tabId: 'external_other_tab_fixture_001' }
              : successor,
        });
      }
      if (path === '/api/browser/semantic/owner/read') {
        expect(document).toEqual({ binding: successor });
        const nodeRef = 'external_heading_fixture_001';
        return SemanticSnapshotV1Schema.parse({
          version: 1,
          ...successor,
          treeId: 'external_tree_fixture_000001',
          treeRevision: 1,
          grantRevision: 1,
          semanticLeaseId: 'external_lease_fixture_00001',
          capturedAt: '2026-10-07T00:00:00.000Z',
          expiresInMs: 2000,
          rootRefs: [nodeRef],
          nodes: [
            {
              nodeRef,
              frameId: 'external_frame_fixture_00001',
              frameNavigationGeneration: 1,
              parentRef: null,
              childRefs: [],
              role: 'heading',
              name: variant === 'wrong-heading' ? 'Unrelated page' : 'Example Domain',
              states: {},
              editKind: 'none',
              actions: [],
              redacted: false,
              truncated: false,
            },
          ],
          focusedRef: null,
          focusState: 'none',
          focusRevision: 0,
          completeness: 'complete',
        });
      }
      throw new Error('Unexpected public request boundary');
    });
    const birth = vi.fn(async (value: unknown) => {
      expect(BrowserBindingSchema.parse(value)).toEqual(binding);
    });
    ports.run.mockImplementation(
      async (options: EntryPorts, body: (port: unknown) => Promise<void>) => {
        const originalBody = body({ request, birth });
        void originalBody.then(returned, (value) => {
          original.failure = { value };
          returned();
        });
        await joinOriginalPublicNativeReturn({
          body: originalBody,
          async close() {
            await heldRetirement;
          },
          async observe() {
            await options.retainRetirement({
              kind: 'original-storage-retirement',
              offCleanup: 'observed',
              round: 0,
            });
          },
        });
      }
    );
    try {
      await import('./private-external-https-entry.fixture.js');
      await Promise.race([
        bodyReturned,
        entry.done.then(() => {
          throw new Error('Entry failed before original public body returned');
        }),
      ]);
      expect(entry.error).not.toHaveBeenCalled();
      expect(ports.published).not.toHaveBeenCalled();
      expect(birth).toHaveBeenCalledOnce();
    } finally {
      release();
      await (variant === 'accepted' ? entry.published : entry.done);
    }
    const result = JSON.parse(await readFile(join(entry.artifacts, 'RESULT.json'), 'utf8'));
    expect(result.reports).toContainEqual({
      kind: 'original-storage-retirement',
      offCleanup: 'observed',
      round: 0,
    });
    if (variant === 'accepted') {
      expect(result.returned).toBe('PASS');
      expect(entry.error).not.toHaveBeenCalled();
      expect(result.reports).toContainEqual(
        expect.objectContaining({
          kind: 'original-default-policy-external-https',
          originalSemanticHeading: 'Example Domain',
          localDestinationGrantIssued: false,
          binding: successor,
        })
      );
      expect(ports.verify).toHaveBeenCalledTimes(2);
    } else {
      expect(result.returned).toBe('FAIL');
      expect(result.reports).toHaveLength(1);
      expect(entry.error.mock.calls[0][1]).toBe(original.failure?.value);
      expect(original.failure?.value).toBeInstanceOf(Error);
      expect((original.failure?.value as Error).message).toBe(
        variant === 'changed-page'
          ? 'EXTERNAL_HTTPS_ORIGINAL_PAGE_CHANGED'
          : 'EXTERNAL_HTTPS_ORIGINAL_PAGE_CONTENT_REQUIRED'
      );
    }
  }
);
