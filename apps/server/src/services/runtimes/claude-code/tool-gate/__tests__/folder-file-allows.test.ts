/**
 * Below Full, a folder's own allow rules run only what a person approved (DOR-5237). Real folders
 * in a temp tree; the approval records are handed in, so nothing here touches DorkOS's config.
 * That Claude Code then sends an `ask` to `canUseTool` is proven on the real CLI in
 * `folder-allows.binary.test.ts`.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFolderSettingsEntries } from '../folder-settings-files.js';
import {
  watchFolderAllows,
  watchLaunchFolderAllows,
  type FolderAllowRecords,
  type FolderFileAllowsTurn,
} from '../folder-file-allows.js';

let root: string;
let home: string;
let workspace: string;

/** Write one of a folder's settings files. */
function settings(folder: string, file: string, body: unknown): void {
  fs.mkdirSync(path.join(folder, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(folder, '.claude', file),
    typeof body === 'string' ? body : JSON.stringify(body)
  );
}

/**
 * Records with nothing approved unless a test says so. `localApproved` says whether a folder's
 * local settings, as they read now, are approved.
 */
function records(
  over: Partial<FolderAllowRecords> & { localApproved?: (folder: string) => boolean } = {}
): FolderAllowRecords {
  const { localApproved = () => false, ...rest } = over;
  return {
    approvedRules: () => undefined,
    approvedLocalSettings: (folder) =>
      localApproved(folder)
        ? readFolderSettingsEntries(folder, ['settings.local.json'])
        : undefined,
    rememberPersonAlwaysAllow: () => {},
    ...rest,
  };
}

/** What a launch's repo check would report for `folder`'s committed settings, read now. */
function comparedAt(folder: string): FolderFileAllowsTurn['compared'] {
  const read = readFolderSettingsEntries(folder, ['settings.json']);
  return { folder, rules: read.rules, dirs: read.dirs };
}

/** A turn in the agent's own home. */
function atHome(over: Partial<FolderFileAllowsTurn> = {}): FolderFileAllowsTurn {
  return { ...TURN, cwd: home, ...over };
}

/** A turn in a workspace. */
function inWorkspace(over: Partial<FolderFileAllowsTurn> = {}): FolderFileAllowsTurn {
  return { ...TURN, cwd: workspace, compared: comparedAt(over.cwd ?? workspace), ...over };
}

const TOUCH = { command: 'touch probe-file' };

/** What every turn here shares. */
const TURN = {
  agentId: 'agent-ana',
  get home() {
    return home;
  },
  get dorkHome() {
    return root;
  },
  launchAllows: [] as string[],
  launchDirs: [] as string[],
  get userHome() {
    return path.join(root, 'person');
  },
};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-file-allows-')));
  home = path.join(root, 'agents', 'ana');
  workspace = path.join(root, 'workspaces', 'site');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('in the agent’s own home', () => {
  it('asks about a call only an unapproved local rule allows', async () => {
    settings(home, 'settings.local.json', { permissions: { allow: ['Bash'] } });
    const watch = watchFolderAllows(atHome(), records());
    expect(await watch.mustAsk('Bash', TOUCH)).toBe(true);
    // A tool no unapproved rule names is left to Claude Code.
    expect(await watch.mustAsk('WebFetch', { url: 'https://example.com' })).toBe(false);
  });

  it('reads both settings files', async () => {
    settings(home, 'settings.json', { permissions: { allow: ['Bash(touch probe-file)'] } });
    expect(await watchFolderAllows(atHome(), records()).mustAsk('Bash', TOUCH)).toBe(true);
  });

  it('lets an approved rule run, read fresh on every call', async () => {
    settings(home, 'settings.local.json', { permissions: { allow: ['Bash(touch probe-file)'] } });
    const record: { rules?: string[] } = {};
    const watch = watchFolderAllows(atHome(), records({ approvedRules: () => record.rules }));
    expect(await watch.mustAsk('Bash', TOUCH)).toBe(true);
    record.rules = ['Bash(touch probe-file)'];
    expect(await watch.mustAsk('Bash', TOUCH)).toBe(false);
  });

  it('reads the files on every call', async () => {
    const watch = watchFolderAllows(atHome(), records());
    expect(await watch.mustAsk('Bash', TOUCH)).toBe(false);
    settings(home, 'settings.local.json', { permissions: { allow: ['Bash'] } });
    expect(await watch.mustAsk('Bash', TOUCH)).toBe(true);
  });

  it('still runs what an approved rule covers beside an unapproved one for the same tool', async () => {
    settings(home, 'settings.local.json', {
      permissions: { allow: ['Bash(npm test:*)', 'Bash(curl:*)'] },
    });
    const watch = watchFolderAllows(
      atHome(),
      records({ approvedRules: () => ['Bash(npm test:*)'] })
    );
    expect(await watch.mustAsk('Bash', { command: 'npm test' })).toBe(false);
    expect(await watch.mustAsk('Bash', { command: 'curl example.com' })).toBe(true);
    expect(await watch.mustAsk('Bash', { command: 'npm test && curl example.com' })).toBe(true);
  });

  it('counts the rules the launch passes itself as approved', async () => {
    settings(home, 'settings.local.json', { permissions: { allow: ['Bash'] } });
    const watch = watchFolderAllows(
      atHome({ launchAllows: ['Bash(touch probe-file)'] }),
      records()
    );
    expect(await watch.mustAsk('Bash', TOUCH)).toBe(false);
    expect(await watch.mustAsk('Bash', { command: 'touch other' })).toBe(true);
  });

  it('reaches every shell tool from a shell rule', async () => {
    settings(home, 'settings.local.json', { permissions: { allow: ['Bash'] } });
    const watch = watchFolderAllows(atHome(), records());
    for (const tool of ['Monitor', 'PowerShell']) {
      expect(await watch.mustAsk(tool, TOUCH), tool).toBe(true);
    }
  });

  it('reaches an Edit rule’s family and an MCP server’s tools', async () => {
    settings(home, 'settings.local.json', {
      permissions: { allow: ['Edit(docs/**)', 'mcp__tracker'] },
    });
    const watch = watchFolderAllows(atHome(), records());
    expect(await watch.mustAsk('Write', { file_path: 'docs/a.md' })).toBe(true);
    expect(await watch.mustAsk('mcp__tracker__delete', {})).toBe(true);
    expect(await watch.mustAsk('mcp__other__delete', {})).toBe(false);
  });

  it('treats a file it cannot read or parse as allowing anything', async () => {
    settings(home, 'settings.local.json', '// a comment\n{ "permissions": { "allow": ["Bash"] } }');
    expect(await watchFolderAllows(atHome(), records()).mustAsk('Bash', TOUCH)).toBe(true);
    fs.rmSync(path.join(home, '.claude', 'settings.local.json'));
    fs.mkdirSync(path.join(home, '.claude', 'settings.local.json'));
    expect(await watchFolderAllows(atHome(), records()).mustAsk('WebSearch', {})).toBe(true);
  });

  it('follows a linked settings file', async () => {
    const elsewhere = path.join(root, 'elsewhere.json');
    fs.writeFileSync(elsewhere, JSON.stringify({ permissions: { allow: ['Bash'] } }));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(home, '.claude', 'settings.local.json'));
    expect(await watchFolderAllows(atHome(), records()).mustAsk('Bash', TOUCH)).toBe(true);
  });

  it('reads the home’s files only when the turn stands in the home exactly', async () => {
    settings(home, 'settings.local.json', { permissions: { allow: ['Bash'] } });
    const sub = path.join(home, 'notes');
    fs.mkdirSync(sub);
    expect(await watchFolderAllows(atHome({ cwd: sub }), records()).mustAsk('Bash', TOUCH)).toBe(
      false
    );
    // With no registered agent the home has no yes, so it asks.
    expect(
      await watchFolderAllows(atHome({ agentId: undefined }), records()).mustAsk('Bash', TOUCH)
    ).toBe(true);
  });
});

