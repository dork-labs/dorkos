import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));
const expected: Record<string, number> = {
  'claude-code/claude-code-runtime.ts': 1,
  'claude-code/messaging/message-sender.ts': 1,
  'claude-code/messaging/runtime-cache.ts': 1,
  'claude-code/sessions/pump-launch.ts': 1,
  'claude-code/sessions/tracked-spawn.ts': 1,
  'claude-code/sessions/warm-process-ledger.ts': 1,
  'claude-code/sdk/sdk-utils.ts': 1,
  'claude-code/tooling/provision.ts': 1,
  'codex/codex-runtime.ts': 2,
  'codex/provision.ts': 1,
  'connect/delegated-login.ts': 2,
  'opencode/server-manager.ts': 1,
  'opencode/providers/provision.ts': 1,
  'opencode/providers/ollama-provision.ts': 2,
  'opencode/providers/ollama-catalog.ts': 1,
  'shared/run-probe.ts': 1,
};
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__') return [];
    const name = path.join(dir, entry.name);
    return entry.isDirectory() ? files(name) : entry.name.endsWith('.ts') ? [name] : [];
  });
}
const childCalls = new Set(['spawn', 'execFile', 'execFileSync', 'execFileAsync', 'query']);

/** Parse executable calls; comments and illustrative snippets cannot satisfy the census. */
function census(text: string, name: string): { count: number; unprojected: string[] } {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const unprojected: string[] = [];
  let count = 0;
  function visit(node: ts.Node): void {
    if (ts.isNewExpression(node) && node.expression.getText(source) === 'Codex') {
      count++;
      if (!node.arguments?.[0]?.getText(source).startsWith('buildCodexOptions('))
        unprojected.push('Codex');
    }
    if (ts.isCallExpression(node) && childCalls.has(node.expression.getText(source))) {
      count++;
      const kind = node.expression.getText(source);
      const arg = node.arguments[kind === 'query' ? 0 : 2];
      const call = arg?.getText(source) ?? '';
      // Two query sites consume the single reviewed launch resolver. The SDK
      // spawn hook forwards that SDK's complete env, covered by the SDK test.
      const forwarded =
        (name === 'claude-code/messaging/message-sender.ts' &&
          call === '{ prompt: heldPrompt.prompt, options: sdkOptions }') ||
        (name === 'claude-code/sessions/pump-launch.ts' && call.includes('...plan.sdkOptions')) ||
        (name === 'claude-code/sessions/tracked-spawn.ts' && /\benv,/.test(call));
      if (!forwarded && !(/\benv:/.test(call) && /runtimeEnvironment\(/.test(call)))
        unprojected.push(kind);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { count, unprojected };
}

describe('runtime launch adoption census', () => {
  it('enumerates every real query/constructor/spawn/exec including promisified Ollama calls', () => {
    const found: Record<string, number> = {};
    for (const file of files(root)) {
      const name = path.relative(root, file).split(path.sep).join('/');
      const result = census(readFileSync(file, 'utf8'), name);
      if (result.count) found[name] = result.count;
      expect(result.unprojected, name).toEqual([]);
    }
    expect(found).toEqual(expected);
  });
  it('detects missing env in every Ollama direct call independently', () => {
    for (const name of [
      'opencode/providers/ollama-provision.ts',
      'opencode/providers/ollama-catalog.ts',
    ]) {
      const source = readFileSync(path.join(root, name), 'utf8');
      const matches = [
        ...source.matchAll(
          /env:\s*runtimeEnvironment\('opencode',\s*'(?:locator|provision|process-inspection)'\)/g
        ),
      ];
      expect(matches).toHaveLength(expected[name]);
      for (const match of matches) {
        const mutant = source.slice(0, match.index) + source.slice(match.index! + match[0].length);
        expect(census(mutant, name).unprojected).toHaveLength(1);
      }
    }
  });
});
