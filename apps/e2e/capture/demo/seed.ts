import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { API_URL, CAPTURE_HOME, FLEET_ROOT } from '../config.js';
import {
  DEMO_FAKE_HOME,
  DEMO_MARKETING_ROOT,
  MINI_APP,
  MINI_APP_MANIFEST,
  MINI_APP_SOURCE,
  PHONE_APPROVAL,
  SOCIAL_CHAT,
  SOCIAL_POST_IDS,
  SOCIAL_QUEUE_ID,
  TEAM_REPORTS,
} from './config.js';
import { seedHeartbeat } from './heartbeat.js';

/**
 * Seeding for the demo workspace's flows, on top of the capture's own
 * seed (`../seed.ts`). Like that seed, every state here comes from a real code
 * path: the social-queue extension is the real one reading real files, the
 * #team reports are posted by the agents' own identities through the real
 * `rooms.post` capability, and the mini app is found and held for a person's
 * yes by DorkOS's real extension scan. Nothing is written into the DOM.
 *
 * @module capture/demo/seed
 */

/** What {@link seedDemo} made, for the links `run.ts` prints. */
export interface DemoSeeds {
  /** Whether the social-queue flow was seeded (its source checkout was found). */
  readonly socialQueue: boolean;
  /** The #team room's id. */
  readonly teamRoomId: string;
  /** The session waiting on a tool approval. */
  readonly approvalSessionId: string;
  /** The session where the mini app was built. */
  readonly miniAppSessionId: string;
  /** The agent whose Heartbeat page holds the seeded beats. */
  readonly heartbeatAgentId: string;
  /** The chat the Social queue tab sits beside, when that flow was seeded. */
  readonly socialChatSessionId: string | null;
}

/** POST JSON and return the parsed body, throwing on a non-2xx response. */
async function postJson<T>(pathname: string, body: unknown, headers = {}): Promise<T> {
  const res = await fetch(`${API_URL}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${pathname} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** GET JSON, throwing on a non-2xx response. */
async function getJson<T>(pathname: string): Promise<T> {
  const res = await fetch(`${API_URL}${pathname}`);
  if (!res.ok) throw new Error(`GET ${pathname} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** A date as `yyyy-mm-dd` in Central time, the queue's day (`queue/README.md`). */
function centralDay(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(date);
}

/** Central time's UTC offset on a given instant, as `-05:00`. */
function centralOffset(date: Date): string {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    timeZoneName: 'longOffset',
  })
    .formatToParts(date)
    .find((part) => part.type === 'timeZoneName')?.value;
  return name?.replace('GMT', '') || '-06:00';
}

/** The header and text of one queue file (the format in `queue/README.md`). */
function parsePost(raw: string): { header: Map<string, string>; text: string } {
  const src = raw.replace(/\r\n/g, '\n');
  const end = src.indexOf('\n---', 3);
  if (!src.startsWith('---\n') || end === -1) throw new Error('not a queue post');
  const header = new Map<string, string>();
  for (const line of src.slice(4, end).split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) header.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return { header, text: src.slice(end + 4).replace(/^[^\n]*\n\n?/, '') };
}

/**
 * One published post, copied as a fresh `queued` post `daysAhead` days from
 * today, at {@link POST_TIME}. Its text is kept; what it said about being posted
 * (its link, when, its notes and discussion thread) is dropped.
 */
function requeue(raw: string, daysAhead: number): { day: string; id: string; file: string } {
  const { header, text } = parsePost(raw);
  const oldId = header.get('id') ?? '';
  const time = POST_TIME;
  // Calendar days, not 24-hour steps: a 23- or 25-hour day at a clock change
  // must not land "tomorrow" on today.
  const [y, m, d] = centralDay(new Date()).split('-').map(Number);
  const day = new Date(Date.UTC(y!, m! - 1, d! + daysAhead)).toISOString().slice(0, 10);
  // The offset at the post's own time (approximately: as if it were UTC),
  // which is a day or more away from now and can be across a clock change.
  const offset = centralOffset(new Date(`${day}T${time}Z`));
  const id = `${day}${oldId.slice(10)}`;
  const lines = [
    '---',
    `id: ${id}`,
    `scheduledFor: ${day}T${time}${offset}`,
    'status: queued',
    'postedUrl:',
    `lane: ${header.get('lane') ?? '1'}`,
    `createdBy: ${header.get('createdBy') ?? 'dorkos-marketing'}`,
    'editedBy:',
    'tainted: false',
    '---',
    '',
    text,
  ];
  return { day, id, file: `${lines.join('\n').replace(/\s+$/, '')}\n` };
}

