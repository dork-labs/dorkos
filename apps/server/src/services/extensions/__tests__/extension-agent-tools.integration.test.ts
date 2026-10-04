/**
 * An extension's agent tools through the real start and stop paths (DOR-2685,
 * task 2.3): real discovery, the real esbuild compile of `server.ts`, the real
 * server lifecycle, and a real capability registry. Only the config store and
 * the logger are stand-ins.
 *
 * The properties: tools join the registry only after `register()` succeeds and
 * leave it first on every stop path; a manifest-only edit restarts the
 * extension; an uninstall clears the extension's tool permission settings.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { noopLogger } from '@dorkos/shared/logger';
import type { ExtensionsConfig } from '../extension-enable-resolution.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const stored = vi.hoisted(() => ({ value: {} as ExtensionsConfig }));
vi.mock('../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'extensions' ? stored.value : undefined),
    set: (key: string, value: unknown) => {
      if (key === 'extensions') stored.value = value as ExtensionsConfig;
    },
  },
}));

import { ExtensionManager } from '../extension-manager.js';
import { composeRegistry, type CapabilityRegistry } from '../../core/capabilities/registry.js';
import { CapabilityToolError } from '../../core/capabilities/mcp-envelope.js';
import { extensionDeclarationDigest } from '../agent-tools/declaration-digest.js';
import { ExtensionManifestSchema } from '@dorkos/extension-api';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../__fixtures__/agent-tools-ext'
);
const ID = 'agent-tools-ext';
const TOOL_IDS = [
  'ext_agent_tools_ext.echo',
  'ext_agent_tools_ext.bump_counter',
  'ext_agent_tools_ext.delete_note',
];

let dorkHome: string;
let extDir: string;
let manager: ExtensionManager;
let registry: CapabilityRegistry;
let forget: ReturnType<typeof vi.fn<(id: string, name: string) => Promise<unknown>>>;

/** Copy the fixture in, optionally replacing its server.ts or editing its manifest. */
async function install(serverTs?: string, editManifest?: (m: Record<string, unknown>) => void) {
  await fs.rm(extDir, { recursive: true, force: true });
  await fs.cp(FIXTURE, extDir, { recursive: true });
  if (serverTs !== undefined) await fs.writeFile(path.join(extDir, 'server.ts'), serverTs);
  if (editManifest) await rewriteManifest(editManifest);
}

/** Read, edit and write back the installed manifest. */
async function rewriteManifest(edit: (m: Record<string, unknown>) => void, spaces = 2) {
  const file = path.join(extDir, 'extension.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf-8')) as Record<string, unknown>;
  edit(manifest);
  await fs.writeFile(file, JSON.stringify(manifest, null, spaces));
}

/** Start the manager the way boot does: start extensions, then attach the registry. */
async function boot(registerTimeoutMs = 15_000) {
  manager = new ExtensionManager(dorkHome, [], { registerTimeoutMs });
  await manager.initialize(null);
  manager.attachAgentTools({ registry, forgetToolPermissions: forget });
}

/** The extension tool ids the registry holds right now. */
function registered(): string[] {
  return registry.capabilities.map((c) => c.id).filter((id) => id.startsWith('ext_'));
}

/** The public tool statuses, by name. */
function statuses(): Record<string, string> {
  const record = manager.listPublic().find((r) => r.id === ID);
  return Object.fromEntries((record?.tools ?? []).map((t) => [t.name, t.status]));
}

beforeEach(async () => {
  dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dor-2685-tools-'));
  extDir = path.join(dorkHome, 'extensions', ID);
  stored.value = {
    enabled: [ID],
    disabled: [],
    approvedToRun: [ID],
    approvedSources: { [ID]: { path: extDir } },
  };
  registry = composeRegistry([], { logger: noopLogger });
  forget = vi.fn<(id: string, name: string) => Promise<unknown>>(async () => []);
});

afterEach(async () => {
  await manager?.shutdownServer(ID);
  await fs.rm(dorkHome, { recursive: true, force: true });
});

