import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readManifest } from '@dorkos/shared/manifest';
import { UserConfigSchema } from '@dorkos/shared/config-schema';
import { createDemoHome, demoEnvironment, DEMO_CAST } from '../replay-demo/home.js';
import { ReplaySource } from '../../server/src/services/runtimes/test-mode/replay/source.js';
import { REPLAY_HOME_MARKER } from '../../server/src/lib/replay/isolation.js';
import { env } from '../../server/src/env.js';

const fixture = path.resolve(
  import.meta.dirname,
  '../../server/src/services/runtimes/test-mode/__fixtures__/replay-codex-chat.json'
);
const homes: string[] = [];
const originalTest = env.DORKOS_TEST_RUNTIME;
afterEach(() => {
  env.DORKOS_TEST_RUNTIME = originalTest;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe('minimal replay demo boot', () => {
  it('creates a private, marked home accepted by the real replay source', async () => {
    const home = await createDemoHome(fixture);
    homes.push(home.root);
    vi.stubEnv('DORK_HOME', home.root);
    env.DORKOS_TEST_RUNTIME = true;
    const source = new ReplaySource(home.root, home.recording);
    const events = [];
    for await (const event of source.play('demo')) events.push(event);
    expect(events[0]).toEqual({ type: 'text_delta', data: { text: 'Recorded demo\n\n' } });
    expect(events.at(-1)).toEqual({ type: 'done', data: { sessionId: 'demo' } });
    const marker = fs.lstatSync(path.join(home.root, REPLAY_HOME_MARKER));
    expect(marker.isFile()).toBe(true);
    expect(marker.isSymbolicLink()).toBe(false);
    expect(fs.statSync(home.root).mode & 0o077).toBe(0);
    const config = UserConfigSchema.parse(
      JSON.parse(fs.readFileSync(path.join(home.root, 'config.json'), 'utf8'))
    );
    expect(config.agents.defaultAgent).toBe('scout');
    expect(config.heartbeats.enabled).toBe(false);
    expect(config.scheduler.enabled).toBe(false);
    expect(config.relay.enabled).toBe(false);
    expect(config.extensions.enabled).toEqual([]);
    expect(config.extensions.disabled).toEqual(['hello-world', 'linear-issues']);
    const agents = await Promise.all(
      DEMO_CAST.map((agent) => readManifest(path.join(home.root, 'agents', agent.name)))
    );
    expect(agents.map((agent) => agent?.displayName)).toEqual([
      'Scout',
      'Pixel',
      'Atlas',
      'Quill',
      'Penny',
    ]);
    expect(agents[2]?.runtime).toBe('codex');
    expect(agents.every((agent) => agent?.icon && agent?.color)).toBe(true);
  });

  it('still refuses an unmarked home that demo boot did not create', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'unmarked-demo-'));
    homes.push(home);
    vi.stubEnv('DORK_HOME', home);
    env.DORKOS_TEST_RUNTIME = true;
    fs.copyFileSync(fixture, path.join(home, 'reply.json'));
    expect(() => new ReplaySource(home, 'reply.json')).toThrow();
    expect(fs.existsSync(path.join(home, REPLAY_HOME_MARKER))).toBe(false);
  });

  it('refuses to target the real account folder, even with a fake HOME', async () => {
    const real = path.join(os.userInfo().homedir, '.dork');
    vi.stubEnv('HOME', os.tmpdir());
    await expect(createDemoHome(fixture, real)).rejects.toThrow('real DorkOS');
    await expect(createDemoHome(fixture, path.join(real, 'demo'))).rejects.toThrow('real DorkOS');
  });

  it('never reuses or marks an existing folder or a symlink', async () => {
    const home = await createDemoHome(fixture);
    homes.push(home.root);
    await expect(createDemoHome(fixture, home.root)).rejects.toThrow();
    const alias = `${home.root}-alias`;
    fs.symlinkSync(home.root, alias);
    try {
      await expect(createDemoHome(fixture, alias)).rejects.toThrow();
    } finally {
      fs.unlinkSync(alias);
    }
  });

  it('does not inherit credentials or scheduler and outbound overrides', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'made-up-key');
    vi.stubEnv('DORKOS_TASKS_ENABLED', 'true');
    const result = demoEnvironment(
      { root: '/demo', accountHome: '/demo/home', recording: 'recordings/reply.json' },
      4644,
      4643
    );
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.DORKOS_TEST_RUNTIME).toBe('true');
    expect(result.DORKOS_REPLAY_RECORDING).toBe('recordings/reply.json');
    expect(result.DORKOS_TASKS_ENABLED).toBe('false');
    expect(result.DORKOS_RELAY_ENABLED).toBe('false');
    expect(result.DORKOS_NO_ROOM_INTRODUCTIONS).toBe('true');
    expect(result.DORKOS_SEARCH_NO_EXTERNAL_HISTORY).toBe('true');
    expect(result.HOME).toBe('/demo/home');
  });

  it.each([4242, 6242, 6241, 0, -1, 65536, NaN, 4643])('refuses unsafe server port %s', (port) => {
    expect(() =>
      demoEnvironment({ root: '', accountHome: '', recording: '' }, port, 4643)
    ).toThrow();
  });
});