describe('folder entries', () => {
  const outside = () => path.join(root, 'outside');
  const readOutside = () => ({ file_path: path.join(outside(), 'secret.txt') });

  it('asks for a file or shell call while a folder entry nobody opened is there', async () => {
    settings(home, 'settings.local.json', { permissions: { additionalDirectories: [outside()] } });
    const watch = watchFolderAllows(atHome(), records());
    expect(await watch.mustAsk('Read', readOutside())).toBe(true);
    expect(await watch.mustAsk('Write', readOutside())).toBe(true);
    expect(await watch.mustAsk('Bash', { command: `cat ${outside()}/secret.txt` })).toBe(true);
    expect(await watch.mustAsk('WebFetch', { url: 'https://example.com' })).toBe(false);
  });

  it('reads a relative folder against the settings folder', async () => {
    settings(home, 'settings.local.json', {
      permissions: { additionalDirectories: ['../outside'] },
    });
    const opened = watchFolderAllows(
      atHome({ launchDirs: [path.join(root, 'agents', 'outside')] }),
      records()
    );
    expect(await opened.mustAsk('Read', readOutside())).toBe(false);
  });

  it('lets a folder the launch opened, or a person opened this session, through', async () => {
    settings(home, 'settings.local.json', { permissions: { additionalDirectories: [outside()] } });
    expect(
      await watchFolderAllows(atHome({ launchDirs: [outside()] }), records()).mustAsk(
        'Read',
        readOutside()
      )
    ).toBe(false);
    const watch = watchFolderAllows(atHome(), records());
    await watch.rememberPersonAnswers(async (): Promise<PermissionResult> => ({
      behavior: 'allow',
      updatedInput: {},
      updatedPermissions: [
        { type: 'addDirectories', directories: [outside()], destination: 'session' },
      ],
    }))();
    expect(await watch.mustAsk('Read', readOutside())).toBe(false);
  });
});