/** Which day, counted from tomorrow, each post in {@link SOCIAL_POST_IDS} goes on. */
const DAYS_AHEAD = [1, 2, 3];

/** When each re-queued post goes out, Central time: the same morning slot every day. */
const POST_TIME = '09:30:00';

/**
 * Lay the social-queue extension and its queue into the demo home, BEFORE
 * boot (the server finds extensions as it starts).
 *
 * The extension is copied, not linked to its checkout: it finds its queue from
 * its own real path, and a link to the checkout would make that the real
 * queue. The copy sits in a marketing folder inside the demo home and is linked
 * into `extensions/` the way the extension's README installs it, so its queue
 * resolves to the copy below and every edit or pause stays in the demo home.
 *
 * @param marketingRepo - The `dorkos-marketing` checkout to copy from.
 * @returns `false` when that checkout is not on this computer.
 */
export async function prepareSocialQueue(marketingRepo: string): Promise<boolean> {
  const source = path.join(marketingRepo, 'extensions', SOCIAL_QUEUE_ID);
  try {
    await fs.access(path.join(source, 'extension.json'));
  } catch {
    return false;
  }
  const copy = path.join(DEMO_MARKETING_ROOT, 'extensions', SOCIAL_QUEUE_ID);
  await fs.cp(source, copy, {
    recursive: true,
    filter: (src) => !src.split(path.sep).includes('node_modules'),
  });
  await fs.mkdir(path.join(CAPTURE_HOME, 'extensions'), { recursive: true });
  await fs.symlink(copy, path.join(CAPTURE_HOME, 'extensions', SOCIAL_QUEUE_ID), 'dir');

  const queue = path.join(DEMO_MARKETING_ROOT, 'queue');
  await fs.mkdir(queue, { recursive: true });
  await fs.copyFile(path.join(marketingRepo, 'queue', 'README.md'), path.join(queue, 'README.md'));
  const log: string[] = [];
  for (const [i, oldId] of SOCIAL_POST_IDS.entries()) {
    const raw = await fs.readFile(
      path.join(marketingRepo, 'queue', oldId.slice(0, 10), `${oldId}.md`),
      'utf8'
    );
    const post = requeue(raw, DAYS_AHEAD[i] ?? i + 1);
    await fs.mkdir(path.join(queue, post.day), { recursive: true });
    await fs.writeFile(path.join(queue, post.day, `${post.id}.md`), post.file);
    log.push(`- ${new Date().toISOString()} | dorkos-marketing | queued ${post.id}`);
  }
  await fs.writeFile(path.join(queue, 'log.md'), `${log.join('\n')}\n`);
  return true;
}

/** Make the demo server's empty home (`isolatedHomeEnv` in `../boot.ts`). */
export async function prepareFakeHome(): Promise<void> {
  await fs.mkdir(DEMO_FAKE_HOME, { recursive: true, mode: 0o700 });
}

/** Turn the social-queue extension on, the two answers a person gives in Settings. */
async function turnOnSocialQueue(): Promise<void> {
  // A yes names the files the card showed (DOR-3068): its version and digest.
  const listed =
    await getJson<Array<{ id: string; manifest: { version: string }; digest?: string }>>(
      '/api/extensions'
    );
  const shown = listed.find((ext) => ext.id === SOCIAL_QUEUE_ID);
  await postJson(`/api/extensions/${SOCIAL_QUEUE_ID}/approve`, {
    version: shown?.manifest.version,
    expectedDigest: shown?.digest,
  });
  await postJson(`/api/extensions/${SOCIAL_QUEUE_ID}/enable`, {});
}

/** #team's id, by its well-known key. */
async function teamRoomId(): Promise<string> {
  const { rooms } = await getJson<{ rooms: { id: string; wellKnown?: string | null }[] }>(
    '/api/rooms'
  );
  const team = rooms.find((room) => room.wellKnown === 'team');
  if (!team) throw new Error('#team is not on this install');
  return team.id;
}

/**
 * Post each agent's morning report in #team AS that agent. The identity is a
 * real agent token (`POST /api/test/agent-token`, the seam the rooms browser
 * tests use); a made-up one would post under the person's name instead.
 */
async function postTeamReports(roomId: string): Promise<void> {
  for (const report of TEAM_REPORTS) {
    const { token } = await postJson<{ token: string }>('/api/test/agent-token', {
      agentPath: path.join(FLEET_ROOT, report.agent),
    });
    await postJson(
      '/api/capabilities/rooms.post/invoke',
      { roomId, text: report.text },
      { 'X-DorkOS-Agent': token }
    );
    // A beat apart, so the room's times read as separate reports.
    await new Promise((r) => setTimeout(r, 1_200));
  }
}

