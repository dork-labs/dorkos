/**
 * Headless test harness for extensions.
 *
 * Provides a mock ExtensionAPI and functions to compile + activate extensions
 * without a browser, used by the MCP `test_extension` tool and the
 * `testExtension()` method on {@link ExtensionManager}.
 *
 * @module services/extensions/extension-test-harness
 */
import type {
  ExtensionPointId,
  ExtensionReadableState,
  ExtensionRecord,
} from '@dorkos/extension-api';
import type { ExtensionCompiler } from './extension-compiler.js';
import type { TestExtensionResult } from './extension-manager-types.js';
import { logger } from '../../lib/logger.js';

/** All known extension slot IDs for contribution counting. */
const ALL_EXTENSION_SLOTS: ExtensionPointId[] = [
  'dashboard.sections',
  'command-palette.items',
  'settings.tabs',
  'sidebar.footer',
  'sidebar.tabs',
  'header.actions',
  'dialog',
  'session.canvas',
];

/**
 * Lightweight ExtensionAPI stub for headless server-side testing.
 * Implements all methods as no-ops while counting registrations per slot.
 *
 * @internal Exported for testing only.
 */
export class MockExtensionAPI {
  readonly id: string;
  private counts: Record<string, number> = {};

  constructor(id: string) {
    this.id = id;
  }

  /** Register a component in a UI slot (counted, returns cleanup no-op). */
  registerComponent(slot: ExtensionPointId, _id: string, _component: unknown): () => void {
    this.counts[slot] = (this.counts[slot] ?? 0) + 1;
    return () => {};
  }

  /** Register a command palette item (counted, returns cleanup no-op). */
  registerCommand(_id: string, _label: string, _callback: () => void): () => void {
    this.counts['command-palette.items'] = (this.counts['command-palette.items'] ?? 0) + 1;
    return () => {};
  }

  /** Register a dialog component (counted, returns open/close no-ops). */
  registerDialog(_id: string, _component: unknown): { open: () => void; close: () => void } {
    this.counts['dialog'] = (this.counts['dialog'] ?? 0) + 1;
    return { open: () => {}, close: () => {} };
  }

  /** Register a settings tab (counted, returns cleanup no-op). */
  registerSettingsTab(_id: string, _label: string, _component: unknown): () => void {
    this.counts['settings.tabs'] = (this.counts['settings.tabs'] ?? 0) + 1;
    return () => {};
  }

  /** No-op: UI command execution. */
  executeCommand(): void {}

  /** No-op: canvas opening. */
  openCanvas(): void {}

  /** No-op: client-side navigation. */
  navigate(): void {}

  /** Returns stub state with all nulls. */
  getState(): ExtensionReadableState {
    return { currentCwd: null, activeSessionId: null, agentId: null };
  }

  /** No-op: state subscription. */
  subscribe(): () => void {
    return () => {};
  }

  /** No-op: returns null (no persisted data). */
  async loadData(): Promise<null> {
    return null;
  }

  /** No-op: data persistence. */
  async saveData(): Promise<void> {}

  /** No-op: toast notification. */
  notify(): void {}

  /** Returns true (all slots available in test context). */
  isSlotAvailable(): boolean {
    return true;
  }

  /** Return registration counts for all known slots (zero for unused). */
  getContributions(): Record<ExtensionPointId, number> {
    return Object.fromEntries(
      ALL_EXTENSION_SLOTS.map((slot) => [slot, this.counts[slot] ?? 0])
    ) as Record<ExtensionPointId, number>;
  }
}

/**
 * Compile and activate an extension against a mock API to verify it loads.
 *
 * @param record - The extension's discovery record
 * @param compiler - Extension compiler instance
 * @returns Test result with contribution counts or error details
 */
export async function testClientExtension(
  record: ExtensionRecord,
  compiler: ExtensionCompiler
): Promise<TestExtensionResult> {
  const { id } = record;

  // Step 1: Compile
  const compileResult = await compiler.compile(record);
  if ('error' in compileResult) {
    return {
      status: 'error',
      id,
      phase: 'compilation',
      errors: compileResult.error.errors,
    };
  }

  // Step 2: Read the compiled bundle
  const bundle = await compiler.readBundle(id, compileResult.sourceHash);
  if (!bundle) {
    return {
      status: 'error',
      id,
      phase: 'compilation',
      error: 'Compiled bundle not found in cache',
    };
  }

  // Step 3: Evaluate the bundle and extract activate()
  try {
    const dataUri = `data:text/javascript;base64,${Buffer.from(bundle).toString('base64')}`;
    const module = await import(/* webpackIgnore: true */ dataUri);

    if (typeof module.activate !== 'function') {
      return {
        status: 'error',
        id,
        phase: 'activation',
        error: 'Extension does not export an activate() function',
      };
    }

    // Step 4: Activate against mock API
    const mockApi = new MockExtensionAPI(id);
    module.activate(mockApi);

    const contributions = mockApi.getContributions();
    const totalContributions = Object.values(contributions).reduce((sum, count) => sum + count, 0);

    logger.info(
      `[Extensions] Test passed for ${id}: ${totalContributions} contribution(s) registered`
    );

    return {
      status: 'ok',
      id,
      contributions,
      message: `Extension activated successfully. Registered ${totalContributions} contribution(s).`,
    };
  } catch (err) {
    return {
      status: 'error',
      id,
      phase: 'activation',
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    };
  }
}

/**
 * Test server-side compilation for an extension without loading it.
 *
 * @param record - The extension's discovery record
 * @param compiler - Extension compiler instance
 * @returns Status string, or null if no server entry
 */
export async function testServerCompilation(
  record: ExtensionRecord,
  compiler: ExtensionCompiler
): Promise<string | null> {
  if (!record.hasServerEntry) return null;

  try {
    const result = await compiler.compileServer(record);
    if ('error' in result) {
      return `Server compilation failed: ${result.error.message}`;
    }
    return 'Server compilation successful';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Server compilation failed: ${message}`;
  }
}
