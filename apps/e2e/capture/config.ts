import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Static configuration and deterministic demo data for the product-capture
 * pipeline. Everything the harness seeds and every knob it turns lives here so
 * a capture run is reproducible: pinned timestamps, a fixed agent fleet, fixed
 * task/run history, and fixed session transcripts. No `Date.now()`-derived
 * content leaks into anything a screenshot shows.
 *
 * @module capture/config
 */

const thisDir = path.dirname(fileURLToPath(import.meta.url));

/** Repo root (four levels up from `apps/e2e/capture`). */
export const REPO_ROOT = path.resolve(thisDir, '../../..');

/**
 * This process's shard index. A serial capture (and every non-shard process,
 * including the orchestrator itself) is shard 0; a parallel record spawns one
 * worker process per shard, each with `CAPTURE_SHARD` set. Every port and data
 * path below is derived from it, so a whole capture stack — server, Vite, and
 * `DORK_HOME` — is isolated per shard with no shared mutable state.
 */
export const SHARD_INDEX = ((): number => {
  // eslint-disable-next-line no-restricted-syntax -- the capture harness has no env.ts; the shard index is set per worker process
  const raw = process.env.CAPTURE_SHARD;
  const n = raw === undefined ? 0 : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
})();

/**
 * Isolated data directory for this shard's capture server (its `DORK_HOME`).
 * Shard 0 keeps the historical base name (`~/.dork-capture`) so a serial run is
 * byte-for-byte unchanged; higher shards get a suffixed sibling.
 */
export const CAPTURE_HOME = path.join(
  os.homedir(),
  SHARD_INDEX === 0 ? '.dork-capture' : `.dork-capture-${SHARD_INDEX}`
);

/**
 * The directory boundary for the capture server — everything sessions and
 * scans may touch lives under here. Deliberately a NON-dot directory: the
 * discovery scanner drops dot-directory roots outright, and the onboarding
 * scan can fall back to sweeping the boundary itself.
 */
export const CAPTURE_WORLD = path.join(CAPTURE_HOME, 'code');

/** Root under which seeded agent project directories are created. */
export const FLEET_ROOT = path.join(CAPTURE_WORLD, 'fleet');

/** Where finished assets are written (the contract with the marketing site + docs). */
export const OUTPUT_DIR = path.join(REPO_ROOT, 'apps/site/public/product');

/**
 * Committed, versioned snapshots of the published set. Each release archives the
 * shots its notes embed under `archive/<label>/`, so a docs or changelog embed
 * of a past version keeps resolving forever. Never wiped by the process phase.
 */
export const ARCHIVE_DIR = path.join(OUTPUT_DIR, 'archive');

/**
 * Human-supplied override sources (committed). A shot with files under
 * `overrides/<shot-id>/` has them win over the automated capture at process
 * time — the manual source runs through the same optimization path.
 */
export const OVERRIDES_ROOT = path.join(REPO_ROOT, 'apps/e2e/capture/overrides');

/**
 * The media library: raw, untouched recordings per record run, kept separate
 * from processed deliverables like an editor's source bins. Gitignored (raws
 * are heavy and regenerable) except its committed README.
 */
export const LIBRARY_ROOT = path.join(REPO_ROOT, 'apps/e2e/capture/library');

/**
 * Port stride between shards. Each shard claims a server/Vite pair `stride`
 * apart from the next, so a pair never overlaps its neighbour. 10 is roomy and
 * keeps even a dozen shards well under the `6xxx` dev range.
 */
export const SHARD_PORT_STRIDE = 10;

/**
 * This shard's API server port. The base pair (4344/4343) is chosen to avoid the
 * dev (`6xxx`), production (`4242`), and e2e-mock (`4243/4248`) servers; each
 * further shard offsets by {@link SHARD_PORT_STRIDE}, staying clear of all of them.
 */
export const SERVER_PORT = 4344 + SHARD_INDEX * SHARD_PORT_STRIDE;
/** This shard's Vite client port. */
export const VITE_PORT = 4343 + SHARD_INDEX * SHARD_PORT_STRIDE;

/** Base URL of the capture client (Vite dev proxying `/api` to the server). */
export const CLIENT_URL = `http://localhost:${VITE_PORT}`;
/** Base URL of the capture API server. */
export const API_URL = `http://localhost:${SERVER_PORT}`;

