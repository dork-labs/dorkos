/**
 * A quoted variable followed straight by more of the word (`"$TMPDIR"page.html`) keeps its name
 * apart from the text after it, as the shell reads it, so the guard resolves the path it names.
 *
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  commandReachesProtectedRead,
  shellWriteVerdict,
  type ShellGuardRoots,
} from '../shell-check.js';
import { parseShell } from '../shell-words.js';

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'shell-quoted-')));
const home = path.join(root, 'home');
const dorkHome = path.join(root, 'data');
const agent = path.join(dorkHome, 'agents', 'scout');
for (const file of [path.join(home, '.ssh', 'id_ed25519'), path.join(agent, '.claude', 'x')]) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '');
}
const roots: ShellGuardRoots = {
  cwd: path.join(root, 'work'),
  dorkHome,
  home,
  accounts: [],
  // A folder variable that ends in `/`, as macOS's TMPDIR does.
  env: { HOME: home, DORK_HOME: dorkHome, KEYS: `${home}/.ssh/`, SETUP: `${agent}/.claude/` },
  agentHomes: () => [agent],
};

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('a quoted variable followed by more of the word', () => {
  it.each([
    ['"$TMPDIR"page.html', '${TMPDIR}page.html'],
    ['$TMPDIR"page.html"', '${TMPDIR}page.html'],
    ['"$TMPDIR"\'page.html\'', '${TMPDIR}page.html'],
    ['$TMPDIR\\page.html', '${TMPDIR}page.html'],
    ['"$TMPDIR"/page.html', '$TMPDIR/page.html'],
    ['"$TMPDIR".html', '$TMPDIR.html'],
    ['"$TMPDIRpage"', '$TMPDIRpage'],
    ['"\\$TMPDIR"page', '$TMPDIRpage'],
    ["'$TMPDIR'page", '$TMPDIRpage'],
  ])('%s reads as %s', (word, read) => {
    expect(parseShell(`cat ${word}`)[0]?.words[1]).toBe(read);
  });

  it('the guard sees the protected read it names', async () => {
    expect(await commandReachesProtectedRead('cat "$KEYS"id_ed25519', roots)).toBe(true);
  });

  it('the guard sees the setup write it names', () => {
    expect(shellWriteVerdict('echo "{}" > "$SETUP"settings.json', roots)).toBe('writes');
  });
});

describe('a for-list variable next to another variable', () => {
  it.each([
    'for f in sett; do echo x > "$SETUP""$f"ings.json; done',
    'for f in settings.json; do echo x > "$SETUP$f"; done',
  ])('the guard sees the setup write in %s', (command) => {
    expect(shellWriteVerdict(command, roots)).toBe('writes');
  });

  it.each([
    'echo x > "${DORK_HOME:-$X}/agents/scout/.claude/settings.json"',
    'echo x > ${DORK_HOME:-$X}/agents/scout/.mcp.json',
  ])('the guard sees the setup write past a default in %s', (command) => {
    expect(shellWriteVerdict(command, roots)).toBe('writes');
  });

  it.each(['cat "${HOME:-$X}/.ssh/id_ed25519"', 'cat ${HOME:-$X}/.ssh/id_ed25519'])(
    'the guard sees the protected read past a default in %s',
    async (command) => {
      expect(await commandReachesProtectedRead(command, roots)).toBe(true);
    }
  );

  it.each([
    (home: string) => `for d in ${home}; do echo > \${d:-x}/.dork/agent.json; done`,
    (home: string) => `for d in ${home}; do echo > "\${d:-x}"/.dork/agent.json; done`,
    (home: string) => `for d in ${home}; do echo > \${d:=x}/.dork/agent.json; done`,
    (home: string) => `for d in ${home}; do echo > \${d-}/.dork/agent.json; done`,
  ])('the guard sees the setup write through a list variable with a default (%#)', (command) => {
    expect(shellWriteVerdict(command(agent), roots)).toBe('writes');
  });

  it('a list variable in a form whose value cannot be read is too much to check', () => {
    const command = `for d in ${agent}; do echo > \${d#}/.dork/agent.json; done`;
    expect(shellWriteVerdict(command, roots)).toBe('unreadable');
  });

  it('the guard sees the protected read in a list', async () => {
    expect(
      await commandReachesProtectedRead('for k in id_ed25519; do cat "$KEYS$k"; done', roots)
    ).toBe(true);
  });
});
