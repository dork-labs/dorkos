import { execFileSync } from 'child_process';
import path from 'path';
import { CAPTURE_HOME, REPO_ROOT } from '../config.js';

/**
 * What the demo workspace seeds on top of the capture's own demo data
 * (`run.ts`). Everything here is public-safe and DorkOS-branded: the agents
 * are the capture fleet (`FLEET` in `../config.ts`), and the social posts are
 * ones @dork_os already published.
 *
 * @module capture/demo/config
 */

/**
 * The capture shard slot the demo runs on. A shard index is what derives a
 * stack's ports and `DORK_HOME` (`../config.ts`), so slot 20 gives the demo its
 * own home (`~/.dork-capture-20`) and ports (4544 server, 4543 client), clear
 * of a capture run on slot 0 and of every shard a `--shards N` record uses.
 */
export const DEMO_SHARD = 20;

/** The empty folder the demo server uses as its home (`isolatedHomeEnv` in `../boot.ts`). */
export const DEMO_FAKE_HOME = path.join(CAPTURE_HOME, 'home');

/**
 * Where the demo's copy of the marketing checkout lives. The social-queue
 * extension finds its queue two folders above its own real path
 * (`../../queue`), so a copy at `<this>/extensions/social-queue` reads
 * `<this>/queue`: inside the demo home, never the real queue.
 */
export const DEMO_MARKETING_ROOT = path.join(CAPTURE_HOME, 'marketing');

/** The social-queue extension's id. */
export const SOCIAL_QUEUE_ID = 'social-queue';

/**
 * The id of the extension's right-panel tab: `<extension id>:<component id>`
 * (`extension-api-factory.ts`), from its `registerComponent('right-panel', 'queue', …)`.
 */
export const SOCIAL_QUEUE_PANEL_TAB = `${SOCIAL_QUEUE_ID}:queue`;

/**
 * Where the app keeps the right panel's open state and active tab
 * (`apps/client/src/layers/shared/lib/constants.ts`). No URL opens an
 * extension's tab, so a browser that should land with the Social queue open
 * sets this before the app loads (see the README's demo section).
 */
export const RIGHT_PANEL_STATE_KEY = 'dorkos-right-panel-state';

/** The chat the Social queue tab is filmed beside (the server's `demo-social-chat`). */
export const SOCIAL_CHAT = {
  agent: 'scout',
  scenario: 'demo-social-chat',
  prompt: "What's going out on X this week?",
} as const;

/**
 * The private `dorkos-marketing` checkout the social-queue extension comes
 * from. `DEMO_MARKETING_REPO` wins; otherwise the folder beside the MAIN
 * checkout, found through git's common dir so it also resolves from a
 * worktree. The demo still boots without it; it skips the social-queue flow
 * and says so.
 *
 * @returns The checkout's absolute path.
 */
export function marketingRepoPath(): string {
  // eslint-disable-next-line no-restricted-syntax -- the capture harness has no env.ts
  const configured = process.env.DEMO_MARKETING_REPO;
  if (configured) return path.resolve(configured);
  const commonDir = execFileSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  ).trim();
  return path.resolve(path.dirname(commonDir), '..', 'dorkos-marketing');
}

/**
 * Posts @dork_os already published, by their id in the marketing queue. The
 * demo copies each one into its own queue as `queued`, one a day at 09:30 from
 * the day after the demo starts, so the page reads as upcoming work on
 * whatever day it is recorded. Their words are not changed. Chosen by the
 * marketing claim gate: on-screen copy carries no version numbers, prices or
 * dated stats, which go stale on camera. The same rule holds for every seed.
 */
export const SOCIAL_POST_IDS: readonly string[] = [
  '2026-10-15-marketing-lessons',
  '2026-10-16-hn-timing',
  '2026-10-13-first-100-users',
];

/** One finished heartbeat-style report an agent posts in #team. */
export interface TeamReport {
  /** The fleet agent's slug (`FLEET` in `../config.ts`). */
  readonly agent: string;
  /** What it says. */
  readonly text: string;
}