/**
 * Desktop capture viewport (logical CSS pixels). 1280×800 — tighter than the
 * original 1600×1000 so UI text stays comfortably readable at rendered size
 * (wave-2 art direction); layout verified un-squished at this width.
 */
export const DESKTOP_VIEWPORT = { width: 1280, height: 800 } as const;
/** Retina density for crisp desktop stills. */
export const DEVICE_SCALE_FACTOR = 2;
/** Mobile capture viewport (logical CSS pixels). */
export const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;
/** Mobile density — 3x matches real phone hardware and keeps text crisp. */
export const MOBILE_SCALE_FACTOR = 3;
/** Recorded-video frame size for desktop loops (matches the still viewport). */
export const VIDEO_SIZE = { width: 1280, height: 800 } as const;
/** Recorded-video frame size for the mobile loop. */
export const MOBILE_VIDEO_SIZE = { width: 390, height: 844 } as const;

/** Theme variants captured for desktop stills. */
export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

/** A seeded agent in the demo fleet. */
export interface FleetAgent {
  /** kebab-case slug and registry name. */
  readonly name: string;
  /** User-facing display name. */
  readonly displayName: string;
  /** One-line description shown on the fleet page. */
  readonly description: string;
  /** Declared runtime — drives the runtime badge on the agents/dashboard surfaces. */
  readonly runtime: 'claude-code' | 'codex' | 'opencode';
  /** Topology cluster. */
  readonly namespace: string;
  /** Declared capabilities. */
  readonly capabilities: readonly string[];
  /** Avatar emoji. */
  readonly icon: string;
  /** Accent color (hex). */
  readonly color: string;
}

/**
 * The demo fleet: the brand's canonical names, varied runtimes (all three
 * production runtimes represented), varied namespaces (so the topology graph
 * shows distinct clusters), and distinct colors/icons. Runtimes here are
 * declared configuration, not live session runtimes.
 */
export const FLEET: readonly FleetAgent[] = [
  {
    name: 'atlas',
    displayName: 'Atlas',
    description: 'Platform architect — owns infra, migrations, and release plumbing.',
    runtime: 'claude-code',
    namespace: 'platform',
    capabilities: ['architecture', 'infra', 'migrations'],
    icon: '🗺️',
    color: '#8b5cf6',
  },
  {
    name: 'scout',
    displayName: 'Scout',
    description: 'Recon and dependency triage — scans the tree and files what it finds.',
    runtime: 'codex',
    namespace: 'research',
    capabilities: ['discovery', 'triage', 'summaries'],
    icon: '🔭',
    color: '#06b6d4',
  },
  {
    name: 'sentinel',
    displayName: 'Sentinel',
    description: 'Security and health watch — audits endpoints and guards the perimeter.',
    runtime: 'opencode',
    namespace: 'security',
    capabilities: ['security', 'monitoring', 'audits'],
    icon: '🛡️',
    color: '#ec4899',
  },
  {
    name: 'forge',
    displayName: 'Forge',
    description: 'Build and tooling smith — keeps the dev environment sharp and fast.',
    runtime: 'claude-code',
    namespace: 'platform',
    capabilities: ['tooling', 'builds', 'ci'],
    icon: '🔨',
    color: '#f59e0b',
  },
  {
    name: 'lens',
    displayName: 'Lens',
    description: 'Code-quality analyst — reviews diffs and reports on coverage and drift.',
    runtime: 'codex',
    namespace: 'quality',
    capabilities: ['review', 'coverage', 'insights'],
    icon: '🔬',
    color: '#10b981',
  },
];

/** A seeded scheduled task. */
export interface DemoTask {
  /** kebab-case slug (becomes the SKILL.md dir + task name). */
  readonly name: string;
  /** User-facing task name. */
  readonly displayName: string;
  /** One-line description. */
  readonly description: string;
  /** Cron expression (non-empty → scheduled). */
  readonly cron: string;
  /** IANA timezone. */
  readonly timezone: string;
  /** The instruction body written into the SKILL.md. */
  readonly prompt: string;
}

/**
 * Scheduled tasks. Crons are realistic and non-imminent, so the scheduler never
 * fires one during the short capture window — the seeded run history stays
 * frozen for the screenshot.
 */