describe('extension agent tools through the real lifecycle', () => {
  it('holds tools until the registry is attached, then registers every handled tool', async () => {
    // Purpose: boot starts extensions before the registry exists; their tools
    // must reach agents once it does, and work end to end.
    await install();
    manager = new ExtensionManager(dorkHome, []);
    await manager.initialize(null);
    expect(registered()).toEqual([]);
    expect(statuses()).toEqual({
      echo: 'inactive',
      bump_counter: 'inactive',
      delete_note: 'inactive',
    });

    manager.attachAgentTools({ registry, forgetToolPermissions: forget });
    expect(registered().sort()).toEqual([...TOOL_IDS].sort());
    expect(statuses()).toEqual({ echo: 'active', bump_counter: 'active', delete_note: 'active' });
    expect(await registry.invoke('ext_agent_tools_ext.echo', { message: 'hi' })).toEqual({
      message: 'hi',
    });
    expect(await registry.invoke('ext_agent_tools_ext.bump_counter', {})).toEqual({ total: 1 });
  }, 30_000);

  it('registers nothing when register() throws', async () => {
    // Purpose: an instance that never started offers no tools, even ones it
    // bound before throwing.
    await install(
      `export default function register(_r, ctx) {
        ctx.tools.handle('echo', () => 'x');
        throw new Error('boom');
      }`
    );
    await boot();
    expect(registered()).toEqual([]);
    expect(statuses().echo).toBe('inactive');
  }, 30_000);

  it('registers nothing when register() times out, and ignores a late handle', async () => {
    // Purpose: a register() DorkOS stopped waiting for never offers tools,
    // whatever it binds after the deadline.
    await install(
      `export default function register(_r, ctx) {
        return new Promise((resolve) => setTimeout(() => {
          try { ctx.tools.handle('echo', () => 'late'); } catch {}
          resolve();
        }, 400));
      }`
    );
    await boot(100);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(registered()).toEqual([]);
  }, 30_000);

  it('drops a declared tool with no handler, saying why, and offers the rest', async () => {
    // Purpose: declared-but-unhandled is a clear problem on the record, not a
    // tool that fails when an agent calls it.
    await install(
      `export default function register(_r, ctx) {
        ctx.tools.handle('echo', (input) => input);
      }`
    );
    await boot();
    expect(registered()).toEqual(['ext_agent_tools_ext.echo']);
    const record = manager.listPublic().find((r) => r.id === ID);
    expect(record?.tools?.find((t) => t.name === 'bump_counter')).toMatchObject({
      status: 'refused',
      reason: 'Agent Tools Fixture declares bump_counter but never handles it',
    });
  }, 30_000);

  it('fails to start when a handler names a tool the manifest does not declare', async () => {
    // Purpose: a handler for an undeclared tool is a load error, not a silent no-op.
    await install(
      `export default function register(_r, ctx) {
        ctx.tools.handle('not_declared', () => 1);
      }`
    );
    await boot();
    const result = await manager.initializeServer(ID);
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/declares no tool/) });
    expect(registered()).toEqual([]);
  }, 30_000);

  it('removes the tools before the extension’s own cleanup runs', async () => {
    // Purpose: on stop the tools go first, so nothing can call into an
    // extension that is already tearing itself down.
    await install(
      `export default function register(_r, ctx) {
        ctx.tools.handle('echo', (i) => i);
        ctx.tools.handle('bump_counter', () => 1);
        ctx.tools.handle('delete_note', () => 1);
        return () => { globalThis.__dor2685_cleanup = globalThis.__dor2685_probe(); };
      }`
    );
    const g = globalThis as Record<string, unknown>;
    g.__dor2685_probe = () => registry.get('ext_agent_tools_ext.echo') === undefined;
    await boot();
    expect(registered()).toHaveLength(3);
    await manager.shutdownServer(ID);
    expect(g.__dor2685_cleanup).toBe(true);
    delete g.__dor2685_probe;
    delete g.__dor2685_cleanup;
  }, 30_000);

  it('takes the tools away on disable and brings them back on enable', async () => {
    // Purpose: every stop and start path goes through the one pair.
    await install();
    await boot();
    expect(registered()).toHaveLength(3);
    await manager.disable(ID);
    expect(registered()).toEqual([]);
    await expect(
      registry.invoke('ext_agent_tools_ext.echo', { message: 'x' })
    ).rejects.toBeInstanceOf(CapabilityToolError);
    await manager.enable(ID);
    expect(registered()).toHaveLength(3);
  }, 30_000);

  it('takes the tools away when its run approval is revoked', async () => {
    // Purpose: a person saying stop removes what the extension gave agents.
    await install();
    await boot();
    await manager.revokeRunApproval(ID);
    expect(registered()).toEqual([]);
    // Stopping is not removing: tool settings are kept for when it runs again.
    expect(forget).not.toHaveBeenCalled();
  }, 30_000);

  it('restarts on a tools-only manifest edit and not on a whitespace-only one', async () => {
    // Purpose: a manifest-only change to a tool reaches agents without a
    // version bump or a server.ts edit; reformatting the file restarts nothing.
    await install();
    await boot();
    const changes: number[] = [];
    registry.onChange((v) => changes.push(v));

    await rewriteManifest(() => undefined, 4);
    await manager.reload();
    expect(changes).toEqual([]);

    await rewriteManifest((m) => {
      const tools = m.tools as Array<Record<string, unknown>>;
      tools[0]!.title = 'Echo it back';
    });
    await manager.reload();
    expect(changes.length).toBe(2); // removed, then contributed afresh
    expect(registry.get('ext_agent_tools_ext.echo')?.title).toBe('Echo it back');
  }, 30_000);

  it('restarts on a second start request once the declarations changed, and not before', async () => {
    // Purpose: the client asks every server-side extension to start on every
    // page load; the restart key must treat a changed tool declaration as a
    // new source (and an unchanged one as the same).
    await install();
    await boot();
    const changes: number[] = [];
    registry.onChange((v) => changes.push(v));
    await manager.initializeServer(ID);
    expect(changes).toEqual([]);

    const record = manager.listRecords().find((r) => r.id === ID)!;
    const [first, ...rest] = record.manifest.tools!;
    record.manifest = {
      ...record.manifest,
      tools: [{ ...first!, title: 'Echo it back' }, ...rest],
    };
    await manager.initializeServer(ID);
    expect(changes.length).toBe(2);
    expect(registry.get('ext_agent_tools_ext.echo')?.title).toBe('Echo it back');
  }, 30_000);

  /** A server.ts that counts starts and stops, and waits on a gate the test opens. */
  const COUNTING_SERVER = `export default async function register(_r, ctx) {
    const g = globalThis;
    g.__dor2685_starts = (g.__dor2685_starts ?? 0) + 1;
    ctx.tools.handle('echo', (i) => i);
    ctx.tools.handle('bump_counter', () => 1);
    ctx.tools.handle('delete_note', () => 1);
    if (g.__dor2685_gate) await g.__dor2685_gate;
    return () => { g.__dor2685_stops = (g.__dor2685_stops ?? 0) + 1; };
  }`;

  /** Reset the counting server's globals, with a gate the test opens. */
  function countingGlobals(): { g: Record<string, unknown>; open: () => void } {
    const g = globalThis as Record<string, unknown>;
    let open: () => void = () => undefined;
    g.__dor2685_gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    g.__dor2685_starts = 0;
    g.__dor2685_stops = 0;
    return { g, open };
  }

  it('leaves no live instance or tools after two overlapping starts and a stop', async () => {
    // Purpose: every tab asks for a start on load. Two at once must not leave
    // a first instance nobody can stop, with its tools still callable.
    await install(COUNTING_SERVER);
    const { g, open } = countingGlobals();
    manager = new ExtensionManager(dorkHome, []);
    manager.attachAgentTools({ registry, forgetToolPermissions: forget });
    const booting = manager.initialize(null);
    await vi.waitFor(() => expect(g.__dor2685_starts).toBe(1), { timeout: 20_000 });
    const a = manager.initializeServer(ID);
    const b = manager.initializeServer(ID);
    open();
    await Promise.all([booting, a, b]);
    await manager.shutdownServer(ID);
    expect(registered()).toEqual([]);
    expect(g.__dor2685_stops).toBe(g.__dor2685_starts);
    delete g.__dor2685_gate;
  }, 30_000);

  it('leaves no tools when the extension is turned off while register() runs', async () => {
    // Purpose: a turn-off that lands mid-start wins; the instance that was
    // starting is released and never offers its tools.
    await install(COUNTING_SERVER);
    const { g, open } = countingGlobals();
    manager = new ExtensionManager(dorkHome, []);
    manager.attachAgentTools({ registry, forgetToolPermissions: forget });
    const booting = manager.initialize(null);
    await vi.waitFor(() => expect(g.__dor2685_starts).toBe(1), { timeout: 20_000 });
    const changes: number[] = [];
    registry.onChange((v) => changes.push(v));
    const disabling = manager.disable(ID);
    open();
    await Promise.all([booting, disabling]);
    expect(registered()).toEqual([]);
    // Never offered at all, not offered and then taken back.
    expect(changes).toEqual([]);
    expect(manager.getServerRouter(ID)).toBeNull();
    expect(g.__dor2685_stops).toBe(g.__dor2685_starts);
    delete g.__dor2685_gate;
  }, 30_000);

  it('clears the extension’s tool permission settings on uninstall only', async () => {
    // Purpose: a standing Allowed must not carry over to whatever is installed
    // under the same id next.
    await install();
    await boot();
    await manager.forgetRunApproval(ID, dorkHome);
    expect(registered()).toEqual([]);
    expect(forget).toHaveBeenCalledWith(ID, 'Agent Tools Fixture');
  }, 30_000);
});

describe('extensionDeclarationDigest', () => {
  const base = {
    id: ID,
    name: 'Fixture',
    version: '1.0.0',
    serverCapabilities: {},
    tools: [
      {
        name: 'echo',
        title: 'Echo',
        description: 'Echoes.',
        tier: 'observe',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
  };

  it('changes with the tools or skills and not with unrelated fields or key order', () => {
    // Purpose: exactly the declarations decide a restart.
    const digest = (m: unknown) => extensionDeclarationDigest(ExtensionManifestSchema.parse(m));
    const original = digest(base);
    expect(digest({ ...base, description: 'other words' })).toBe(original);
    const { tools, ...rest } = base;
    expect(digest({ tools, ...rest })).toBe(original);
    expect(digest({ ...base, skills: ['tidy-notes'] })).not.toBe(original);
    expect(
      digest({ ...base, tools: [{ ...base.tools[0], tier: 'act', approvalDisplayFields: [] }] })
    ).not.toBe(original);
  });
});
