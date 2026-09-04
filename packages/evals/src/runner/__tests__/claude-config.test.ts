/**
 * The controlled `CLAUDE_CONFIG_DIR` an eval turn is measured under.
 *
 * The confound this closes (DOR-1712) is invisible to any assertion about a
 * PASS RATE: a run under the operator's `~/.claude` still goes green, it just
 * measures that machine. So the assertions here are about the paths and the
 * environment the runner constructs — the only surface that can prove the real
 * home is out of the picture without spending a credentialed turn.
 *
 * The half that pulls the other way is asserted just as hard: a config dir is
 * also an identity, and a local `claude auth login` sign-in that lives in the OS
 * keychain belongs to the operator's exact directory. Pinning that run to a
 * fresh directory would sign it out, so the runner declines and says so.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CLAUDE_CREDENTIALS_FILE,
  canPinControlledClaudeConfig,
  inheritedClaudeConfigNotice,
  resolveClaudeConfigPin,
  resolveHostClaudeConfigDir,
  seedControlledClaudeConfig,
} from '../claude-config.js';

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

/** A throwaway sandbox root with a seeded controlled config dir inside it. */
async function seededRoot(): Promise<{
  sandboxRoot: string;
  projectCwd: string;
  configDir: string;
}> {
  root = await mkdtemp(path.join(tmpdir(), 'evals-claude-config-'));
  const sandboxRoot = path.join(root, 'sandbox');
  const projectCwd = path.join(sandboxRoot, 'project');
  await mkdir(projectCwd, { recursive: true });
  return {
    sandboxRoot,
    projectCwd,
    configDir: await seedControlledClaudeConfig(sandboxRoot, projectCwd),
  };
}

/** A fake host config dir, optionally holding a file-shaped sign-in. */
async function hostConfigDir(opts: { withSignIn: boolean }): Promise<string> {
  const dir = path.join(root ?? '', 'host-claude');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'CLAUDE.md'), '# the operator’s own memory\n', 'utf8');
  await mkdir(path.join(dir, 'skills'), { recursive: true });
  if (opts.withSignIn) {
    await writeFile(path.join(dir, CLAUDE_CREDENTIALS_FILE), '{"token":"sign-in"}', 'utf8');
  }
  return dir;
}

describe('resolveHostClaudeConfigDir', () => {
  it('mirrors the SDK subprocess`s own chain: $CLAUDE_CONFIG_DIR, else ~/.claude', () => {
    expect(resolveHostClaudeConfigDir({ env: { CLAUDE_CONFIG_DIR: '/somewhere/.claude2' } })).toBe(
      '/somewhere/.claude2'
    );
    expect(resolveHostClaudeConfigDir({ env: {}, homeDir: '/home/kai' })).toBe(
      path.join('/home/kai', '.claude')
    );
  });

  it('treats an empty variable as unset, the way the credential resolver does', () => {
    expect(
      resolveHostClaudeConfigDir({ env: { CLAUDE_CONFIG_DIR: '  ' }, homeDir: '/home/kai' })
    ).toBe(path.join('/home/kai', '.claude'));
  });
});

describe('seedControlledClaudeConfig', () => {
  it('seeds an EMPTY user-level configuration, and nothing that could steer a turn', async () => {
    const { configDir } = await seededRoot();

    expect(JSON.parse(await readFile(path.join(configDir, 'settings.json'), 'utf8'))).toEqual({});
    // A `projects/` dir is where the SDK writes this run's transcripts, and it
    // is also what makes the directory qualify as an account root for the
    // server's own structural check.
    expect(await readdir(path.join(configDir, 'projects'))).toEqual([]);

    // The whole point: none of the behavior surfaces the operator's real
    // `~/.claude` carries may exist here.
    const entries = await readdir(configDir);
    for (const forbidden of [
      'CLAUDE.md',
      'settings.local.json',
      'skills',
      'agents',
      'commands',
      'plugins',
    ]) {
      expect(entries).not.toContain(forbidden);
    }
  });

  it('answers BOTH first-run gates, including the one keyed by the never-seen project path', async () => {
    const { projectCwd, configDir } = await seededRoot();

    const state = JSON.parse(await readFile(path.join(configDir, '.claude.json'), 'utf8')) as {
      hasCompletedOnboarding: unknown;
      projects: Record<string, { hasTrustDialogAccepted: unknown }>;
    };

    // Both are compared `=== true` in the shipped SDK binary, so `true` is the
    // only value that answers them — a truthy string would not.
    expect(state.hasCompletedOnboarding).toBe(true);
    // The trust gate is keyed by PROJECT PATH, and an eval cwd is a fresh
    // `mkdtemp` that appears in nobody's map. Keying it off anything but the cwd
    // turns actually run in would leave the gate unanswered while looking seeded.
    expect(state.projects[projectCwd]?.hasTrustDialogAccepted).toBe(true);
  });

  it('puts the config dir inside the sandbox root, so the sweep already owns it', async () => {
    const { sandboxRoot, configDir } = await seededRoot();
    expect(path.dirname(configDir)).toBe(sandboxRoot);
  });
});