export const TASKS: readonly DemoTask[] = [
  {
    name: 'nightly-dependency-audit',
    displayName: 'Nightly dependency audit',
    description: 'Scan the lockfile for advisories and open a triage summary.',
    cron: '0 3 * * *',
    timezone: 'America/New_York',
    prompt: 'Audit dependencies for known advisories and summarize anything actionable.',
  },
  {
    name: 'morning-standup-digest',
    displayName: 'Morning standup digest',
    description: 'Summarize overnight agent activity into a standup-ready digest.',
    cron: '30 8 * * 1-5',
    timezone: 'America/New_York',
    prompt: 'Summarize what the fleet did overnight into a short standup digest.',
  },
  {
    name: 'weekly-coverage-report',
    displayName: 'Weekly coverage report',
    description: 'Diff test coverage against last week and flag regressions.',
    cron: '0 9 * * 1',
    timezone: 'America/New_York',
    prompt: 'Compare coverage to last week and flag any regressions by package.',
  },
  {
    name: 'hourly-health-check',
    displayName: 'Hourly health check',
    description: 'Ping every registered endpoint and record latency.',
    cron: '15 * * * *',
    timezone: 'America/New_York',
    prompt: 'Ping each registered endpoint, record latency, and alert on failures.',
  },
];

/** A seeded run-history row (maps to a `pulse_runs` record). */
export interface DemoRun {
  /** Which task (by `name`) this run belongs to. */
  readonly taskName: string;
  /** Terminal status. */
  readonly status: 'completed' | 'failed';
  /** Pinned start time (ISO 8601). */
  readonly startedAt: string;
  /** Run duration in milliseconds. */
  readonly durationMs: number;
  /** First line of output shown in the row. */
  readonly output: string;
  /** Error message for failed runs. */
  readonly error?: string;
  /** What triggered the run. */
  readonly trigger: 'scheduled' | 'manual';
}

/**
 * Pinned run history — a mostly-green ledger with timestamps like 2:47 AM and a
 * single realistic failure. Dates are fixed so the capture never churns.
 */
export const RUNS: readonly DemoRun[] = [
  {
    taskName: 'nightly-dependency-audit',
    status: 'completed',
    startedAt: '2026-07-06T02:47:15.000Z',
    durationMs: 327_000,
    output: 'No new advisories. 1 042 packages scanned, 0 actionable.',
    trigger: 'scheduled',
  },
  {
    taskName: 'nightly-dependency-audit',
    status: 'completed',
    startedAt: '2026-07-05T02:47:09.000Z',
    durationMs: 301_000,
    output: 'Bumped 3 transitive dev deps; no runtime impact.',
    trigger: 'scheduled',
  },
  {
    taskName: 'nightly-dependency-audit',
    status: 'failed',
    startedAt: '2026-07-04T02:47:04.000Z',
    durationMs: 16_000,
    output: 'Fetching advisory database…',
    error: 'Advisory feed timed out after 15s — retried on the next run.',
    trigger: 'scheduled',
  },
  {
    taskName: 'morning-standup-digest',
    status: 'completed',
    startedAt: '2026-07-06T12:30:11.000Z',
    durationMs: 44_000,
    output: 'Digest posted: 6 sessions, 2 PRs opened, 0 blockers.',
    trigger: 'scheduled',
  },
  {
    taskName: 'morning-standup-digest',
    status: 'completed',
    startedAt: '2026-07-05T12:30:08.000Z',
    durationMs: 39_000,
    output: 'Digest posted: 4 sessions, 1 PR merged.',
    trigger: 'scheduled',
  },
  {
    taskName: 'weekly-coverage-report',
    status: 'completed',
    startedAt: '2026-07-06T13:00:22.000Z',
    durationMs: 128_000,
    output: 'Coverage 87.4% (+0.6%). No package regressed.',
    trigger: 'scheduled',
  },
  {
    taskName: 'hourly-health-check',
    status: 'completed',
    startedAt: '2026-07-06T14:15:03.000Z',
    durationMs: 8_000,
    output: 'All 9 endpoints healthy. p95 latency 42ms.',
    trigger: 'scheduled',
  },
  {
    taskName: 'hourly-health-check',
    status: 'completed',
    startedAt: '2026-07-06T13:15:02.000Z',
    durationMs: 9_000,
    output: 'All 9 endpoints healthy. p95 latency 51ms.',
    trigger: 'manual',
  },
];

