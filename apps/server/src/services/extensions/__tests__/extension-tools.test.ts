import { describe, it, expect, vi } from 'vitest';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import {
  createListExtensionsHandler,
  createGetExtensionErrorsHandler,
  createGetExtensionApiHandler,
  createReloadExtensionsHandler,
  createCreateExtensionHandler,
  createTestExtensionHandler,
  getExtensionTools,
} from '../../runtimes/claude-code/mcp-tools/extension-tools.js';
import type { ExtensionRecordPublic, ExtensionManifest } from '@dorkos/extension-api';
import type { ExtensionManager } from '../extension-manager.js';

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
        'sidebar.tabs': 0,
        'header.actions': 0,
        dialog: 0,
        'right-panel': 0,
      },
      message: 'Extension activated successfully. Registered 1 contribution(s).',
    })),
    getServerRouter: vi.fn(() => null),
    testServerCompilation: vi.fn(async () => null),
    ...overrides,
  } as unknown as ExtensionManager;
}

function createDeps(extensionManager?: ExtensionManager): McpToolDeps {
  return {
    transcriptReader: {} as McpToolDeps['transcriptReader'],
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
  it('returns extensions with count when manager is available', async () => {
    const manager = createMockManager({
      listPublic: vi.fn(() => [
        makePublicRecord('ext-a', { status: 'compiled', bundleReady: true }),
        makePublicRecord('ext-b', {
          status: 'disabled',
          manifest: { id: 'ext-b', name: 'Ext B', version: '2.0.0', description: 'A cool ext' },
        }),
      ]),
    });
    const handler = createListExtensionsHandler(createDeps(manager));

    const result = await handler();

    const data = parseResponse(result);
    expect(data.count).toBe(2);
    expect(data.extensions).toHaveLength(2);
    expect(data.extensions[0]).toMatchObject({
      id: 'ext-a',
      name: 'ext-a',
      version: '1.0.0',
      status: 'compiled',
      scope: 'global',
      bundleReady: true,
    });
    expect(data.extensions[1]).toMatchObject({
      id: 'ext-b',
      description: 'A cool ext',
    });
  });

  it('returns empty list when no extensions are discovered', async () => {
    const manager = createMockManager();
    const handler = createListExtensionsHandler(createDeps(manager));

    const result = await handler();

    const data = parseResponse(result);
    expect(data.count).toBe(0);
    expect(data.extensions).toEqual([]);
  });

  it('returns error when extension manager is not available', async () => {
    const handler = createListExtensionsHandler(createDeps(undefined));

    const result = await handler();

    expect(result.isError).toBe(true);
    const data = parseResponse(result);
    expect(data.error).toBe('Extension system is not available');
  });

  it('includes error details for extensions with errors', async () => {
    const manager = createMockManager({
      listPublic: vi.fn(() => [
        makePublicRecord('broken', {
          status: 'compile_error',
          error: { code: 'compilation_failed', message: 'Syntax error' },
        }),
      ]),
    });
    const handler = createListExtensionsHandler(createDeps(manager));

    const result = await handler();

    const data = parseResponse(result);
    expect(data.extensions[0].error).toEqual({
      code: 'compilation_failed',
      message: 'Syntax error',
    });
  });

  it('excludes description when not present in manifest', async () => {
    const manager = createMockManager({
      listPublic: vi.fn(() => [makePublicRecord('no-desc')]),
    });
    const handler = createListExtensionsHandler(createDeps(manager));

    const result = await handler();

    const data = parseResponse(result);
    expect(data.extensions[0]).not.toHaveProperty('description');
  });

  it('includes hasServerEntry and hasDataProxy flags for each extension', async () => {
    const manager = createMockManager({
      listPublic: vi.fn(() => [
        makePublicRecord('client-only', { hasServerEntry: false, hasDataProxy: false }),
        makePublicRecord('server-ext', { hasServerEntry: true, hasDataProxy: false }),
        makePublicRecord('proxy-ext', { hasServerEntry: false, hasDataProxy: true }),
        makePublicRecord('full-ext', { hasServerEntry: true, hasDataProxy: true }),
      ]),
    });
    const handler = createListExtensionsHandler(createDeps(manager));

    const result = await handler();

    const data = parseResponse(result);
    expect(data.extensions[0]).toMatchObject({ hasServerEntry: false, hasDataProxy: false });
    expect(data.extensions[1]).toMatchObject({ hasServerEntry: true, hasDataProxy: false });
    expect(data.extensions[2]).toMatchObject({ hasServerEntry: false, hasDataProxy: true });
    expect(data.extensions[3]).toMatchObject({ hasServerEntry: true, hasDataProxy: true });
  });

  it('reports serverStatus as active when server router exists', async () => {
    const manager = createMockManager({
      listPublic: vi.fn(() => [
        makePublicRecord('active-server', { hasServerEntry: true }),
        makePublicRecord('inactive-server', { hasServerEntry: true }),
      ]),
      getServerRouter: vi.fn((id: string) => (id === 'active-server' ? ({} as never) : null)),
    });
    const handler = createListExtensionsHandler(createDeps(manager));

    const result = await handler();

    const data = parseResponse(result);
    expect(data.extensions[0].serverStatus).toBe('active');
    expect(data.extensions[1].serverStatus).toBe('inactive');
  });
});

