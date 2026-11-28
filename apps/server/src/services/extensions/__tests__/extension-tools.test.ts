import { describe, it, expect, vi } from 'vitest';
import type { AgentToolDeps } from '../../core/agent-tool-kit/agent-tool-kit.js';
import {
  createListExtensionsHandler,
  createCreateExtensionHandler,
} from '../../runtimes/claude-code/mcp-tools/extension-tools.js';
import type { ExtensionRecordPublic, ExtensionManifest } from '@dorkos/extension-api';
import type { ExtensionManager } from '../extension-manager.js';
import type { ActivityService } from '../../activity/activity-service.js';

// --- Helpers ---

function makePublicRecord(
  id: string,
  overrides: Partial<ExtensionRecordPublic> = {}
): ExtensionRecordPublic {
  return {
    id,
    manifest: { id, name: id, version: '1.0.0' } as ExtensionManifest,
    status: 'disabled',
    scope: 'global',
    bundleReady: false,
    hasServerEntry: false,
    hasDataProxy: false,
    ...overrides,
  };
}

function createMockManager(overrides: Partial<ExtensionManager> = {}): ExtensionManager {
  return {
    listPublic: vi.fn(() => []),
    reload: vi.fn(async () => []),
    reloadExtension: vi.fn(async () => ({
      id: 'test',
      status: 'compiled' as const,
      bundleReady: true,
      sourceHash: 'abc',
    })),
    createExtension: vi.fn(async () => ({
      id: 'new-ext',
      path: '/fake/extensions/new-ext',
      scope: 'global' as const,
      template: 'dashboard-card',
      status: 'compiled' as const,
      bundleReady: true,
      files: ['extension.json', 'index.ts'],
    })),
    testExtension: vi.fn(async () => ({
      status: 'ok' as const,
      id: 'test-ext',
      contributions: {
        'dashboard.sections': 1,
        'command-palette.items': 0,
        'settings.tabs': 0,
        'sidebar.footer': 0,
        dialog: 0,
        'right-panel': 0,
      },
      message: 'Extension activated successfully. Registered 1 contribution(s).',
    })),
    getServerHandler: vi.fn(() => null),
    testServerCompilation: vi.fn(async () => null),
    ...overrides,
  } as unknown as ExtensionManager;
}

function createDeps(extensionManager?: ExtensionManager): AgentToolDeps {
  return {
    transcriptReader: {} as AgentToolDeps['transcriptReader'],
    defaultCwd: '/test',
    extensionManager,
  };
}

/** Parse the JSON text from an MCP tool response. */
function parseResponse(result: {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}) {
  return JSON.parse(result.content[0].text);
}

// --- Tests ---

describe('list_extensions handler', () => {
  it('shows each tool an extension gives agents, with why a refused one is not offered', async () => {
    // Purpose: the API reference sends an agent here to debug a refused tool
    // (DOR-2685), so the status and reason must be in the answer.
    const manager = createMockManager({
      listPublic: vi.fn(() => [
        makePublicRecord('mail', {
          tools: [
            { name: 'send', title: 'Send', tier: 'act', status: 'active' },
            {
              name: 'dump',
              title: 'Dump',
              tier: 'observe',
              status: 'refused',
              reason: 'the input schema uses patternProperties',
            },
          ],
        }),
        makePublicRecord('plain'),
      ]),
    });
    const data = parseResponse(await createListExtensionsHandler(createDeps(manager))());
    expect(data.extensions[0].tools).toEqual([
      { name: 'send', status: 'active' },
      { name: 'dump', status: 'refused', reason: 'the input schema uses patternProperties' },
    ]);
    expect(data.extensions[1]).not.toHaveProperty('tools');
  });

  it('shows each skill and why one is left out', async () => {
    // Purpose: the API reference sends an author here for a skill that never
    // reached agents, with the same plain reason Settings shows.
    const manager = createMockManager({
      listPublic: vi.fn(() => [
        makePublicRecord('mail', {
          skills: [
            { name: 'triage-inbox', status: 'ok' },
            { name: 'gone', status: 'dropped', reason: 'Its folder is missing from skills/.' },
          ],
        }),
        makePublicRecord('plain'),
      ]),
    });
    const data = parseResponse(await createListExtensionsHandler(createDeps(manager))());
    expect(data.extensions[0].skills).toEqual([
      { name: 'triage-inbox', status: 'ok' },
      { name: 'gone', status: 'dropped', reason: 'Its folder is missing from skills/.' },
    ]);
    expect(data.extensions[1]).not.toHaveProperty('skills');
  });
});

describe('create_extension handler', () => {
  it('asks for approval on a Trusted install only in a session, and records the one it got', async () => {
    // Purpose: our agent's door (ADR 261006-225605). The approval is recorded
    // as `extension.auto_approved` with who, which copy and what it covers.
    const permissions = { runtime: 'in-process', net: [], run: [], agents: false };
    const manager = createMockManager({
      createExtension: vi.fn(async () => ({
        id: 'new-ext',
        path: '/fake/extensions/new-ext',
        scope: 'global' as const,
        template: 'dashboard-card',
        status: 'compiled' as const,
        bundleReady: true,
        files: ['extension.json', 'index.ts'],
        autoApproved: permissions,
      })),
    } as Partial<ExtensionManager>);
    const emit = vi.fn();
    const handler = createCreateExtensionHandler(
      { ...createDeps(manager), activityService: { emit } as unknown as ActivityService },
      () => ({ agentPath: '/tmp/agents/nb', chosenFull: true })
    );

    await handler({ name: 'new-ext' });

    expect(manager.createExtension).toHaveBeenCalledWith(
      expect.objectContaining({ approveIfTrusted: true })
    );
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'agent',
        actorId: '/tmp/agents/nb',
        eventType: 'extension.auto_approved',
        resourceId: 'new-ext',
        metadata: { path: '/fake/extensions/new-ext', permissions },
      })
    );
  });

  it('records nothing when the new extension was not approved', async () => {
    const manager = createMockManager();
    const emit = vi.fn();
    const handler = createCreateExtensionHandler(
      { ...createDeps(manager), activityService: { emit } as unknown as ActivityService },
      () => ({ agentPath: '/tmp/agents/nb' })
    );

    await handler({ name: 'new-ext' });

    expect(emit).not.toHaveBeenCalled();
  });
});
