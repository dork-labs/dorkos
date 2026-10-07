/**
 * The `dorkos` server's tool-surface digest, read off the real factory
 * (DOR-2685, task 3.1).
 *
 * The launch fingerprint's `toolSurface` pin relaunches a warm Claude Code
 * process whose digest differs from a fresh build's. Two failures matter, and
 * they pull in opposite directions:
 *
 * - a digest that misses a change leaves a warm process listing tools that
 *   are gone, or never listing new ones;
 * - a digest that moves when nothing changed relaunches every warm process on
 *   every message (the server is rebuilt per dispatch), which is a relaunch
 *   storm that throws away every conversation's prompt cache.
 *
 * So every case here builds the REAL `createDorkOsToolServer` over the real
 * docs registry, the way a launch does.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { ExtensionManifestSchema } from '@dorkos/extension-api';
import { checkDeclaredTools } from '@dorkos/extension-api/tool-check';

vi.mock('../../../../../env.js', () => ({
  env: { DORKOS_PORT: 4242, MCP_API_KEY: undefined },
}));
vi.mock('../../../../../lib/version.js', () => ({ SERVER_VERSION: 'test', IS_DEV_BUILD: false }));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn().mockResolvedValue(null) }));

import { createDorkOsToolServer, dorkosToolSurfaceOf } from '../index.js';
import { toolSurfaceDigest } from '../tool-surface.js';
import { composeCapabilityRegistryForDocs } from '../../../../core/self-description/dorkos-registry.js';
import { composeDorkOsCapabilityRegistry } from '../../../../core/self-description/dorkos-registry.js';
import { CONNECTOR_RUNTIME_CAPABILITY_IDS } from '../../../../connectors/runtime-capability-scope.js';
import { noopLogger } from '@dorkos/shared/logger';
import type { McpToolDeps } from '../types.js';
import type { CapabilityRegistry } from '../../../../core/capabilities/index.js';
import {
  clearTestHomes,
  registerEveryFolderAsHome,
} from '../../../../core/agent-identity/__tests__/agent-home-fixture.js';

beforeEach(() => registerEveryFolderAsHome());
afterEach(() => clearTestHomes());

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../extensions/__fixtures__/agent-tools-ext/extension.json'
);

/** Deps with every optional service handle present, so the whole surface builds. */
function createFullDeps(): McpToolDeps {
  const stub = {} as never;
  return {
    transcriptReader: {
      listSessions: vi.fn().mockResolvedValue([]),
    } as unknown as McpToolDeps['transcriptReader'],
    defaultCwd: '/tmp/dor-2685-surface',
    dorkHome: '/tmp/dorkos-test-home',
    taskStore: stub,
    relayCore: stub,
    adapterManager: stub,
    traceStore: stub,
    bindingStore: stub,
    bindingRouter: stub,
    // A session folder is nobody's mesh agent here.
    meshCore: { getSubjectByPath: () => undefined } as unknown as McpToolDeps['meshCore'],
    extensionManager: stub,
    runtimeRegistry: stub,
    activityService: stub,
  };
}

/** Build the server as a launch would and read back the digest it recorded. */
function surfaceOf(
  registry: CapabilityRegistry,
  hidden: ReadonlySet<string> = new Set(),
  session?: Parameters<typeof createDorkOsToolServer>[1],
  connectorTools?: boolean
): string {
  const server = createDorkOsToolServer(
    createFullDeps(),
    session,
    undefined,
    undefined,
    registry,
    hidden,
    undefined,
    connectorTools
  );
  const digest = dorkosToolSurfaceOf(server.instance);
  expect(digest).toMatch(/^[0-9a-f]{64}$/);
  return digest!;
}

