/**
 * @vitest-environment node
 *
 * The protected profile survives a Codex config rebuild that drops the
 * request's profile selection, against the REAL vendored binary.
 *
 * With ChatGPT sign-in, Codex 0.163 resolves workspace routing by rebuilding
 * the thread's config from its session layers with no overrides
 * (`Config::rebuild_with_session_layers`, core/src/config/mod.rs). DorkOS's
 * profile selection travels only in the request's `permissions` field, so the
 * rebuild sees a `[permissions]` table and no `default_permissions`, and every
 * turn failed with "failed to load workspace requirements" (0.133.0).
 *
 * That path needs a real ChatGPT sign-in, which no test here may use. This
 * suite drives its equivalent: `thread/start` and `turn/start` carry the
 * config DorkOS builds as the session layer and NO `permissions` field, so
 * Codex selects the profile from that layer alone, as the rebuild does. Then
 * a shell command inside the sandbox checks the profile Codex really applied:
 * the hidden folders and Claude Code backups stay unreadable, and project
 * writes and network access match the mode.
 *
 * A throwaway `HOME` and `CODEX_HOME`, no auth, file credential stores, and
 * a loopback fake provider. Skipped by name where no vendored binary exists.
 */
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolveCodexVendoredBinary } from '../../check-dependencies.js';
import {
  codexPermissionProfile,
  codexProtectedConfig,
  type CodexFilePolicy,
} from '../../policy/protected-profile.js';
import { codexInitializeParams } from '../handshake.js';
import { completeHostFixture, FIXTURE_BACKUP_NAME } from './fixtures/complete-protected-home.js';
import { shellControlReturned } from './fixtures/protected-probe.js';
import {
  commandOutput,
  execCall,
  fakeProvider,
  fakeProviderConfig,
  killRawAppServers,
  rawAppServer,
  text,
} from './fixtures/raw-app-server.js';

const BINARY = resolveCodexVendoredBinary();
const MODES = ['default', 'acceptEdits', 'bypassPermissions'] as const;

let provider: Awaited<ReturnType<typeof fakeProvider>>;
let base = '';
/** Provider answers for the current row, consumed in order. */
const scripted: Array<(res: http.ServerResponse, body: string) => void> = [];
/** Requests the sandboxed command made to the loopback server. */
let networkHits = 0;
const roots: string[] = [];

