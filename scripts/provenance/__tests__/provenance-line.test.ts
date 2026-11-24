/**
 * The provenance CLI for shell callers (`../provenance-line.ts`): which
 * environment it reads, that a public line carries no machine detail, and that
 * `read` prints JSON a `jq` call can use.
 *
 * @module scripts/provenance/__tests__/provenance-line.test
 */
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { fieldsFromEnv, run } from '../provenance-line.ts';

const CHAT = '7c1e4b2a-9f3d-4e8b-a6c5-a1b2c3d4e5f6';
const AGENT_ID = '01KJXYKJYW4N8QGQ5W4GB6YM9J';
const SPACE_ID = '01JD3F1W2KQ8Z0YV9N6B5T4RMA';

const noStdin = (): string => {
  throw new Error('stdin is not read when building');
};

const hasJq = spawnSync('jq', ['--version']).status === 0;

describe('provenance-line build', () => {
  it('builds a public v2 line from a Claude Code environment', () => {
    const result = run(
      ['--visibility', 'public', '--surface', 'github'],
      {
        CLAUDECODE: '1',
        CLAUDE_CONFIG_DIR: '/Users/someone/.claude3',
        CLAUDE_CODE_SESSION_ID: CHAT,
        DORKOS_AGENT_ID: AGENT_ID,
        DORKOS_SPACE_ID: `dork:space:${SPACE_ID}`,
      },
      noStdin
    );
    expect(result).toEqual({
      code: 0,
      stderr: '',
      stdout:
        `<!-- agent:provenance {"v":2,"harness":"claude-code","surface":"github","account":"claude3",` +
        `"agent":"dork:agent:${AGENT_ID}","chat":"dork:chat:7c1e4b2a","space":"dork:space:${SPACE_ID}"} -->\n`,
    });
  });

  it('defaults to unknown visibility, which cuts the chat as public does', () => {
    const vars = { DORKOS_HARNESS: 'codex', DORKOS_SESSION_ID: CHAT };
    expect(run([], vars, noStdin).stdout).toBe(
      run(['--visibility', 'public'], vars, noStdin).stdout
    );
    expect(run([], vars, noStdin).stdout).toContain('"chat":"dork:chat:7c1e4b2a"');
    expect(run(['--visibility', 'private'], vars, noStdin).stdout).toContain(
      `"chat":"dork:chat:${CHAT}"`
    );
  });

  it('prefers the DorkOS session id, then Claude Code, then the legacy name', () => {
    const claude = { CLAUDECODE: '1' };
    expect(
      fieldsFromEnv({ ...claude, DORKOS_SESSION_ID: 'a1', CLAUDE_CODE_SESSION_ID: 'b2' }).chat
    ).toBe('a1');
    expect(
      fieldsFromEnv({ ...claude, CLAUDE_CODE_SESSION_ID: 'b2', CLAUDE_SESSION_ID: 'c3' }).chat
    ).toBe('b2');
    expect(fieldsFromEnv({ ...claude, DORKOS_SESSION_ID: '', CLAUDE_SESSION_ID: 'c3' }).chat).toBe(
      'c3'
    );
  });

  it('reads the Claude session variables only under Claude Code', () => {
    // Purpose: a Claude variable left in a Codex shell must not name a Claude chat.
    const stray = { CLAUDE_CODE_SESSION_ID: 'b2', CLAUDE_SESSION_ID: 'c3' };
    expect(fieldsFromEnv({ DORKOS_HARNESS: 'codex', ...stray })).not.toHaveProperty('chat');
    expect(fieldsFromEnv(stray)).not.toHaveProperty('chat');
    expect(fieldsFromEnv({ DORKOS_HARNESS: 'codex', DORKOS_SESSION_ID: 'a1', ...stray }).chat).toBe(
      'a1'
    );
  });

  it('derives the account as open-pr.sh does, for Claude Code only', () => {
    expect(fieldsFromEnv({ CLAUDECODE: '1' }).account).toBe('claude');
    expect(fieldsFromEnv({ CLAUDECODE: '1', CLAUDE_CONFIG_DIR: '/h/.claude5/' }).account).toBe(
      'claude5'
    );
    expect(
      fieldsFromEnv({ CLAUDECODE: '1', CLAUDE_CONFIG_DIR: '/h/me@example.com' })
    ).not.toHaveProperty('account');
    expect(
      fieldsFromEnv({ DORKOS_HARNESS: 'codex', CLAUDE_CONFIG_DIR: '/h/.claude5' })
    ).not.toHaveProperty('account');
  });

  it('leaves out a value that would not read back instead of repairing it', () => {
    const { stdout } = run(
      [],
      { DORKOS_HARNESS: 'claude', DORKOS_AGENT_ID: 'not an id', DORKOS_SESSION_ID: 'x:y' },
      noStdin
    );
    expect(stdout).toBe('<!-- agent:provenance {"v":2} -->\n');
  });

  it.each([[['--visibility', 'secret']], [['--nope']], [['read', 'extra']]])(
    'refuses bad arguments %j with exit 2 and the usage',
    (argv) => {
      const result = run(argv, {}, () => '');
      expect(result.code).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('usage:');
    }
  );
});

describe('provenance-line read', () => {
  const signed = `Done.\n<!-- flow:provenance {"v":1,"sessionId":"${CHAT}","host":"Jane-Mac.local","resumeUrl":"https://example.invalid"} -->\n`;

  it('prints the normalized signature as one line of JSON', () => {
    const result = run(['read'], {}, () => signed);
    expect(result.code).toBe(0);
    expect(result.stdout.trimEnd()).not.toContain('\n');
    expect(JSON.parse(result.stdout)).toEqual({ name: 'flow:provenance', v: 1, chat: CHAT });
  });

  it('prints null for a body with no signature', () => {
    expect(run(['read'], {}, () => 'Just words.')).toEqual({
      code: 0,
      stdout: 'null\n',
      stderr: '',
    });
  });

  it.skipIf(!hasJq)('feeds jq: a built line read back gives jq the chat', () => {
    const built = run(['--visibility', 'private'], { DORKOS_SESSION_ID: CHAT }, noStdin).stdout;
    const read = run(['read'], {}, () => `Body.\n${built}`).stdout;
    const jq = spawnSync('jq', ['-r', '.chat // empty'], { input: read, encoding: 'utf8' });
    expect(jq.status).toBe(0);
    expect(jq.stdout).toBe(`${CHAT}\n`);
    // The line itself is one jq-readable JSON object once the marker is cut away.
    const json = built.replace(/^<!-- agent:provenance /, '').replace(/ -->\n$/, '');
    expect(spawnSync('jq', ['-c', '.'], { input: json, encoding: 'utf8' }).stdout).toBe(
      `${json}\n`
    );
  });
});