describe('get_extension_errors handler', () => {
  it('returns only extensions in error states', async () => {
    const manager = createMockManager({
      listPublic: vi.fn(() => [
        makePublicRecord('healthy', { status: 'compiled', bundleReady: true }),
        makePublicRecord('invalid-ext', {
          status: 'invalid',
          error: { code: 'invalid_manifest', message: 'Bad manifest' },
        }),
        makePublicRecord('broken', {
          status: 'compile_error',
          error: { code: 'compilation_failed', message: 'Syntax error' },
        }),
        makePublicRecord('incompat', { status: 'incompatible' }),
        makePublicRecord('active-ext', { status: 'active', bundleReady: true }),
        makePublicRecord('act-err', {
          status: 'activate_error',
          error: { code: 'activate_error', message: 'Activation failed' },
        }),
      ]),
    });
    const handler = createGetExtensionErrorsHandler(createDeps(manager));

    const result = await handler();

    const data = parseResponse(result);
    expect(data.count).toBe(4);
    const ids = data.errors.map((e: { id: string }) => e.id);
    expect(ids).toContain('invalid-ext');
    expect(ids).toContain('broken');
    expect(ids).toContain('incompat');
    expect(ids).toContain('act-err');
    expect(ids).not.toContain('healthy');
    expect(ids).not.toContain('active-ext');
  });

  it('returns empty list when no extensions have errors', async () => {
    const manager = createMockManager({
      listPublic: vi.fn(() => [
        makePublicRecord('ok-1', { status: 'compiled' }),
        makePublicRecord('ok-2', { status: 'disabled' }),
      ]),
    });
    const handler = createGetExtensionErrorsHandler(createDeps(manager));

    const result = await handler();

    const data = parseResponse(result);
    expect(data.count).toBe(0);
    expect(data.errors).toEqual([]);
  });

  it('returns error when extension manager is not available', async () => {
    const handler = createGetExtensionErrorsHandler(createDeps(undefined));

    const result = await handler();

    expect(result.isError).toBe(true);
    const data = parseResponse(result);
    expect(data.error).toBe('Extension system is not available');
  });
});

describe('get_extension_api handler', () => {
  it('returns the API reference as text content', async () => {
    const handler = createGetExtensionApiHandler(createDeps(undefined));

    const result = await handler();

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('ExtensionAPI');
    expect(result.content[0].text).toContain('registerComponent');
    expect(result.content[0].text).toContain('ExtensionPointId');
  });

  it('works without extension manager (always available)', async () => {
    const handler = createGetExtensionApiHandler(createDeps(undefined));

    const result = await handler();

    // No isError — should always succeed
    expect(result).not.toHaveProperty('isError');
    expect(result.content[0].text).toContain('ExtensionModule');
  });

  it('includes usage examples in the reference', async () => {
    const handler = createGetExtensionApiHandler(createDeps(undefined));

    const result = await handler();

    expect(result.content[0].text).toContain('Usage Examples');
    expect(result.content[0].text).toContain('dashboard.sections');
    expect(result.content[0].text).toContain('api.registerCommand');
  });
});

