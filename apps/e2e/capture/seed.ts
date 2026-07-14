import fs from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import {
  API_URL,
  CANVAS_SOURCE_DOC,
  CANVAS_SOURCE_FILENAME,
  CAPTURE_HOME,
  DISCOVERY_PROJECTS,
  FLEET,
  FLEET_ROOT,
  MARKETPLACE_FIXTURE_PACKAGES,
  MARKETPLACE_FIXTURE_ROOT,
  MARKETPLACE_REGISTRY,
  MARKETPLACE_SOURCE_NAME,
  PROJECTS_ROOT,
  RUNS,
  SESSIONS,
  TASKS,
  WORKBENCH_SOURCE_FILES,
} from './config.js';

/**
 * Demo-data seeding for the capture run. Split into a pre-boot phase (files the
 * server reads at startup: the isolated home, agent project dirs, the offline
 * marketplace cache) and a post-boot phase (everything created through the real
 * API + one direct write of pinned run history). Every seed goes through a real
 * code path — nothing is faked into the DOM.
 *
 * @module capture/seed
 */

/** POST JSON and return the parsed body, throwing on a non-2xx response. */
async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${url} → ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

/** PATCH JSON, throwing on a non-2xx response. */
async function patchJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${url} → ${res.status}: ${await res.text()}`);
}

/**
 * Pre-boot filesystem preparation: wipe and recreate the isolated home, create
 * a project directory per fleet agent, and lay down an offline marketplace
 * cache so the browse view renders without network.
 */
export async function prepareFilesystem(): Promise<void> {
  await fs.rm(CAPTURE_HOME, { recursive: true, force: true });
  await fs.mkdir(FLEET_ROOT, { recursive: true });
  for (const agent of FLEET) {
    await fs.mkdir(path.join(FLEET_ROOT, agent.name), { recursive: true });
  }

  // The file backing the canvas document — demo-canvas opens it with a
  // sourcePath, which is what unlocks the canvas's real edit-in-place mode.
  await fs.writeFile(path.join(FLEET_ROOT, 'atlas', CANVAS_SOURCE_FILENAME), CANVAS_SOURCE_DOC);

  // A small, real source tree alongside it so the Workbench's Files tab has
  // genuine folders/files to browse (the design doc above, "implemented").
  for (const [relPath, content] of Object.entries(WORKBENCH_SOURCE_FILES)) {
    const filePath = path.join(FLEET_ROOT, 'atlas', relPath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }

  // Believable "existing projects" with mixed harness markers — the onboarding
  // discovery capture points the real unified scanner at this tree.
  for (const project of DISCOVERY_PROJECTS) {
    for (const [relPath, content] of Object.entries(project.files)) {
      const filePath = path.join(PROJECTS_ROOT, project.name, relPath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content);
    }
  }

  // Marketplace source list — a `file://` source, so `marketplace.json` and
  // relative-path package sources are read straight off disk
  // (`readLocalMarketplaceJson` / `relativePathResolver`): no network, no
  // pre-warmed cache, and the detail sheet / install pipeline exercise the
  // exact same resolve → stage → validate → preview code path a remote
  // marketplace would.
  await fs.writeFile(
    path.join(CAPTURE_HOME, 'marketplaces.json'),
    JSON.stringify(
      {
        version: 1,
        sources: [
          {
            name: MARKETPLACE_SOURCE_NAME,
            source: pathToFileURL(MARKETPLACE_FIXTURE_ROOT).href,
            enabled: true,
            addedAt: '2026-07-01T00:00:00.000Z',
          },
        ],
      },
      null,
      2
    )
  );
  await fs.mkdir(MARKETPLACE_FIXTURE_ROOT, { recursive: true });
  await fs.writeFile(
    path.join(MARKETPLACE_FIXTURE_ROOT, 'marketplace.json'),
    JSON.stringify(MARKETPLACE_REGISTRY, null, 2)
  );
  for (const pkg of MARKETPLACE_FIXTURE_PACKAGES) {
    for (const [relPath, content] of Object.entries(pkg.files)) {
      const filePath = path.join(MARKETPLACE_FIXTURE_ROOT, 'plugins', pkg.name, relPath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content);
    }
  }
}

