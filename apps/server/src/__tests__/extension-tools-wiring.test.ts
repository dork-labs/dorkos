/**
 * An agent's extension tools reach the extension system (DOR-2858's eval found
 * them cut off). `getExtensionTools` hands a chat only `get_extension_api` when
 * its deps carry no `extensionManager`, and the external `/mcp` server reads
 * the same deps, so a deps object built without it leaves no agent able to
 * create, test or reload an extension. Boot builds that object in `index.ts`,
 * after the extension system has started, which is what this pins.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

describe('extension tools startup wiring', () => {
  it('builds the session tool deps with the extension manager, after it starts', () => {
    const start = source.indexOf('extensionManager = await startExtensions(');
    const depsOpen = source.indexOf('mcpToolDeps = {');
    const depsClose = source.indexOf('\n    };', depsOpen);
    const deps = source.slice(depsOpen, depsClose);

    expect(start).toBeGreaterThan(-1);
    expect(depsOpen).toBeGreaterThan(start);
    expect(deps).toContain('...(extensionManager && { extensionManager })');
  });
});