describe('reload_extensions handler', () => {
  it('performs full reload when no id is provided', async () => {
    const reloadResult = [makePublicRecord('ext-a', { status: 'compiled', bundleReady: true })];
    const manager = createMockManager({
      reload: vi.fn(async () => reloadResult),
    });
    const handler = createReloadExtensionsHandler(createDeps(manager));

    const result = await handler({});

    const data = parseResponse(result);
    expect(data.ok).toBe(true);
    expect(data.extensions).toEqual(reloadResult);
    expect(data.count).toBe(1);
    expect(manager.reload).toHaveBeenCalledOnce();
    expect(manager.reloadExtension).not.toHaveBeenCalled();
  });

  it('performs targeted reload when id is provided', async () => {
    const reloadResult = {
      id: 'my-ext',
      status: 'compiled' as const,
      bundleReady: true,
      sourceHash: 'abc123',
    };
    const manager = createMockManager({
      reloadExtension: vi.fn(async () => reloadResult),
    });
    const handler = createReloadExtensionsHandler(createDeps(manager));

    const result = await handler({ id: 'my-ext' });

    const data = parseResponse(result);
    expect(data.ok).toBe(true);
    expect(data.extension).toEqual(reloadResult);
    expect(manager.reloadExtension).toHaveBeenCalledWith('my-ext');
    expect(manager.reload).not.toHaveBeenCalled();
  });

  it('returns error when reload throws', async () => {
    const manager = createMockManager({
      reload: vi.fn(async () => {
        throw new Error('Filesystem unavailable');
      }),
    });
    const handler = createReloadExtensionsHandler(createDeps(manager));

    const result = await handler({});

    expect(result.isError).toBe(true);
    const data = parseResponse(result);
    expect(data.error).toBe('Filesystem unavailable');
    expect(data.code).toBe('RELOAD_FAILED');
  });

  it('returns error when targeted reload throws for unknown extension', async () => {
    const manager = createMockManager({
      reloadExtension: vi.fn(async () => {
        throw new Error("Extension 'ghost' not found");
      }),
    });
    const handler = createReloadExtensionsHandler(createDeps(manager));

    const result = await handler({ id: 'ghost' });

    expect(result.isError).toBe(true);
    const data = parseResponse(result);
    expect(data.error).toContain("Extension 'ghost' not found");
  });

  it('returns error when extension manager is not available', async () => {
    const handler = createReloadExtensionsHandler(createDeps(undefined));

    const result = await handler({});

    expect(result.isError).toBe(true);
    const data = parseResponse(result);
    expect(data.error).toBe('Extension system is not available');
  });
});

describe('create_extension handler', () => {
  it('creates an extension with default template and scope', async () => {
    const manager = createMockManager();
    const handler = createCreateExtensionHandler(createDeps(manager));

    const result = await handler({ name: 'my-widget' });

    const data = parseResponse(result);
    expect(data.id).toBe('new-ext');
    expect(data.bundleReady).toBe(true);
    expect(manager.createExtension).toHaveBeenCalledWith({
      name: 'my-widget',
      description: undefined,
      template: 'dashboard-card',
      scope: 'global',
    });
  });

  it('passes all options to createExtension', async () => {
    const manager = createMockManager();
    const handler = createCreateExtensionHandler(createDeps(manager));

    await handler({
      name: 'custom-ext',
      description: 'My custom extension',
      template: 'command',
      scope: 'local',
    });

    expect(manager.createExtension).toHaveBeenCalledWith({
      name: 'custom-ext',
      description: 'My custom extension',
      template: 'command',
      scope: 'local',
    });
  });

  it('supports settings-panel template', async () => {
    const manager = createMockManager();
    const handler = createCreateExtensionHandler(createDeps(manager));

    await handler({ name: 'prefs', template: 'settings-panel' });

    expect(manager.createExtension).toHaveBeenCalledWith(
      expect.objectContaining({ template: 'settings-panel' })
    );
  });

  it('returns error when createExtension throws', async () => {
    const manager = createMockManager({
      createExtension: vi.fn(async () => {
        throw new Error("Extension 'dupe' already exists at /path");
      }),
    });
    const handler = createCreateExtensionHandler(createDeps(manager));

    const result = await handler({ name: 'dupe' });

    expect(result.isError).toBe(true);
    const data = parseResponse(result);
    expect(data.error).toContain("Extension 'dupe' already exists");
  });

  it('returns error when extension manager is not available', async () => {
    const handler = createCreateExtensionHandler(createDeps(undefined));

    const result = await handler({ name: 'orphan' });

    expect(result.isError).toBe(true);
    const data = parseResponse(result);
    expect(data.error).toBe('Extension system is not available');
  });
});

