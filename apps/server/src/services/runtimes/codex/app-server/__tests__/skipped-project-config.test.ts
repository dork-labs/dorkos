/**
 * DOR-4447: below Full the folder stays untrusted, so Codex skips the
 * project's own `.codex/config.toml` and the MCP servers it names. The model
 * is told so on the first turn of each load, and never what the file says.
 * Made-up repos in a throwaway folder; only the Codex binary is pretend.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeAppServerHarness, PERSON_HOME } from '../../__tests__/app-server-harness.js';
import { skippedProjectConfigNote } from '../thread-trust.js';
import { codexTurnPrompt, noticeBlock, promptToSend } from '../../turn-input.js';

const SERVER = '[mcp_servers.sample]\ncommand = "/bin/echo"\n';

let root: string;
let cwd: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dor4447-')));
  cwd = path.join(root, 'sample-repo');
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
  for (const dir of ['home', 'data']) fs.mkdirSync(path.join(root, dir));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function withConfig(): void {
  fs.mkdirSync(path.join(cwd, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.codex', 'config.toml'), SERVER);
}

describe('the line for a skipped project config', () => {
  it('says the settings and their MCP servers did not load, and how they would', () => {
    withConfig();
    expect(skippedProjectConfigNote('person', undefined, 'untrusted', cwd)).toBe(
      "This project's own Codex settings (.codex/config.toml), and any MCP servers they name, " +
        'did not load in this chat. They load at Full, or once the person trusts this folder in Codex.'
    );
    expect(skippedProjectConfigNote('person', 'untrusted', 'untrusted', cwd)).toContain(
      'The person marked this folder untrusted in Codex'
    );
    expect(skippedProjectConfigNote('credits', undefined, 'untrusted', cwd)).toContain(
      'Chats on DorkOS credits never load them.'
    );
    expect(skippedProjectConfigNote('person', undefined, 'untrusted', cwd)).not.toContain(
      '/bin/echo'
    );
  });

  it('says nothing when the settings load, when no override is sent, or when there are none', () => {
    withConfig();
    expect(skippedProjectConfigNote('person', undefined, 'trusted', cwd)).toBeUndefined();
    expect(skippedProjectConfigNote('person', undefined, undefined, cwd)).toBeUndefined();
    fs.rmSync(path.join(cwd, '.codex'), { recursive: true });
    expect(skippedProjectConfigNote('person', undefined, 'untrusted', cwd)).toBeUndefined();
  });

  it('counts a symlinked config, as Codex follows the link', () => {
    const real = path.join(root, 'shared-config.toml');
    fs.writeFileSync(real, SERVER);
    fs.mkdirSync(path.join(cwd, '.codex'), { recursive: true });
    fs.symlinkSync(real, path.join(cwd, '.codex', 'config.toml'));
    expect(skippedProjectConfigNote('person', undefined, 'untrusted', cwd)).toBeDefined();
  });

  it('counts a file at the repo top for a chat opened in a subfolder', () => {
    withConfig();
    const sub = path.join(cwd, 'packages', 'northwind');
    fs.mkdirSync(sub, { recursive: true });
    expect(skippedProjectConfigNote('person', undefined, 'untrusted', sub)).toBeDefined();
  });

  it('rides as a tag-shaped block just ahead of the person’s words, which stay last', () => {
    const turn = codexTurnPrompt('hello', undefined, '', 's1', {}, { carriesStable: true });
    expect(turn.sendPrompt('NOTE').endsWith(`${noticeBlock('NOTE')}\n\nhello`)).toBe(true);
    expect(turn.sendPrompt(undefined)).toBe(turn.prompt);
    expect(noticeBlock('NOTE')).toBe('<dorkos_notice>\nNOTE\n</dorkos_notice>');
    // A request built without the runtime still carries it, ahead of everything.
    expect(promptToSend({ prompt: 'hello' }, 'NOTE')).toBe(`${noticeBlock('NOTE')}\n\nhello`);
    expect(promptToSend({ prompt: 'hello' }, undefined)).toBe('hello');
  });
});

describe('a turn below Full in a folder with its own Codex settings', () => {
  const harnesses: Array<ReturnType<typeof makeAppServerHarness>> = [];
  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((h) => h.pool.shutdown()));
  });

  async function turns(permissionMode: 'acceptEdits' | 'bypassPermissions'): Promise<string[]> {
    const h = makeAppServerHarness({ realpath: (p) => p });
    harnesses.push(h);
    const base = h.request({ sessionId: 's1' });
    const turn = (boundThreadId?: string) =>
      h.request({
        sessionId: 's1',
        // Built as the runtime builds it, so the notice lands where it really does.
        ...codexTurnPrompt(
          'hello',
          undefined,
          '',
          's1',
          { permissionMode },
          { carriesStable: true }
        ),
        cwd,
        settings: { permissionMode },
        ...(boundThreadId !== undefined ? { boundThreadId } : {}),
        tools: {
          ...base.tools,
          filePolicy: {
            roots: {
              cwd,
              home: path.join(root, 'home'),
              data: path.join(root, 'data'),
              accounts: [],
              agentHomes: [],
              agentFolders: [cwd],
            },
            writable: [cwd],
          },
        },
      });
    await h.run(turn());
    await h.run(turn(h.bindings[0]!.threadId));
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    return fake
      .requestsOf('turn/start')
      .map((params) => (params as { input: Array<{ text: string }> }).input[0]!.text);
  }

  it('tells the model on the load’s first turn, not again while the thread stays loaded', async () => {
    withConfig();
    const [first, second] = await turns('acceptEdits');
    expect(first).toMatch(
      /<dorkos_notice>\nThis project's own Codex settings .* did not load in this chat\..*\n<\/dorkos_notice>\n\nhello$/
    );
    expect(first).not.toContain('/bin/echo');
    expect(second!.endsWith('\n\nhello')).toBe(true);
    expect(second).not.toContain('Codex settings');
  });

  it('says nothing at Full, where the settings load', async () => {
    withConfig();
    const [first] = await turns('bypassPermissions');
    expect(first).not.toContain('Codex settings');
  });
});
