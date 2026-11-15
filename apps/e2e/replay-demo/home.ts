import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserConfigSchema } from '@dorkos/shared/config-schema';
import { AgentManifestSchema } from '@dorkos/shared/mesh-schemas';
import { writeManifest } from '@dorkos/shared/manifest';
import { seedAgentFace } from '@dorkos/shared/agent-face';

const DRIVE = '/Volumes/ext-ssd-1';
const EXTERNAL_ROOT = path.join(DRIVE, 'dork-os/test-homes');
const MARKER = '.dorkos-recorded-demo';
const STAMP = '2026-11-13T12:00:00.000Z';

/** Fictional video cast v2; stable IDs keep each generated Block Buddy consistent. */
export const DEMO_CAST = [
  {
    name: 'scout',
    displayName: 'Scout',
    description: 'Research and triage',
    runtime: 'claude-code',
  },
  {
    name: 'pixel',
    displayName: 'Pixel',
    description: 'Design, images and screens',
    runtime: 'claude-code',
  },
  {
    name: 'atlas',
    displayName: 'Atlas',
    description: 'Plans, schedules and releases',
    runtime: 'codex',
  },
  { name: 'quill', displayName: 'Quill', description: 'Writing', runtime: 'claude-code' },
  {
    name: 'penny',
    displayName: 'Penny',
    description: 'Timesheets and invoices',
    runtime: 'claude-code',
  },
] as const;

/** Prepared paths handed to the launcher; the recording is always home-relative. */
export interface DemoHome {
  root: string;
  recording: string;
  accountHome: string;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** Prefer the mounted media drive; otherwise use the system temporary directory. */
export function demoHomeRoot(): string {
  if (!fs.existsSync(DRIVE)) return fs.realpathSync(os.tmpdir());
  // Refuse a redirected test-homes folder before writing anything beneath it.
  let existing = EXTERNAL_ROOT;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  if (!inside(fs.realpathSync(DRIVE), fs.realpathSync(existing)))
    throw new Error('Demo homes must stay on the demo drive.');
  fs.mkdirSync(EXTERNAL_ROOT, { recursive: true, mode: 0o700 });
  return fs.realpathSync(EXTERNAL_ROOT);
}

/** Create a NEW, private demo home; never reuse, delete or mark an existing folder. */
export async function createDemoHome(fixture: string, target?: string): Promise<DemoHome> {
  const production = path.join(os.userInfo().homedir, '.dork');
  if (target && inside(production, path.resolve(target)))
    throw new Error('Demo boot cannot target the real DorkOS folder.');
  const parent = demoHomeRoot();
  if (target && fs.realpathSync(path.dirname(path.resolve(target))) !== parent)
    throw new Error('Demo boot needs a new folder directly inside the demo homes directory.');
  // Read a trusted, checked-in fixture, never a real transcript or external path.
  const bytes = fs.readFileSync(fixture);
  const root = target
    ? (fs.mkdirSync(path.resolve(target), { mode: 0o700 }), path.resolve(target))
    : fs.mkdtempSync(path.join(parent, `${new Date().toISOString().slice(0, 10)}-demo-`));
  const accountHome = path.join(root, 'home');
  fs.mkdirSync(accountHome, { mode: 0o700 });
  fs.mkdirSync(path.join(root, 'recordings'));
  const recording = 'recordings/reply.json';
  fs.writeFileSync(path.join(root, recording), bytes, { flag: 'wx', mode: 0o600 });
  const config = UserConfigSchema.parse({
    version: 1,
    onboarding: { completedAt: STAMP, dismissedAt: STAMP },
    profile: {
      displayName: 'Maya Okafor',
      roles: ['design'],
      rolePromptDismissedAt: STAMP,
      identityPromptDismissedAt: STAMP,
    },
    ui: { trustNoticeSeenAt: STAMP },
    agents: { defaultDirectory: path.join(root, 'agents'), defaultAgent: 'scout' },
    mesh: { scanRoots: [path.join(root, 'agents')] },
    scheduler: { enabled: false },
    heartbeats: { enabled: false, triageOnCredits: false },
    relay: { enabled: false },
    tunnel: { enabled: false },
    extensions: { enabled: [], disabled: ['hello-world', 'linear-issues'] },
    telemetry: { install: false, heartbeat: false, userHasDecided: true },
  });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config, null, 2), {
    flag: 'wx',
    mode: 0o600,
  });
  for (const [index, agent] of DEMO_CAST.entries()) {
    const id = `01J0000000000000000000000${index + 1}`;
    await writeManifest(
      path.join(root, 'agents', agent.name),
      AgentManifestSchema.parse({
        ...agent,
        id,
        ...seedAgentFace(id),
        namespace: 'harbor-pine',
        registeredAt: STAMP,
        registeredBy: 'demo-boot',
        capabilities: [],
        workspace: { mode: 'home' },
      })
    );
  }
  // Last: a partial preparation must not be accepted by replay.
  fs.writeFileSync(path.join(root, MARKER), 'demo-boot v1\n', { flag: 'wx', mode: 0o600 });
  return { root, accountHome, recording };
}

/** Build a clean child environment: no inherited model keys, auth or runtime overrides. */
export function demoEnvironment(
  home: DemoHome,
  serverPort: number,
  clientPort: number
): NodeJS.ProcessEnv {
  if (
    [serverPort, clientPort].some(
      (port) =>
        !Number.isInteger(port) || port < 1024 || port > 65535 || [4242, 6242, 6241].includes(port)
    ) ||
    serverPort === clientPort
  )
    throw new Error('Demo boot needs two distinct, unprotected ports above 1023.');
  return {
    // eslint-disable-next-line no-restricted-syntax -- the standalone harness has no env.ts; only the executable search path is inherited
    PATH: process.env.PATH,
    HOME: home.accountHome,
    CLAUDE_CONFIG_DIR: path.join(home.accountHome, '.claude'),
    CODEX_HOME: path.join(home.accountHome, '.codex'),
    XDG_CONFIG_HOME: path.join(home.accountHome, '.config'),
    XDG_DATA_HOME: path.join(home.accountHome, '.local/share'),
    OPENCODE_DB: path.join(home.accountHome, '.local/share/opencode/opencode.db'),
    npm_config_userconfig: '/dev/null',
    DORK_HOME: home.root,
    DORKOS_TEST_RUNTIME: 'true',
    DORKOS_REPLAY_RECORDING: home.recording,
    DORKOS_HOST: '127.0.0.1',
    DORKOS_PORT: String(serverPort),
    VITE_PORT: String(clientPort),
    DORKOS_BOUNDARY: home.root,
    DORKOS_DEFAULT_CWD: path.join(home.root, 'agents/scout'),
    DORKOS_SEARCH_NO_EXTERNAL_HISTORY: 'true',
    DORKOS_NO_ROOM_INTRODUCTIONS: 'true',
    DORKOS_RELAY_ENABLED: 'false',
    DORKOS_TASKS_ENABLED: 'false',
    DORKOS_TELEMETRY_DISABLED: 'true',
    DORKOS_UPDATE_CHECK_DISABLED: 'true',
    DORKOS_E2E_NO_HMR: 'true',
  };
}
