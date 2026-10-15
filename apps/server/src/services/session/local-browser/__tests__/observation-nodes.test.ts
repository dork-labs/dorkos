import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import type { Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { observationNodes } from '../observation-nodes.js';

describe('observation DOM identity serialization', () => {
  it('collects nested open shadow roots after a keepNames transform in an isolated page', async () => {
    let callback!: () => unknown;
    const page = {
      evaluateHandle: vi.fn(async (evaluate: () => unknown) => {
        callback = evaluate;
        return {};
      }),
    } as unknown as Page;
    await observationNodes(page);
    // tsx preserves function names in the host. Only the callback reaches the renderer.
    const transformed = transformSync(
      `const walk = ${callback.toString()}; globalThis.walk = walk;`,
      {
        keepNames: true,
        loader: 'ts',
        target: 'es2022',
      }
    ).code;
    const host: { walk?: () => unknown } = {};
    runInNewContext(transformed, host);
    const leaf = { localName: 'input', isConnected: true, shadowRoot: null };
    const nested = { shadowRoot: { activeElement: leaf, querySelectorAll: () => [leaf] } };
    const shadowHost = { shadowRoot: { activeElement: nested, querySelectorAll: () => [nested] } };
    const sibling = { shadowRoot: null };
    const document = { activeElement: shadowHost, querySelectorAll: () => [shadowHost, sibling] };
    const nodes = runInNewContext(`(${host.walk!.toString()})()`, { document }) as Set<unknown> & {
      focusedElement: unknown;
    };
    expect(nodes.size).toBe(4);
    expect(nodes.focusedElement).toBe(leaf);
    for (const element of [shadowHost, sibling, nested, leaf])
      expect(nodes.has(element)).toBe(true);
    expect(nodes.has({ shadowRoot: null })).toBe(false);
  });
});