/** Dismiss onboarding so the app shell renders immediately. */
async function dismissOnboarding(): Promise<void> {
  await patchJson(`${API_URL}/api/config`, {
    onboarding: { dismissedAt: '2026-07-01T00:00:00.000Z' },
  });
}

/**
 * Record a settled, opted-out telemetry decision so the first-run consent
 * banner (`TelemetryConsentBanner`) never renders over a capture — it shows
 * app-wide until `telemetry.userHasDecided` is set, which would otherwise
 * overlay the top of every non-`/session` frame. Declining ("No thanks") is
 * the honest choice for a staged demo instance: a real, privacy-respecting
 * decision, not telemetry actually left on.
 */
async function declineTelemetry(): Promise<void> {
  await patchJson(`${API_URL}/api/config`, {
    telemetry: { install: false, heartbeat: false, userHasDecided: true },
  });
}

/**
 * Point mutable config at the capture home: the discovery scanner's roots at
 * the seeded projects tree (never the operator's real home directory), and the
 * wizard's agent directory at the capture home's own agents dir (the
 * `~/.dork/agents` default would write to the operator's real DorkBot).
 */
async function scopeConfigToCaptureHome(): Promise<void> {
  await patchJson(`${API_URL}/api/config`, {
    mesh: { scanRoots: [PROJECTS_ROOT] },
    agents: { defaultDirectory: path.join(CAPTURE_HOME, 'agents') },
  });
}

/**
 * Register the demo fleet through the real mesh registration pipeline, then send
 * one heartbeat per agent so the fleet reads as Active (recently seen) rather
 * than Stale — a real heartbeat, not a faked status.
 */
async function seedFleet(): Promise<void> {
  for (const agent of FLEET) {
    const manifest = await postJson<{ id: string }>(`${API_URL}/api/mesh/agents`, {
      path: path.join(FLEET_ROOT, agent.name),
      approver: 'capture-seeder',
      overrides: {
        name: agent.name,
        displayName: agent.displayName,
        description: agent.description,
        runtime: agent.runtime,
        namespace: agent.namespace,
        capabilities: [...agent.capabilities],
        icon: agent.icon,
        color: agent.color,
      },
    });
    await postJson(`${API_URL}/api/mesh/agents/${manifest.id}/heartbeat`, { event: 'heartbeat' });
  }
}

/** Create scheduled tasks; returns a map of task name → schedule id. */
async function seedTasks(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const task of TASKS) {
    const schedule = await postJson<{ id: string; name: string }>(`${API_URL}/api/tasks`, {
      name: task.name,
      displayName: task.displayName,
      description: task.description,
      prompt: task.prompt,
      cron: task.cron,
      timezone: task.timezone,
      target: 'global',
      enabled: true,
    });
    ids.set(task.name, schedule.id);
  }
  return ids;
}

/**
 * Write pinned run history straight into `pulse_runs`. The DB is WAL-mode with a
 * busy timeout, so a short-lived second connection is safe while the server
 * holds its own handle. Timestamps are fixed (see {@link RUNS}) so the row list
 * never churns between capture runs.
 */
function seedRunHistory(scheduleIds: Map<string, string>): void {
  const db = new Database(path.join(CAPTURE_HOME, 'dork.db'));
  db.pragma('busy_timeout = 5000');
  const insert = db.prepare(
    `INSERT INTO pulse_runs
       (id, schedule_id, status, started_at, finished_at, duration_ms, output, error, session_id, trigger, created_at)
     VALUES
       (@id, @scheduleId, @status, @startedAt, @finishedAt, @durationMs, @output, @error, @sessionId, @trigger, @createdAt)`
  );
  const tx = db.transaction(() => {
    for (const runData of RUNS) {
      const scheduleId = scheduleIds.get(runData.taskName);
      if (!scheduleId) continue;
      const finishedAt = new Date(
        new Date(runData.startedAt).getTime() + runData.durationMs
      ).toISOString();
      insert.run({
        id: `run-${randomUUID()}`,
        scheduleId,
        status: runData.status,
        startedAt: runData.startedAt,
        finishedAt,
        durationMs: runData.durationMs,
        output: runData.output,
        error: runData.error ?? null,
        sessionId: null,
        trigger: runData.trigger,
        createdAt: runData.startedAt,
      });
    }
  });
  tx();
  db.close();
}