describe('which folders are read', () => {
  it('reads the repo top above the working folder', async () => {
    fs.mkdirSync(path.join(home, '.git'));
    settings(home, 'settings.local.json', { permissions: { allow: ['Bash'] } });
    const sub = path.join(home, 'notes');
    fs.mkdirSync(sub);
    expect(await watchFolderAllows(atHome({ cwd: sub }), records()).mustAsk('Bash', TOUCH)).toBe(
      true
    );
    // The repo top is the home: its yes applies there.
    const approved = records({ approvedRules: () => ['Bash'] });
    expect(await watchFolderAllows(atHome({ cwd: sub }), approved).mustAsk('Bash', TOUCH)).toBe(
      false
    );
  });

  it('reads a repo top above the agent home, where the home’s yes does not apply', async () => {
    const repo = path.join(root, 'agents');
    fs.mkdirSync(path.join(repo, '.git'));
    settings(repo, 'settings.local.json', { permissions: { allow: ['Bash'] } });
    const approved = records({ approvedRules: () => ['Bash'] });
    expect(await watchFolderAllows(atHome(), approved).mustAsk('Bash', TOUCH)).toBe(true);
  });

  it('never reads a repo top that is the person’s home folder', async () => {
    const person = path.join(root, 'agents');
    fs.mkdirSync(path.join(person, '.git'));
    settings(person, 'settings.local.json', { permissions: { allow: ['Bash'] } });
    expect(
      await watchFolderAllows(atHome({ userHome: person }), records()).mustAsk('Bash', TOUCH)
    ).toBe(false);
  });

  it('records a person’s answer for the folder it is kept in', async () => {
    fs.mkdirSync(path.join(home, '.git'));
    const sub = path.join(home, 'notes');
    fs.mkdirSync(sub);
    const remember = vi.fn();
    const watch = watchFolderAllows(
      atHome({ cwd: sub }),
      records({ rememberPersonAlwaysAllow: remember })
    );
    const updates: PermissionUpdate[] = [
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'localSettings',
        rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }],
      },
    ];
    await watch.rememberPersonAnswers(async (): Promise<PermissionResult> => ({
      behavior: 'allow',
      updatedInput: {},
      updatedPermissions: updates,
    }))();
    expect(remember).toHaveBeenCalledWith(atHome({ cwd: home }), true, updates);
  });
});