describe('test_extension handler', () => {
  it('returns test result on success', async () => {
    const manager = createMockManager();
    const handler = createTestExtensionHandler(createDeps(manager));

    const result = await handler({ id: 'test-ext' });

    const data = parseResponse(result);
    expect(data.status).toBe('ok');
    expect(data.id).toBe('test-ext');
    expect(data.contributions['dashboard.sections']).toBe(1);
    expect(data.message).toContain('1 contribution(s)');
    expect(result.isError).toBeUndefined();
    expect(manager.testExtension).toHaveBeenCalledWith('test-ext');
  });

  it('returns isError true when test reports error status', async () => {
    const manager = createMockManager({
      testExtension: vi.fn(async () => ({
        status: 'error' as const,
        id: 'broken-ext',
        phase: 'compilation' as const,
        errors: [{ text: 'Unexpected token' }],
      })),
    });
    const handler = createTestExtensionHandler(createDeps(manager));

    const result = await handler({ id: 'broken-ext' });

    expect(result.isError).toBe(true);
    const data = parseResponse(result);
    expect(data.status).toBe('error');
    expect(data.phase).toBe('compilation');
    expect(data.errors).toHaveLength(1);
  });

  it('returns error when testExtension throws', async () => {
    const manager = createMockManager({
      testExtension: vi.fn(async () => {
        throw new Error("Extension 'ghost' not found");
      }),
    });
    const handler = createTestExtensionHandler(createDeps(manager));

    const result = await handler({ id: 'ghost' });

    expect(result.isError).toBe(true);
    const data = parseResponse(result);
    expect(data.error).toContain("Extension 'ghost' not found");
    expect(data.code).toBe('TEST_FAILED');
  });

  it('returns error when extension manager is not available', async () => {
    const handler = createTestExtensionHandler(createDeps(undefined));

    const result = await handler({ id: 'any' });

    expect(result.isError).toBe(true);
    const data = parseResponse(result);
    expect(data.error).toBe('Extension system is not available');
  });

  it('includes serverCompileStatus when extension has server entry', async () => {
    const manager = createMockManager({
      testServerCompilation: vi.fn(async () => 'Server compilation successful'),
    });
    const handler = createTestExtensionHandler(createDeps(manager));

    const result = await handler({ id: 'test-ext' });

    const data = parseResponse(result);
    expect(data.status).toBe('ok');
    expect(data.serverCompileStatus).toBe('Server compilation successful');
  });

  it('includes serverCompileStatus with error when server compilation fails', async () => {
    const manager = createMockManager({
      testServerCompilation: vi.fn(async () => 'Server compilation failed: Syntax error'),
    });
    const handler = createTestExtensionHandler(createDeps(manager));

    const result = await handler({ id: 'test-ext' });

    const data = parseResponse(result);
    expect(data.status).toBe('ok');
    expect(data.serverCompileStatus).toContain('Server compilation failed');
  });

  it('omits serverCompileStatus when extension has no server entry', async () => {
    const manager = createMockManager({
      testServerCompilation: vi.fn(async () => null),
    });
    const handler = createTestExtensionHandler(createDeps(manager));

    const result = await handler({ id: 'test-ext' });

    const data = parseResponse(result);
    expect(data.status).toBe('ok');
    expect(data).not.toHaveProperty('serverCompileStatus');
  });
});

describe('getExtensionTools', () => {
  it('returns only get_extension_api when manager is not available', () => {
    const tools = getExtensionTools(createDeps(undefined));

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('get_extension_api');
  });

  it('returns all 6 tools when manager is available', () => {
    const manager = createMockManager();
    const tools = getExtensionTools(createDeps(manager));

    expect(tools).toHaveLength(6);
    const names = tools.map((t) => t.name);
    expect(names).toContain('get_extension_api');
    expect(names).toContain('list_extensions');
    expect(names).toContain('get_extension_errors');
    expect(names).toContain('create_extension');
    expect(names).toContain('reload_extensions');
    expect(names).toContain('test_extension');
  });
});