/** Wait until a session has at least `minMessages` reconstructed history entries. */
async function waitForSession(
  sessionId: string,
  cwd: string,
  minMessages: number,
  timeoutMs: number
): Promise<void> {
  const url = `${API_URL}/api/sessions/${sessionId}/messages?cwd=${encodeURIComponent(cwd)}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(url);
    if (res.ok) {
      const { messages } = (await res.json()) as { messages: unknown[] };
      if (messages.length >= minMessages) return;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** Per-session settle budget (long enough for the paced demo-coding turn). */
const SESSION_SETTLE_MS = 15_000;

/** A session created during seeding, with the pointers a capture needs to open it. */
export interface SeededSession {
  /** Owning agent slug. */
  readonly agent: string;
  /** Session UUID. */
  readonly sessionId: string;
  /** Session working directory (the agent's project dir). */
  readonly cwd: string;
  /** Scenario this session ran. */
  readonly scenario: string;
}

/**
 * Create completed chat sessions so the cockpit and lists look inhabited. Each
 * session binds to its agent's directory and runs its assigned scenario to
 * completion before the next starts.
 */
async function seedSessions(): Promise<SeededSession[]> {
  const created: SeededSession[] = [];
  for (const session of SESSIONS) {
    const sessionId = randomUUID();
    const cwd = path.join(FLEET_ROOT, session.agent);
    await postJson(`${API_URL}/api/test/scenario`, { name: session.scenario, sessionId });
    const res = await fetch(`${API_URL}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: session.prompt, cwd }),
    });
    if (res.status !== 202) {
      throw new Error(`seed session ${session.agent} → ${res.status}: ${await res.text()}`);
    }
    await waitForSession(sessionId, cwd, 2, SESSION_SETTLE_MS);
    created.push({ agent: session.agent, sessionId, cwd, scenario: session.scenario });
  }
  return created;
}

/**
 * Install the `flow` fixture package (real, on-disk, resolved via the local
 * `file://` marketplace source — see `MARKETPLACE_FIXTURE_PACKAGES`) globally,
 * then again scoped to the atlas agent, through the real
 * `POST /api/marketplace/packages/:name/install` route. The second install
 * shadows the first for atlas, so the cross-scope installed listing reports
 * it with `scope: 'override'` — the "Overrides global" row the
 * `marketplace-installed` shot shows.
 *
 * A bare package-name install resolves against the marketplace.json CACHE
 * (`MarketplaceCache`, warmed by the `sources/:name/refresh` route or any
 * browse fetch) — it never fetches inline — so this refreshes that cache
 * first; skipping it 404s with "Package not found (refresh marketplace cache
 * first)" even though the fixture is genuinely on disk. Returns `false`
 * (never throws) if any step fails, so the caller can skip that one shot
 * instead of aborting the whole record.
 */
async function seedMarketplaceInstalls(): Promise<boolean> {
  try {
    await postJson(`${API_URL}/api/marketplace/sources/${MARKETPLACE_SOURCE_NAME}/refresh`, {});
    await postJson(`${API_URL}/api/marketplace/packages/flow/install`, {});
    await postJson(`${API_URL}/api/marketplace/packages/flow/install`, {
      projectPath: path.join(FLEET_ROOT, 'atlas'),
    });
    return true;
  } catch (err) {
    process.stdout.write(
      `  ✗ marketplace-installed seed skipped: ${err instanceof Error ? err.message : err}\n`
    );
    return false;
  }
}

/**
 * Post-boot seeding: dismiss onboarding, register the fleet, create tasks + run
 * history, populate completed sessions, and perform the real installs the
 * `marketplace-installed` shot needs. Runs against the live server and returns
 * the sessions it created plus whether the marketplace installs succeeded.
 */
export async function seedData(): Promise<{
  sessions: SeededSession[];
  marketplaceInstalled: boolean;
}> {
  await dismissOnboarding();
  await declineTelemetry();
  await scopeConfigToCaptureHome();
  await seedFleet();
  const scheduleIds = await seedTasks();
  seedRunHistory(scheduleIds);
  const sessions = await seedSessions();
  const marketplaceInstalled = await seedMarketplaceInstalls();
  return { sessions, marketplaceInstalled };
}