describe('worktrees and links', () => {
  /** `repo` with a `.git` folder, and `wt` a linked worktree of it, laid out as git lays them. */
  function worktree(): { repo: string; wt: string } {
    const repo = path.join(root, 'repo');
    const wt = path.join(root, 'wt');
    const gitDir = path.join(repo, '.git', 'worktrees', 'wt');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
    fs.mkdirSync(path.join(wt, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitDir}\n`);
    return { repo, wt };
  }

  it('reads the checkout that owns a worktree’s git folder, and records there', async () => {
    const { repo, wt } = worktree();
    settings(repo, 'settings.local.json', { permissions: { allow: ['Bash'] } });
    for (const cwd of [wt, path.join(wt, 'sub')]) {
      const remember = vi.fn();
      const watch = watchFolderAllows(
        inWorkspace({ cwd }),
        records({ rememberPersonAlwaysAllow: remember })
      );
      expect(await watch.mustAsk('Bash', TOUCH), cwd).toBe(true);
      const updates: PermissionUpdate[] = [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'localSettings',
          rules: [{ toolName: 'Bash' }],
        },
      ];
      await watch.rememberPersonAnswers(async (): Promise<PermissionResult> => ({
        behavior: 'allow',
        updatedInput: {},
        updatedPermissions: updates,
      }))();
      expect(remember).toHaveBeenCalledWith(expect.objectContaining({ cwd: repo }), false, updates);
    }
  });

  it('reads a worktree of a bare repo as its own repo', async () => {
    const bare = path.join(root, 'bare.git');
    const gitDir = path.join(bare, 'worktrees', 'wt');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
    const wt = path.join(root, 'wt');
    fs.mkdirSync(path.join(wt, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitDir}\n`);
    settings(wt, 'settings.local.json', { permissions: { allow: ['Bash'] } });
    const cwd = path.join(wt, 'sub');
    const remember = vi.fn();
    const watch = watchFolderAllows(
      inWorkspace({ cwd }),
      records({ rememberPersonAlwaysAllow: remember })
    );
    expect(await watch.mustAsk('Bash', TOUCH)).toBe(true);
    // An answer is kept in the working folder there.
    await watch.rememberPersonAnswers(async (): Promise<PermissionResult> => ({
      behavior: 'allow',
      updatedInput: {},
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'localSettings',
          rules: [{ toolName: 'Bash' }],
        },
      ],
    }))();
    expect(remember).toHaveBeenCalledWith(inWorkspace({ cwd }), false, expect.anything());
  });

  it('walks up from the real folder a link leads to', async () => {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'sub'));
    settings(repo, 'settings.local.json', { permissions: { allow: ['Bash'] } });
    fs.mkdirSync(path.join(root, 'links'));
    const link = path.join(root, 'links', 'l');
    fs.symlinkSync(path.join(repo, 'sub'), link);
    expect(
      await watchFolderAllows(inWorkspace({ cwd: link }), records()).mustAsk('Bash', TOUCH)
    ).toBe(true);
  });
});