const nativeSuite = describe.skipIf(BINARY === null);
nativeSuite('the protected profile without the request’s selection', { timeout: 90_000 }, () => {
  beforeAll(async () => {
    provider = await fakeProvider(scripted, (req, res) => {
      if (!req.url?.startsWith('/net-probe')) return res.writeHead(404).end();
      networkHits += 1;
      res.writeHead(200).end('NET-REACHED');
    });
    base = provider.base;
  });

  afterEach(() => {
    killRawAppServers();
    for (const dir of roots.splice(0))
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    scripted.length = 0;
    networkHits = 0;
  });

  afterAll(() => provider.close());

  it.each(MODES)('Codex applies the DorkOS profile at %s from the config alone', async (mode) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-default-perms-')));
    roots.push(root);
    const [home, data, codexHome, account, project] = [
      'home',
      'data',
      'codex-home',
      'claude-account',
      'project',
    ].map((name) => path.join(root, name));
    for (const folder of [home, data, codexHome, account, project])
      fs.mkdirSync(folder!, { recursive: true });
    fs.writeFileSync(path.join(codexHome!, 'config.toml'), fakeProviderConfig(base));
    const policy: CodexFilePolicy = {
      roots: {
        cwd: project!,
        data: data!,
        home: home!,
        accounts: [account!],
        agentFolders: [project!],
        agentHomes: [],
      },
      writable: [project!],
    };
    // Codex 0.163 on Linux refuses Full beside a Claude Code backup (DOR-3965).
    const withBackups = !(mode === 'bypassPermissions' && process.platform === 'linux');
    completeHostFixture(policy, [home!, data!, codexHome!, account!], {
      withoutClaudeBackups: !withBackups,
    });
    const sshKey = path.join(home!, '.ssh', 'authorized_keys');
    fs.writeFileSync(sshKey, 'CANARY-ssh-key');
    // Well-known credential files, denied home-wide, not only in agent folders (DOR-4388).
    const homeSecrets = [
      '.git-credentials',
      '.kube/config',
      '.pypirc',
      '.gnupg/private.key',
      '.vault-token',
    ].map((rel) => path.join(home!, rel));
    for (const file of homeSecrets) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `CANARY-home-secret:${path.basename(file)}`);
    }
    const backups = path.join(home!, '.claude', 'backups');
    const backup = path.join(backups, FIXTURE_BACKUP_NAME);
    if (withBackups) fs.writeFileSync(backup, 'CANARY-claude-backup');
    const written = path.join(project!, 'written-by-sandbox.txt');

    const settings = { permissionMode: mode };
    let missing: string[] = [];
    const config = codexProtectedConfig(project!, policy, settings, (targets) => {
      missing = targets;
    });
    expect(missing).toEqual([]);
    const profile = codexPermissionProfile(settings);
    const files = (config.permissions as Record<string, { filesystem: Record<string, string> }>)[
      profile
    ]!.filesystem;
    expect(files[path.join(home!, '.ssh')]).toBe('deny');
    expect(files[backups]).toBe('deny');

    const codex = rawAppServer(BINARY!, project!, {
      PATH: '/usr/bin:/bin',
      HOME: home!,
      CODEX_HOME: codexHome!,
    });
    await codex.request('initialize', codexInitializeParams(true));
    codex.notify('initialized');
    // No `permissions` field: the profile can only come from the config layer.
    const started = await codex.request<{
      thread: { id: string };
      activePermissionProfile?: { id: string } | null;
    }>('thread/start', {
      cwd: project,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      config,
    });
    expect(started.activePermissionProfile?.id).toBe(profile);

    const quote = (value: string) => JSON.stringify(value);
    let returned = '';
    scripted.push(
      (res) =>
        res.end(
          execCall(
            [
              'printf PROBE-START',
              `cat ${quote(sshKey)}`,
              `cat ${quote(backup)}`,
              ...homeSecrets.map((file) => `cat ${quote(file)} 2>/dev/null`),
              `ls -A ${quote(path.join(home!, '.kube'))} 2>/dev/null | sed 's/^/KUBE:/'`,
              `ls -A ${quote(backups)} 2>/dev/null | sed 's/^/LISTED:/'`,
              `printf sandbox > ${quote(written)}`,
              `curl -s -m 5 ${base}/net-probe`,
              'printf PROBE-END',
            ].join('; ')
          )
        ),
      (res, body) => {
        returned = body;
        res.end(text('probe finished'));
      }
    );
    await codex.request('turn/start', {
      threadId: started.thread.id,
      input: [{ type: 'text', text: 'probe', text_elements: [] }],
      cwd: project,
    });
    const completed = await codex.until('turn/completed');
    expect(completed.params, codex.stderr().slice(-2000)).toMatchObject({
      turn: { status: 'completed' },
    });

    expect(shellControlReturned(returned, 'PROBE-START')).toBe(true);
    expect(shellControlReturned(returned, 'PROBE-END')).toBe(true);
    // Only what the command printed: the request also echoes the command text.
    const output = commandOutput(returned);
    console.info('Codex default-permissions probe', { mode, output });
    expect(returned).not.toContain('CANARY-ssh-key');
    expect(returned).not.toContain('CANARY-claude-backup');
    expect(output).not.toContain('CANARY-home-secret');
    // The file is denied exactly: its folder still lists.
    expect(output).toContain('KUBE:config');
    expect(output).not.toContain('LISTED:');
    expect(fs.existsSync(written)).toBe(mode !== 'default');
    expect(networkHits > 0).toBe(mode === 'bypassPermissions');
    expect(output.includes('NET-REACHED')).toBe(mode === 'bypassPermissions');
    expect(fs.readFileSync(sshKey, 'utf8')).toBe('CANARY-ssh-key');
  });
});