/** A pre-seeded, completed chat session that populates the cockpit and lists. */
export interface DemoSession {
  /** Owning agent slug (session cwd binds to this agent's dir). */
  readonly agent: string;
  /** The opening user message — doubles as the session title. */
  readonly prompt: string;
  /** Scenario to run for this session's single turn. */
  readonly scenario: 'demo-coding' | 'simple-text' | 'tool-call';
}

/**
 * Completed sessions seeded before capture so the cockpit, session list, and
 * dashboard look inhabited. Two run the rich coding scenario; the rest are
 * quick so seeding stays fast.
 */
export const SESSIONS: readonly DemoSession[] = [
  {
    agent: 'atlas',
    prompt: 'Add token-bucket rate limiting to the API middleware',
    scenario: 'demo-coding',
  },
  {
    agent: 'lens',
    prompt: 'Review the session-store refactor for coverage gaps',
    scenario: 'demo-coding',
  },
  {
    agent: 'scout',
    prompt: 'Triage the failing dependency audit from last night',
    scenario: 'tool-call',
  },
  {
    agent: 'forge',
    prompt: 'Speed up the client dev build — it regressed to 9s',
    scenario: 'tool-call',
  },
  {
    agent: 'sentinel',
    prompt: 'Audit the new auth endpoints for missing rate limits',
    scenario: 'simple-text',
  },
  { agent: 'atlas', prompt: 'Draft the 0007 auth-tokens migration', scenario: 'simple-text' },
];

/**
 * On-disk copy of the canvas design document, seeded at
 * `<atlas cwd>/rate-limiting-design.md`. MUST byte-match `CANVAS_DOC` in
 * `apps/server/src/services/runtimes/test-mode/demo-scenarios.ts`: the canvas
 * autosave is conditioned on this exact content, so drift surfaces as a
 * save-conflict banner in the recorded edit loop.
 */
export const CANVAS_SOURCE_DOC =
  '# Rate limiting design\n\n' +
  '## Goal\n' +
  'Shed abusive traffic before it reaches auth, without punishing bursty-but-legitimate clients.\n\n' +
  '## Approach\n' +
  '- **Token bucket** per `clientId`: capacity 10, refill 60/min\n' +
  '- Return `429` with `Retry-After` when the bucket is empty\n' +
  '- Reuse the in-memory store; no new infra\n\n' +
  '## Rollout\n' +
  '1. Ship behind `rateLimit.enabled` (default off)\n' +
  '2. Shadow-log rejections for a day\n' +
  '3. Flip on once the false-positive rate is under 0.1%\n';

/** Filename (relative to the atlas agent cwd) backing the canvas document. */
export const CANVAS_SOURCE_FILENAME = 'rate-limiting-design.md';

/**
 * Prompt pool for the concurrent multi-session captures. Each drive takes the
 * next four, so repeated drives (light still, dark poster, loop) mint sessions
 * with distinct, realistic titles instead of duplicate rows in the sidebar.
 */
export const MULTI_SESSION_PROMPTS: readonly string[] = [
  'Add token-bucket rate limiting to the API middleware',
  'Chase the flaky session-list test in CI',
  'Refactor the webhook retry queue to exponential backoff',
  'Write migration 0007 for the auth tokens table',
  'Profile the cold-start path and trim 300ms',
  'Wire the new billing events into the ledger',
  'Backfill TSDoc on the transport layer exports',
  'Split the oversized settings panel into sections',
  'Add OpenTelemetry spans to the relay hop path',
  'Harden the marketplace installer against partial writes',
  'Sweep the client for unused CSS utilities',
  'Bump Express to 5.1 and fix the wildcard routes',
];

/** Root of the seeded "existing projects" tree the discovery scanner sweeps. */
export const PROJECTS_ROOT = path.join(CAPTURE_WORLD, 'projects');

/** One seeded project directory with harness markers for the discovery scan. */
export interface DiscoveryProject {
  /** Directory (and suggested candidate) name. */
  readonly name: string;
  /** Files to create, keyed by path relative to the project dir. */
  readonly files: Readonly<Record<string, string>>;
}

/**
 * Believable projects with mixed harness markers, seeded under
 * {@link PROJECTS_ROOT} so the real unified scanner genuinely finds a mixed
 * fleet during the onboarding discovery capture. Markers match the detection
 * strategies: `CLAUDE.md`/`AGENTS.md` → claude-code, `.cursor`/`.cursorrules`
 * → cursor, `.codex/` → codex, `.windsurf/` → windsurf.
 */