describe('canPinControlledClaudeConfig', () => {
  it('says yes for a portable credential without touching the disk', async () => {
    await seededRoot();
    expect(
      await canPinControlledClaudeConfig({
        credentialIsPortable: true,
        hostConfigDir: '/definitely/not/a/directory',
      })
    ).toBe(true);
  });

  it('says yes for a local sign-in that is a FILE, which can be carried across', async () => {
    await seededRoot();
    const host = await hostConfigDir({ withSignIn: true });
    expect(
      await canPinControlledClaudeConfig({ credentialIsPortable: false, hostConfigDir: host })
    ).toBe(true);
  });

  it('says no for a keychain sign-in, because moving the directory would sign the run out', async () => {
    await seededRoot();
    const host = await hostConfigDir({ withSignIn: false });
    expect(
      await canPinControlledClaudeConfig({ credentialIsPortable: false, hostConfigDir: host })
    ).toBe(false);
  });
});

describe('resolveClaudeConfigPin', () => {
  it('pins the sandbox dir for a portable credential, and copies NO credential into it', async () => {
    const { configDir } = await seededRoot();
    const host = await hostConfigDir({ withSignIn: true });

    const pin = await resolveClaudeConfigPin({
      claudeConfigDir: configDir,
      credentialIsPortable: true,
      hostConfigDir: host,
    });

    expect(pin).toEqual({ pinned: true, configDir, carriedSignIn: false });
    // A run that already holds a key or a token has no reason to have a
    // credential written into a sandbox a failed eval deliberately retains.
    expect(await readdir(configDir)).not.toContain(CLAUDE_CREDENTIALS_FILE);
  });

  it('carries a file-shaped sign-in across, and only the sign-in', async () => {
    const { configDir } = await seededRoot();
    const host = await hostConfigDir({ withSignIn: true });

    const pin = await resolveClaudeConfigPin({
      claudeConfigDir: configDir,
      credentialIsPortable: false,
      hostConfigDir: host,
    });

    expect(pin).toEqual({ pinned: true, configDir, carriedSignIn: true });
    expect(await readFile(path.join(configDir, CLAUDE_CREDENTIALS_FILE), 'utf8')).toBe(
      '{"token":"sign-in"}'
    );
    // The operator's memory and skills sat right beside that credential file and
    // must not have followed it.
    const entries = await readdir(configDir);
    expect(entries).not.toContain('CLAUDE.md');
    expect(entries).not.toContain('skills');
  });

  it('declines rather than signing a keychain-authenticated run out, and says why', async () => {
    const { configDir } = await seededRoot();
    const host = await hostConfigDir({ withSignIn: false });

    const pin = await resolveClaudeConfigPin({
      claudeConfigDir: configDir,
      credentialIsPortable: false,
      hostConfigDir: host,
    });

    expect(pin.pinned).toBe(false);
    if (pin.pinned) throw new Error('unreachable');
    expect(pin.reason).toBe(inheritedClaudeConfigNotice(host));
    // The notice has one job: make a machine-relative number visible as one, and
    // name the fix.
    expect(pin.reason).toContain(host);
    expect(pin.reason).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });
});