/** The fixture extension's accepted tools, ready to contribute. */
function fixtureContribution() {
  const manifest = ExtensionManifestSchema.parse(JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')));
  return {
    owner: manifest.id,
    displayName: manifest.name,
    tools: checkDeclaredTools(manifest).flatMap((c) =>
      c.ok ? [{ ...c, invoke: async () => 'ok' }] : []
    ),
  };
}

describe('the dorkos tool-surface digest', () => {
  it('is equal for two builds of an unchanged registry', () => {
    // Purpose: the relaunch-storm guard. Every dispatch rebuilds the server; a
    // digest over unsorted keys, Map order, handlers or descriptions with any
    // per-build content would differ here and relaunch every warm process on
    // every message.
    const registry = composeCapabilityRegistryForDocs();
    expect(surfaceOf(registry)).toBe(surfaceOf(registry));
    // And across two separately composed registries, as after a server restart.
    expect(surfaceOf(composeCapabilityRegistryForDocs())).toBe(surfaceOf(registry));
  });

  it('moves when an extension contributes tools and comes back when they leave', () => {
    // Purpose: the two directions a warm process must follow — a started
    // extension's tools appear, a stopped one's disappear.
    const registry = composeCapabilityRegistryForDocs();
    const before = surfaceOf(registry);
    const contributed = registry.contribute(fixtureContribution());
    if (!contributed.ok) throw new Error(contributed.reason);
    const withTools = surfaceOf(registry);
    expect(withTools).not.toBe(before);

    contributed.remove();
    expect(surfaceOf(registry)).toBe(before);
  });

  it('is equal after a restart that re-registers the same declarations', () => {
    // Purpose: a `server.ts`-only save restarts the extension (remove, then
    // contribute the same tools) and must not relaunch a single warm process.
    const registry = composeCapabilityRegistryForDocs();
    const first = registry.contribute(fixtureContribution());
    if (!first.ok) throw new Error(first.reason);
    const running = surfaceOf(registry);

    first.remove();
    const second = registry.contribute(fixtureContribution());
    if (!second.ok) throw new Error(second.reason);
    expect(surfaceOf(registry)).toBe(running);
    second.remove();
  });

  it('moves when a permission hides one tool from the list', () => {
    // Purpose: `hiddenToolNames` is applied before the digest, so a Blocked
    // tool leaves a warm process's list too (the "next turn" promise of
    // `permission-tool-filter.ts`).
    const registry = composeCapabilityRegistryForDocs();
    expect(surfaceOf(registry, new Set(['relay_send']))).not.toBe(surfaceOf(registry));
    // Hiding a name the list does not carry changes nothing.
    expect(surfaceOf(registry, new Set(['not_a_tool']))).toBe(surfaceOf(registry));
  });

  it('counts the connector tools on the launch’s answer, not on the turn context', () => {
    // Purpose: a process warmed for a staged note is built with no turn
    // context, and the turn after it with one. The launch decides from facts
    // that hold for the whole session, so both list the same tools and the
    // turn does not relaunch the process the note was staged into.
    const registry = composeDorkOsCapabilityRegistry({
      logger: noopLogger,
      connectorExecutionDeps: {
        authorization: { assertAvailable: vi.fn() } as never,
        broker: {} as never,
        access: { listRuntimeConnections: vi.fn() } as never,
        requests: { create: vi.fn(), getForRuntime: vi.fn(), waitForResolution: vi.fn() } as never,
      },
    });
    const turnSession = {
      cwd: '/agents/alpha',
      eventQueue: [],
      connectorTurn: {
        isConnectorCapabilityId: (id: string) =>
          CONNECTOR_RUNTIME_CAPABILITY_IDS.some((candidate) => candidate === id),
        resolvePrincipal: vi.fn(),
      },
    } as unknown as Parameters<typeof createDorkOsToolServer>[1];
    const stagedSession = { cwd: '/agents/alpha', eventQueue: [] } as unknown as Parameters<
      typeof createDorkOsToolServer
    >[1];
    const atTurn = surfaceOf(registry, new Set(), turnSession, true);
    expect(surfaceOf(registry, new Set(), stagedSession, true)).toBe(atTurn);
    // And they are counted: a session without them lists something else.
    expect(surfaceOf(registry, new Set(), stagedSession, false)).not.toBe(atTurn);
  });
});

describe('toolSurfaceDigest', () => {
  it('ignores order and handlers, and reads names, descriptions and input schemas', () => {
    // Purpose: the digest is a pure function of what the model can see.
    const a = { name: 'a', inputSchema: { x: z.string() } };
    const b = { name: 'b', inputSchema: {} };
    expect(toolSurfaceDigest([a, b])).toBe(toolSurfaceDigest([b, a]));
    expect(toolSurfaceDigest([a, b])).not.toBe(
      toolSurfaceDigest([{ ...a, inputSchema: { x: z.number() } }, b])
    );
    expect(toolSurfaceDigest([a, b])).not.toBe(toolSurfaceDigest([{ ...a, name: 'c' }, b]));
    // The description tells the model when to use a tool, so it counts too.
    expect(toolSurfaceDigest([{ ...a, description: 'Sends it.' }, b])).not.toBe(
      toolSurfaceDigest([{ ...a, description: 'Sends it now.' }, b])
    );
  });

  it('digests a schema that cannot be listed instead of throwing', () => {
    // Purpose: a launch must always get a fingerprint. An unconvertible schema
    // is a fixed marker, equal to itself across builds.
    const odd = { name: 'odd', inputSchema: { when: z.date() } };
    expect(() => toolSurfaceDigest([odd])).not.toThrow();
    expect(toolSurfaceDigest([odd])).toBe(toolSurfaceDigest([odd]));
  });
});