/**
 * Whether a session's live turn is waiting on an approval, read from the first
 * event of its stream (the snapshot the app itself opens on).
 */
async function isWaitingOnApproval(sessionId: string): Promise<boolean> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 3_000);
  try {
    const res = await fetch(`${API_URL}/api/sessions/${sessionId}/events`, {
      signal: abort.signal,
    });
    const reader = res.body?.getReader();
    if (!reader) return false;
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('\n\n')) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text.startsWith('event: snapshot') && text.includes('"approval_required"');
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

/**
 * Start one agent conversation on a scripted turn and wait until it is under
 * way: its answer in the history or, for a turn that parks on an approval
 * (`asking`), the approval in the session's live state. A parked turn shows
 * nothing in its history or the chat list until someone answers.
 */
async function startSession(
  agent: string,
  scenario: string,
  prompt: string,
  until: 'answered' | 'asking' = 'answered'
): Promise<string> {
  const sessionId = randomUUID();
  const cwd = path.join(FLEET_ROOT, agent);
  await postJson('/api/test/scenario', { name: scenario, sessionId });
  const res = await fetch(`${API_URL}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: prompt, cwd, create: true }),
  });
  if (res.status !== 202)
    throw new Error(`session for ${agent} → ${res.status}: ${await res.text()}`);
  const history = `/api/sessions/${sessionId}/messages?cwd=${encodeURIComponent(cwd)}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (until === 'answered') {
      const { messages } = await getJson<{ messages: unknown[] }>(history).catch(() => ({
        messages: [],
      }));
      if (messages.length >= 2) return sessionId;
    } else if (await isWaitingOnApproval(sessionId)) {
      return sessionId;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`${agent}'s ${scenario} turn never started`);
}

/**
 * The mini app, built the way DorkOS's own `create_extension` tool builds one:
 * its two files in the global extensions folder, DorkOS asked to look again
 * (what `reload_extensions` does), then switched on, which the tool also does
 * as it creates a copy. Nobody approved this copy to run, so DorkOS asks a
 * person: "Turn on Launch Checklist?" under Needs you
 * (`extension-approval-queue.ts`).
 *
 * The tool itself is not called: DorkOS's MCP server is mounted in test mode,
 * but its tool server is built from the Claude Code runtime, which test mode
 * never starts, so every call answers 500 ("ClaudeCodeRuntime not available",
 * `startup/steps/mcp-tasks-skills.ts`). Called by an agent in a
 * DorkOS chat on Trusted, the tool would also approve the copy as it made it,
 * so it would not wait; this is the state an agent's mini app is in on Careful,
 * or when an agent wrote the files itself.
 */
async function buildMiniApp(): Promise<void> {
  const dir = path.join(CAPTURE_HOME, 'extensions', MINI_APP.id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'extension.json'),
    `${JSON.stringify(MINI_APP_MANIFEST, null, 2)}\n`
  );
  await fs.writeFile(path.join(dir, 'index.ts'), MINI_APP_SOURCE);
  await postJson('/api/extensions/reload', {});
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const list = await getJson<{ id: string }[] | { extensions: { id: string }[] }>(
      '/api/extensions'
    );
    const ids = (Array.isArray(list) ? list : list.extensions).map((ext) => ext.id);
    if (ids.includes(MINI_APP.id)) {
      await postJson(`/api/extensions/${MINI_APP.id}/enable`, {});
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`DorkOS never found the ${MINI_APP.id} mini app`);
}

/**
 * Seed the flows against the running demo server (the heartbeat in `heartbeat.ts`).
 *
 * @param socialQueue - Whether {@link prepareSocialQueue} laid the extension down.
 * @returns What was made, for the printed links.
 */
export async function seedDemo(socialQueue: boolean): Promise<DemoSeeds> {
  if (socialQueue) await turnOnSocialQueue();
  const roomId = await teamRoomId();
  await postTeamReports(roomId);
  const approvalSessionId = await startSession(
    PHONE_APPROVAL.agent,
    PHONE_APPROVAL.scenario,
    PHONE_APPROVAL.prompt,
    'asking'
  );
  const miniAppSessionId = await startSession(MINI_APP.agent, MINI_APP.scenario, MINI_APP.prompt);
  await buildMiniApp();
  const heartbeatAgentId = await seedHeartbeat();
  const socialChatSessionId = socialQueue
    ? await startSession(SOCIAL_CHAT.agent, SOCIAL_CHAT.scenario, SOCIAL_CHAT.prompt)
    : null;
  return {
    socialQueue,
    teamRoomId: roomId,
    approvalSessionId,
    miniAppSessionId,
    heartbeatAgentId,
    socialChatSessionId,
  };
}