export const DISCOVERY_PROJECTS: readonly DiscoveryProject[] = [
  {
    name: 'payments-api',
    files: {
      'CLAUDE.md':
        '# payments-api\n\nStripe-backed payments service — webhooks, idempotent ledger writes, and nightly reconciliation jobs.\n',
      'package.json': '{ "name": "payments-api", "private": true }\n',
    },
  },
  {
    name: 'mobile-app',
    files: {
      '.cursor/rules/style.mdc': '# Style rules\n\nPrefer functional components.\n',
      'package.json': '{ "name": "mobile-app", "private": true }\n',
    },
  },
  {
    name: 'data-pipeline',
    files: {
      '.codex/config.toml': 'model = "gpt-5-codex"\n',
      'pyproject.toml': '[project]\nname = "data-pipeline"\n',
    },
  },
  {
    name: 'docs-site',
    files: {
      'AGENTS.md':
        '# docs-site\n\nMarketing site and docs — Next.js + MDX, deployed on every merge to main.\n',
      'package.json': '{ "name": "docs-site", "private": true }\n',
    },
  },
  {
    name: 'ml-notebooks',
    files: {
      '.windsurf/rules.md': '# Rules\n\nPin dataset versions in every notebook.\n',
      'README.md': '# ml-notebooks\n',
    },
  },
  {
    name: 'infra-terraform',
    files: {
      '.cursorrules': 'Run terraform fmt and validate before committing.\n',
      'main.tf': 'terraform {}\n',
    },
  },
];

/** Marketplace registry source name written into `marketplaces.json`. */
export const MARKETPLACE_SOURCE_NAME = 'dorkos';

/** A cached marketplace registry document served offline for the browse view. */
export const MARKETPLACE_REGISTRY = {
  name: 'dorkos',
  owner: { name: 'Dork Labs', email: 'hello@dorkos.ai' },
  metadata: {
    description: 'Official DorkOS marketplace',
    version: '0.1.0',
    pluginRoot: './plugins',
  },
  plugins: [
    {
      name: 'flow',
      source: './plugins/flow',
      description: 'PM-agnostic workflow engine — CAPTURE → SHIP, straight from chat.',
      author: { name: 'Dork Labs' },
      license: 'MIT',
      category: 'workflow',
      tags: ['workflow', 'planning', 'linear'],
      keywords: ['flow', 'pm', 'tickets'],
    },
    {
      name: 'code-reviewer',
      source: './plugins/code-reviewer',
      description: 'Reviews diffs against a rubric and posts findings inline.',
      author: { name: 'Dork Labs' },
      license: 'MIT',
      category: 'code-quality',
      tags: ['review', 'quality', 'pr'],
      keywords: ['review', 'lint'],
    },
    {
      name: 'linear-adapter',
      source: './plugins/linear-adapter',
      description: 'Two-way sync between agent tasks and Linear issues.',
      author: { name: 'Dork Labs' },
      license: 'MIT',
      category: 'integration',
      tags: ['linear', 'sync', 'tasks'],
      keywords: ['linear', 'tracker'],
    },
    {
      name: 'telegram-notifier',
      source: './plugins/telegram-notifier',
      description: 'Get a Telegram message the moment an agent finishes or needs you.',
      author: { name: 'Dork Labs' },
      license: 'MIT',
      category: 'notifications',
      tags: ['telegram', 'alerts'],
      keywords: ['notify', 'telegram'],
    },
    {
      name: 'obsidian-memory',
      source: './plugins/obsidian-memory',
      description: 'Persist agent memory into your Obsidian vault as linked notes.',
      author: { name: 'Dork Labs' },
      license: 'MIT',
      category: 'memory',
      tags: ['obsidian', 'memory', 'notes'],
      keywords: ['memory', 'vault'],
    },
    {
      name: 'standup-digest',
      source: './plugins/standup-digest',
      description: 'Rolls overnight fleet activity into a standup-ready digest.',
      author: { name: 'Dork Labs' },
      license: 'MIT',
      category: 'reporting',
      tags: ['digest', 'reporting'],
      keywords: ['standup', 'summary'],
    },
  ],
} as const;
