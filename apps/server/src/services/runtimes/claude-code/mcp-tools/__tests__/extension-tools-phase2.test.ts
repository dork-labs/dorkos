import { describe, it, expect, vi } from 'vitest';
import type { McpToolDeps } from '../types.js';
import { createGetExtensionApiHandler, createTestExtensionHandler } from '../extension-tools.js';
import type { ExtensionManager } from '../../../../extensions/extension-manager.js';

// --- Helpers ---

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

// --- Phase 2 supplementary tests ---

describe('get_extension_api handler (Phase 2 constraints)', () => {
  it('response is under 8KB to stay within MCP response limits', async () => {
    const handler = createGetExtensionApiHandler(createDeps(undefined));

    const result = await handler();

    const text = result.content[0].text;
    const sizeBytes = new TextEncoder().encode(text).byteLength;
    // Increased from 4KB to 8KB to accommodate server-side API documentation
    expect(sizeBytes).toBeLessThan(8192);
  });

  it('contains all ExtensionPointId slot names', async () => {
    const handler = createGetExtensionApiHandler(createDeps(undefined));

    const result = await handler();
    const text = result.content[0].text;

    const expectedSlots = [
      'sidebar.footer',
      'sidebar.tabs',
      'dashboard.sections',
      'header.actions',
      'command-palette.items',
      'dialog',
      'settings.tabs',
      'right-panel',
    ];
    for (const slot of expectedSlots) {
      expect(text).toContain(slot);
    }
  });

  it('documents loadData, saveData, and notify methods', async () => {
    const handler = createGetExtensionApiHandler(createDeps(undefined));

    const result = await handler();
    const text = result.content[0].text;

    expect(text).toContain('loadData');
    expect(text).toContain('saveData');
    expect(text).toContain('notify');
  });

  it('documents the Storage usage example', async () => {
    const handler = createGetExtensionApiHandler(createDeps(undefined));

    const result = await handler();
    const text = result.content[0].text;

    // The reference should show how to use loadData/saveData
    expect(text).toContain('Storage');
    expect(text).toContain('api.loadData');
    expect(text).toContain('api.saveData');
  });

  it('documents the server-side DataProviderContext', async () => {
    const handler = createGetExtensionApiHandler(createDeps(undefined));

    const result = await handler();
    const text = result.content[0].text;

    expect(text).toContain('DataProviderContext');
    expect(text).toContain('ServerExtensionRegister');
    expect(text).toContain('ctx.secrets');
    expect(text).toContain('schedule');
    expect(text).toContain('emit');
  });

  it('documents serverCapabilities manifest field', async () => {
    const handler = createGetExtensionApiHandler(createDeps(undefined));

    const result = await handler();
    const text = result.content[0].text;

    expect(text).toContain('serverCapabilities');
    expect(text).toContain('serverEntry');
    expect(text).toContain('externalHosts');
    expect(text).toContain('secrets');
  });

  it('documents dataProxy manifest field', async () => {
    const handler = createGetExtensionApiHandler(createDeps(undefined));

    const result = await handler();
    const text = result.content[0].text;

    expect(text).toContain('dataProxy');
    expect(text).toContain('baseUrl');
    expect(text).toContain('authHeader');
    expect(text).toContain('authSecret');
    expect(text).toContain('/api/ext/{id}/proxy/*');
  });
});

describe('test_extension handler (Phase 2 error phases)', () => {
  it('returns activation phase error with stack trace', async () => {
    const manager = createMockManager({
      testExtension: vi.fn(async () => ({
        status: 'error' as const,
        id: 'crash-ext',
        phase: 'activation' as const,
        error: 'Cannot read properties of undefined',
        stack: 'TypeError: Cannot read properties of undefined\n    at activate (index.js:5:3)',
      })),
    });
    const handler = createTestExtensionHandler(createDeps(manager));

    const result = await handler({ id: 'crash-ext' });

    expect(result.isError).toBe(true);
    const data = parseResponse(result);
    expect(data.status).toBe('error');
    expect(data.phase).toBe('activation');
    expect(data.error).toContain('Cannot read properties');
    expect(data.stack).toContain('at activate');
  });

  it('returns ok status with zero contributions for no-op extension', async () => {
    const manager = createMockManager({
      testExtension: vi.fn(async () => ({
        status: 'ok' as const,
        id: 'noop-ext',
        contributions: {
          'dashboard.sections': 0,
          'command-palette.items': 0,
          'settings.tabs': 0,
          'sidebar.footer': 0,
          'sidebar.tabs': 0,
          'header.actions': 0,
          dialog: 0,
          'right-panel': 0,
        },
        message: 'Extension activated successfully. Registered 0 contribution(s).',
      })),
    });
    const handler = createTestExtensionHandler(createDeps(manager));

    const result = await handler({ id: 'noop-ext' });

    expect(result.isError).toBeUndefined();
    const data = parseResponse(result);
    expect(data.status).toBe('ok');
    expect(data.message).toContain('0 contribution(s)');
    // All slots should be zero
    for (const count of Object.values(data.contributions)) {
      expect(count).toBe(0);
    }
  });

  it('returns compilation phase error with location details', async () => {
    const manager = createMockManager({
      testExtension: vi.fn(async () => ({
        status: 'error' as const,
        id: 'syntax-ext',
        phase: 'compilation' as const,
        errors: [
          {
            text: 'Expected ";" but found "}"',
            location: { file: 'index.ts', line: 12, column: 1 },
          },
          {
            text: 'Unterminated string literal',
            location: { file: 'index.ts', line: 14, column: 20 },
          },
        ],
      })),
    });
    const handler = createTestExtensionHandler(createDeps(manager));

    const result = await handler({ id: 'syntax-ext' });

    expect(result.isError).toBe(true);
    const data = parseResponse(result);
    expect(data.phase).toBe('compilation');
    expect(data.errors).toHaveLength(2);
    expect(data.errors[0].location.line).toBe(12);
    expect(data.errors[1].text).toContain('Unterminated string literal');
  });
});
