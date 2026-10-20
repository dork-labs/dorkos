import fs from 'fs/promises';
import path from 'path';
import { API_URL, FLEET_ROOT } from '../config.js';

/**
 * The heartbeat seed: one agent on a timer with a short run of finished beats
 * on its Heartbeat page, for a screenshot.
 *
 * Every beat is a real one. `POST /api/test/heartbeat/beat` asks DorkOS's own
 * beat runner for a beat now (`routes/test-heartbeat.ts`, test mode only),
 * which is the one shortcut: a real timed beat first fires minutes after
 * boot. The runner then reads the agent's `HEARTBEAT.md`, gathers, triages
 * and records the beat itself. A beat that finds nothing ends quiet without a
 * turn. A beat that finds a promise coming due starts a turn on the agent's
 * runtime, and that turn (the server's `demo-heartbeat` scenario) ends the
 * beat through the real `end_beat` capability, with a raise or without. What
 * a beat finds is real too: the promises are recorded by the agent's own
 * identity through the real `commitments.add` capability.
 *
 * So the run is: quiet, a promise due (raised to the owner), quiet, another
 * promise due (worked on, nothing raised), quiet. The beats are seconds apart,
 * not half an hour, because they run back to back. Forge's own timer keeps
 * running afterwards, so a demo left up adds a real quiet beat now and then.
 *
 * @module capture/demo/heartbeat
 */

/** The agent with the heartbeat: a `claude-code` one, the runtime test mode registers under that name. */
export const HEARTBEAT_AGENT = 'forge';

/** Its `HEARTBEAT.md`: on a timer, watching its promises and its schedules. */
const HEARTBEAT_FILE = `---
wake: timed
watch: [commitments, schedules]
report: off
---

Keep an eye on what I promised and the schedules I run.

- A promise due today: do the work if I can, or ask the owner the one question that unblocks it.
- A schedule that failed: find out why before anyone asks.
- Nothing new: say so in one line and stop.
`;

/** The promises the agent records, in order. The scenario reads its words to pick an ending. */
// Due tomorrow, inside the gatherer's 24-hour window: a promise that passes its
// due time while the demo is up counts as new again (due becomes overdue), and
// Forge's own timer would then beat on it with no scenario to end the turn.
const PROMISES: readonly { what: string; dueInHours: number }[] = [
  { what: 'Send the beta invite email to the waitlist', dueInHours: 20 },
  { what: "Post this week's changelog", dueInHours: 22 },
];

/** The scenario every beat turn runs while this seed is beating. */
const BEAT_SCENARIO = 'demo-heartbeat';

/** The scenario the stack goes back to afterwards, the test-mode default. */
const DEFAULT_SCENARIO = 'simple-text';

/** One beat as the Heartbeat page reads it. */
interface BeatRow {
  endedAt: string | null;
  outcome: string;
  summary: string | null;
  raises?: number;
}

/** POST JSON, throwing on a non-2xx response. */
async function post(pathname: string, body: unknown, headers = {}): Promise<unknown> {
  const res = await fetch(`${API_URL}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${pathname} → ${res.status}: ${await res.text()}`);
  return res.json();
}

/** GET JSON, throwing on a non-2xx response. */
async function get<T>(pathname: string): Promise<T> {
  const res = await fetch(`${API_URL}${pathname}`);
  if (!res.ok) throw new Error(`GET ${pathname} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** The agent's Mesh id, by its name. */
async function agentId(name: string): Promise<string> {
  const { agents } = await get<{ agents: { id: string; name: string }[] }>('/api/mesh/agents');
  const agent = agents.find((a) => a.name === name);
  if (!agent) throw new Error(`${name} is not registered`);
  return agent.id;
}

/** The beats on the agent's Heartbeat page, newest first. */
async function beats(id: string): Promise<BeatRow[]> {
  const status = await get<{ lastBeats?: BeatRow[] }>(`/api/agents/${id}/heartbeat`);
  return status.lastBeats ?? [];
}

/**
 * One beat, now, failing loudly when the runner recorded none. Waits for the
 * newest beat to end as well: when Forge's own timer fires in the middle of the
 * seed, the runner answers this wake at once and owes the agent a beat after
 * the one running, so the route returns before anything has finished.
 */
async function beat(id: string): Promise<void> {
  const before = (await beats(id)).length;
  await post('/api/test/heartbeat/beat', { agentId: id });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const rows = await beats(id);
    if (rows.length > before && rows[0]?.endedAt) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`the beat runner recorded no finished beat for ${HEARTBEAT_AGENT}`);
}

/** Record a promise as the agent, through its own identity. */
async function promise(what: string, dueInHours: number): Promise<void> {
  const { token } = (await post('/api/test/agent-token', {
    agentPath: path.join(FLEET_ROOT, HEARTBEAT_AGENT),
  })) as { token: string };
  const dueAt = new Date(Date.now() + dueInHours * 3_600_000).toISOString();
  await post(
    '/api/capabilities/commitments.add/invoke',
    { what, dueAt },
    { 'X-DorkOS-Agent': token }
  );
}

/**
 * Seed the heartbeat: write the agent's `HEARTBEAT.md`, then run five beats,
 * recording a promise before the second and the fourth.
 *
 * @returns The agent's Mesh id, for the link to its Heartbeat page.
 */
export async function seedHeartbeat(): Promise<string> {
  const id = await agentId(HEARTBEAT_AGENT);
  const file = path.join(FLEET_ROOT, HEARTBEAT_AGENT, '.dork', 'HEARTBEAT.md');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, HEARTBEAT_FILE);

  await post('/api/test/scenario', { name: BEAT_SCENARIO });
  try {
    await beat(id);
    for (const { what, dueInHours } of PROMISES) {
      await promise(what, dueInHours);
      await beat(id);
      await beat(id);
    }
  } finally {
    await post('/api/test/scenario', { name: DEFAULT_SCENARIO });
  }
  const rows = await beats(id);
  const mixed =
    rows.some((row) => row.outcome === 'quiet') &&
    rows.some((row) => row.outcome === 'worked' && (row.raises ?? 0) > 0) &&
    rows.some((row) => row.outcome === 'worked' && (row.raises ?? 0) === 0);
  if (!mixed) {
    throw new Error(
      `${HEARTBEAT_AGENT}'s beats did not come out mixed: ` +
        rows.map((row) => `${row.outcome} (${row.summary ?? ''})`).join(', ')
    );
  }
  return id;
}