describe('committed settings outside the compared folder', () => {
  it('counts only the compared folder’s committed rules as approved', async () => {
    const repo = path.join(root, 'workspaces');
    fs.mkdirSync(path.join(repo, '.git'));
    settings(repo, 'settings.json', { permissions: { allow: ['Bash'] } });
    // The launch compared `site`, not the folder above it.
    expect(await watchFolderAllows(inWorkspace(), records()).mustAsk('Bash', TOUCH)).toBe(true);
    expect(
      await watchFolderAllows(inWorkspace({ compared: comparedAt(repo) }), records()).mustAsk(
        'Bash',
        TOUCH
      )
    ).toBe(false);
    // A launch that compared nothing vouches for none.
    settings(workspace, 'settings.json', { permissions: { allow: ['Bash(ls:*)'] } });
    const none = watchFolderAllows(inWorkspace({ compared: undefined }), records());
    expect(await none.mustAsk('Bash', { command: 'ls -la' })).toBe(true);
  });

  it('vouches for the working folder’s committed rules only as the repo check read them', async () => {
    settings(workspace, 'settings.json', { permissions: { allow: ['Bash(ls:*)'] } });
    const turn = { agentId: 'agent-ana', home, cwd: workspace };
    const env = { HOME: path.join(root, 'person') };
    const read = comparedAt(workspace);
    // A rule written after the check read the file, even before this check is built, is not
    // part of what it compared.
    settings(workspace, 'settings.json', { permissions: { allow: ['Bash(ls:*)', 'Bash'] } });
    const checked = watchLaunchFolderAllows({ env }, { ...turn, compared: read });
    expect(await checked.mustAsk('Bash', { command: 'ls -la' })).toBe(false);
    expect(await checked.mustAsk('Bash', TOUCH)).toBe(true);
    // A launch whose check compared nothing (at Full, say) vouches for none of it.
    const unchecked = watchLaunchFolderAllows({ env }, turn);
    expect(await unchecked.mustAsk('Bash', { command: 'ls -la' })).toBe(true);
  });

  it('never counts a rule written between the launch and its first call as approved', async () => {
    settings(workspace, 'settings.json', { permissions: { allow: ['Bash(ls:*)'] } });
    const watch = watchFolderAllows(inWorkspace(), records());
    settings(workspace, 'settings.json', { permissions: { allow: ['Bash(ls:*)', 'Bash'] } });
    expect(await watch.mustAsk('Bash', TOUCH)).toBe(true);
    expect(await watch.mustAsk('Bash', { command: 'ls -la' })).toBe(false);
  });

  it('counts the checkout owning a worktree’s git folder as another folder', async () => {
    const repo = path.join(root, 'repo');
    const wt = path.join(root, 'wt');
    const gitDir = path.join(repo, '.git', 'worktrees', 'wt');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitDir}\n`);
    settings(repo, 'settings.json', { permissions: { allow: ['Bash'] } });
    const watch = watchFolderAllows(inWorkspace({ cwd: wt, compared: comparedAt(wt) }), records());
    expect(await watch.mustAsk('Bash', TOUCH)).toBe(true);
  });
});

describe('the home with no agent id', () => {
  it('vouches for nothing there, whatever the launch compared', async () => {
    settings(home, 'settings.json', { permissions: { allow: ['Bash'] } });
    const watch = watchFolderAllows(
      atHome({ agentId: undefined, compared: comparedAt(home) }),
      records({ localApproved: () => true })
    );
    expect(await watch.mustAsk('Bash', TOUCH)).toBe(true);
  });
});

describe('another spelling of the home', () => {
  /** Whether this file system ignores letter case, as macOS does by default. */
  const caseBlind = () => fs.existsSync(home.toUpperCase());

  it('keeps the home’s own approvals for a case variant of it', async (context) => {
    if (!caseBlind()) context.skip();
    settings(home, 'settings.json', { permissions: { allow: ['Bash'] } });
    const variant = path.join(path.dirname(home), path.basename(home).toUpperCase());
    // Even when the launch says it compared that spelling, the home's rules need a person.
    const watch = watchFolderAllows(
      atHome({ cwd: variant, compared: comparedAt(variant) }),
      records()
    );
    expect(await watch.mustAsk('Bash', TOUCH)).toBe(true);
    const approved = records({ approvedRules: () => ['Bash'] });
    expect(await watchFolderAllows(atHome({ cwd: variant }), approved).mustAsk('Bash', TOUCH)).toBe(
      false
    );
  });

  it('reads a case variant of the person’s home folder as theirs', async (context) => {
    if (!caseBlind()) context.skip();
    const person = path.join(root, 'agents');
    fs.mkdirSync(path.join(person, '.git'));
    settings(person, 'settings.local.json', { permissions: { allow: ['Bash'] } });
    const variant = path.join(root, 'AGENTS');
    expect(
      await watchFolderAllows(atHome({ userHome: variant }), records()).mustAsk('Bash', TOUCH)
    ).toBe(false);
  });
});

describe('a check that cannot finish', () => {
  it('asks', async () => {
    settings(home, 'settings.local.json', { permissions: { allow: ['Bash'] } });
    const broken = records({
      approvedRules: () => {
        throw new Error('config unreadable');
      },
    });
    expect(await watchFolderAllows(atHome(), broken).mustAsk('Bash', TOUCH)).toBe(true);
  });
});

describe('in a workspace', () => {
  it('lets its committed settings.json run as the launch loaded it, and asks about a rule added since', async () => {
    settings(workspace, 'settings.json', { permissions: { allow: ['Bash(ls:*)'] } });
    const watch = watchFolderAllows(inWorkspace(), records());
    expect(await watch.mustAsk('Bash', { command: 'ls -la' })).toBe(false);
    settings(workspace, 'settings.json', { permissions: { allow: ['Bash(ls:*)', 'Bash'] } });
    expect(await watch.mustAsk('Bash', TOUCH)).toBe(true);
  });

  it('lets the local file run as the launch loaded it, and asks about a rule added since', async () => {
    settings(workspace, 'settings.local.json', { permissions: { allow: ['Bash(ls:*)'] } });
    let approvedNow = true;
    const watch = watchFolderAllows(inWorkspace(), records({ localApproved: () => approvedNow }));
    expect(await watch.mustAsk('Bash', { command: 'ls -la' })).toBe(false);
    settings(workspace, 'settings.local.json', { permissions: { allow: ['Bash(ls:*)', 'Bash'] } });
    approvedNow = false;
    expect(await watch.mustAsk('Bash', TOUCH)).toBe(true);
    // The rule the launch loaded still covers its own command.
    expect(await watch.mustAsk('Bash', { command: 'ls -la' })).toBe(false);
    // A person approves the new content on its card.
    approvedNow = true;
    expect(await watch.mustAsk('Bash', TOUCH)).toBe(false);
  });

  it('counts nothing in a file the launch left out as approved', async () => {
    settings(workspace, 'settings.local.json', { permissions: { allow: ['Bash(ls:*)'] } });
    const watch = watchFolderAllows(inWorkspace(), records());
    expect(await watch.mustAsk('Bash', { command: 'ls -la' })).toBe(true);
  });

  it('ignores the home’s files', async () => {
    settings(home, 'settings.local.json', { permissions: { allow: ['Bash'] } });
    expect(await watchFolderAllows(inWorkspace(), records()).mustAsk('Bash', TOUCH)).toBe(false);
  });
});

describe('a person’s Always allow', () => {
  const ALWAYS: PermissionUpdate[] = [
    {
      type: 'addRules',
      behavior: 'allow',
      destination: 'localSettings',
      rules: [{ toolName: 'Bash', ruleContent: 'touch probe-file' }],
    },
  ];

  it('counts as approved from the answer on, and is recorded where it lands', async () => {
    const remember = vi.fn();
    const watch = watchFolderAllows(atHome(), records({ rememberPersonAlwaysAllow: remember }));
    const canUseTool = watch.rememberPersonAnswers(async (): Promise<PermissionResult> => ({
      behavior: 'allow',
      updatedInput: {},
      updatedPermissions: ALWAYS,
    }));
    await canUseTool();
    // Claude Code writes the rule after the answer.
    settings(home, 'settings.local.json', { permissions: { allow: ['Bash(touch probe-file)'] } });
    expect(await watch.mustAsk('Bash', TOUCH)).toBe(false);
    expect(remember).toHaveBeenCalledWith(atHome(), true, ALWAYS);
  });

  it('records nothing for a plain yes or a no', async () => {
    const remember = vi.fn();
    const watch = watchFolderAllows(
      inWorkspace(),
      records({ rememberPersonAlwaysAllow: remember })
    );
    await watch.rememberPersonAnswers(async (): Promise<PermissionResult> => ({
      behavior: 'allow',
      updatedInput: {},
    }))();
    await watch.rememberPersonAnswers(async (): Promise<PermissionResult> => ({
      behavior: 'deny',
      message: 'no',
    }))();
    expect(remember).not.toHaveBeenCalled();
  });
});