/** The #team morning: what each agent did overnight, in the order they post. */
export const TEAM_REPORTS: readonly TeamReport[] = [
  {
    agent: 'scout',
    text:
      'Morning report. I checked every package for security notices overnight. Two needed ' +
      'an update, and both fixes are open for review. Nothing else needs you.',
  },
  {
    agent: 'sentinel',
    text:
      'Morning report. Every endpoint answered its hourly check overnight. Checkout is ' +
      'faster than it was, and nothing needs you.',
  },
  {
    agent: 'forge',
    text:
      'Morning report. Last night’s release build passed, and the new desktop download is ' +
      'ready in preview.',
  },
  {
    agent: 'lens',
    text:
      'Morning report. I reviewed the open pull requests, and most are ready to merge. One ' +
      'changes the signup form, so I left it for you to look at.',
  },
];

/** The phone-approval flow: an agent's turn waiting on a tool approval. */
export const PHONE_APPROVAL = {
  agent: 'forge',
  scenario: 'demo-phone-approval',
  prompt: "Publish this week's release notes",
} as const;

/**
 * The mini-app flow. `id` must match `DEMO_MINI_APP_ID` in the server's
 * `demo-workspace-scenarios.ts`, which names it in the chat.
 */
export const MINI_APP = {
  id: 'launch-checklist',
  agent: 'atlas',
  scenario: 'demo-mini-app',
  prompt: 'Build me a launch checklist I can tick off before Friday.',
  description: 'Track every step before launch day.',
} as const;

/** The mini app's manifest, the shape `create_extension` writes. */
export const MINI_APP_MANIFEST = {
  id: MINI_APP.id,
  name: 'Launch Checklist',
  version: '0.1.0',
  description: MINI_APP.description,
  author: 'Atlas',
  minHostVersion: '0.1.0',
} as const;

/**
 * The mini app's page, the file the agent in the chat says it wrote. A checklist the person ticks, kept with the
 * extension's own storage. React is the host's global, as in every extension.
 */
export const MINI_APP_SOURCE = `import type { ExtensionAPI } from '@dorkos/extension-api';

// React is provided by the host as a global. Do not import it.

const STEPS = [
  { step: 'Final release build', owner: 'Forge' },
  { step: 'Security review of checkout', owner: 'Sentinel' },
  { step: 'Release notes approved', owner: 'You' },
  { step: 'Download page live', owner: 'Forge' },
  { step: 'Launch post scheduled', owner: 'You' },
];

let host: ExtensionAPI | null = null;

function LaunchChecklist() {
  const [done, setDone] = React.useState<string[]>([]);
  React.useEffect(() => {
    void host?.loadData<string[]>().then((saved) => setDone(saved ?? []));
  }, []);
  const toggle = (step: string) => {
    const next = done.includes(step) ? done.filter((s) => s !== step) : [...done, step];
    setDone(next);
    void host?.saveData(next);
  };
  return (
    <div style={{ padding: '24px', maxWidth: '560px' }}>
      <h1 style={{ margin: '0 0 4px', fontSize: '20px', fontWeight: 600 }}>Launch checklist</h1>
      <p style={{ margin: '0 0 16px', fontSize: '13px', color: 'hsl(var(--muted-foreground))' }}>
        {done.length} of {STEPS.length} done
      </p>
      {STEPS.map(({ step, owner }) => (
        <label
          key={step}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            padding: '12px 0',
            borderTop: '1px solid hsl(var(--border))',
            fontSize: '14px',
          }}
        >
          <input type="checkbox" checked={done.includes(step)} onChange={() => toggle(step)} />
          <span style={{ flex: 1, textDecoration: done.includes(step) ? 'line-through' : 'none' }}>
            {step}
          </span>
          <span style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>{owner}</span>
        </label>
      ))}
    </div>
  );
}

export function activate(api: ExtensionAPI): void {
  host = api;
  api.registerPage('', LaunchChecklist, { title: 'Launch checklist' });
}
`;
