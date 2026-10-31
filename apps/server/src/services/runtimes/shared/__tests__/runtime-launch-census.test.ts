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
  'codex/model-catalog.ts': 1,
  'codex/transport/exec-transport.ts': 3,
  'codex/app-server/process-pool.ts': 1,
  'codex/app-server/protocol/snapshot.ts': 2,
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
const childCalls = new Set([
  'spawn',
  'nodeSpawn',
  'execFile',
  'execFileSync',
  'execFileAsync',
  'query',
]);

/** Parse executable calls; comments and illustrative snippets cannot satisfy the census. */
function census(text: string, name: string): { count: number; unprojected: string[] } {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const unprojected: string[] = [];
  let count = 0;
  function visit(node: ts.Node): void {
    if (ts.isNewExpression(node) && node.expression.getText(source) === 'Codex') {
      count++;
      const options = node.arguments?.[0]?.getText(source) ?? '';
      // A DorkOS credits turn (ADR 261002-221210) wraps the same projected
      // options: `withCodexCredits` only removes names and adds the credits ones.
      const projected =
        options.startsWith('buildCodexOptions(') ||
        /^withCodexCredits\(\s*buildCodexOptions\(/.test(options);
      if (!projected) unprojected.push('Codex');
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
        (name === 'claude-code/sessions/tracked-spawn.ts' && /\benv,/.test(call)) ||
        (name === 'codex/model-catalog.ts' && call === "{ stdio: 'pipe', env: environment }") ||
        // The app-server pool forwards the spec's complete environment, built
        // by the transport through `runtimeEnvironment` (or the credits
        // projection over it) and fingerprinted into the process key.
        (name === 'codex/app-server/process-pool.ts' &&
          call === "{ env: options.env, cwd: options.cwd, stdio: 'pipe' }") ||
        // The protocol-snapshot generator runs the vendored binary with a
        // scratch HOME/CODEX_HOME and nothing inherited at all — stricter than
        // any projection, and never on a turn's path.
        (name === 'codex/app-server/protocol/snapshot.ts' &&
          /^\{[^}]*\benv,?\s*\}$/.test(call.replace(/\s+/g, ' '))) ||
        // The sidecar's env is built by `buildSidecarSpawnEnv`, which projects
        // through `runtimeEnvironment` on both sides (own sign-in and credits).
        (name === 'opencode/server-manager.ts' && /env: buildSidecarSpawnEnv\(/.test(call));
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

  it('rejects a Codex model probe that drops projection or restores ambient inheritance', () => {
    const name = 'codex/model-catalog.ts';
    const source = readFileSync(path.join(root, name), 'utf8');
    const reviewed = "{ stdio: 'pipe', env: environment }";
    expect(source).toContain(reviewed);

    for (const replacement of [
      "{ stdio: 'pipe' }",
      "{ stdio: 'pipe', env: { ...process.env, ...environment } }",
    ]) {
      expect(census(source.replace(reviewed, replacement), name).unprojected).toContain(
        'nodeSpawn'
      );
    }
  });
});
