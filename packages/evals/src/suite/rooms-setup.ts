/**
 * The fixture every `rooms` case is built out of: agents seeded on disk, a
 * channel opened around them, and the per-member response modes set through the
 * real routes.
 *
 * ## Why agents are seeded ON DISK and never inserted
 *
 * A room resolves an agent through the mesh cache keyed on its directory
 * (`agents.project_path`), and that cache is derived from manifests — file-first
 * write-through, ADR-0043. Writing the manifest under
 * `<DORK_HOME>/agents/<slug>/` before the server boots is therefore the ONE
 * seeding move that works identically on both tiers: the in-process harness
 * reconciles the agents home at boot (`harness-boot.ts`) and the real server
 * does the same in `start()`. Inserting rows would work on neither tier without
 * knowing which one it was running on.
 *
 * ## Why the response mode is PATCHed rather than declared
 *
 * A channel seats every agent as `engaged` whatever its manifest says
 * (`AddRoomMemberRequest.responseMode`: "omit to seed from the room kind"). A
 * case about a quieter mode has to say so through
 * `PATCH /:id/members/:authorId`, which is also the route a person uses — so the
 * eval exercises the product rather than a fixture that reached past it.
 *
 * @module evals/suite/rooms-setup
 */
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest, ResponseMode } from '@dorkos/shared/mesh-schemas';
import type { EvalSandbox, RoomFacts, RoomScriptContext } from '../types.js';
import { observedEntries } from '../oracles/rooms.js';
import {
  createRoomWithAgents,
  openRoomStream,
  setResponseMode,
  type RoomStream,
} from '../runner/room-drive.js';

/** One agent a rooms case seats. */
export interface RoomAgentSpec {
  /** Directory name under `<DORK_HOME>/agents/`, and the key oracles name it by. */
  slug: string;
  /** The agent's display name; its `@handle` is derived from it. */
  displayName: string;
  /** What it is for, so a real model has a role to answer from. */
  description: string;
  /** Its mode in the room. Defaults to the channel default, `engaged`. */
  responseMode?: ResponseMode;
}

/** The directory a seeded agent lives in inside the sandbox. */
export function agentDir(sandbox: EvalSandbox, slug: string): string {
  return path.join(sandbox.dorkHome, 'agents', slug);
}

/**
 * A stable 26-character id for a seeded agent.
 *
 * Derived from the slug rather than random so a manifest re-written into the
 * same sandbox keeps its identity, and padded with the ULID alphabet's own
 * characters so nothing downstream that parses one is surprised.
 *
 * @param slug - The agent's slug.
 * @returns A deterministic id for its manifest.
 */
function seededAgentId(slug: string): string {
  const body = slug.toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/g, '');
  return `01JQXEVAL${body}${'0'.repeat(26)}`.slice(0, 26);
}

/**
 * Write each agent's manifest into `<DORK_HOME>/agents/<slug>/`, so the server
 * that boots next adopts them.
 *
 * Use it as an {@link EvalCase.seed} — it runs before the boot, which is the
 * whole point.
 *
 * @param sandbox - The fresh eval sandbox.
 * @param agents - The agents to seat.
 */
export async function seedRoomAgents(
  sandbox: EvalSandbox,
  agents: readonly RoomAgentSpec[]
): Promise<void> {
  for (const agent of agents) {
    const dir = agentDir(sandbox, agent.slug);
    await mkdir(dir, { recursive: true });
    const manifest: AgentManifest = {
      id: seededAgentId(agent.slug),
      name: agent.slug,
      displayName: agent.displayName,
      description: agent.description,
      // A runtime this harness does not register, so the session the room binds
      // runs on the server DEFAULT — `test-mode` in-process, claude-code on the
      // credentialed tier. The same manifest therefore drives both tiers.
      runtime: 'claude-code',
      capabilities: [],
      behavior: { responseMode: agent.responseMode ?? 'engaged' },
      registeredAt: new Date().toISOString(),
      registeredBy: 'dorkos-evals',
      personaEnabled: false,
      isSystem: false,
      enabledToolGroups: {},
      mcpServers: [],
    };
    await writeManifest(dir, manifest);
  }
}

/** A room a case opened, with its live stream. */
export interface OpenedRoom {
  /** The room and the identities it minted. */
  room: RoomFacts;
  /** The live stream, already past its subscribe gate. */
  stream: RoomStream;
}

/**
 * Open the case's channel, set every member's mode, and subscribe — in that
 * order, so nothing the case posts can land before the collector is live.
 *
 * @param ctx - The room script context the runner handed the case.
 * @param opts.slug - The channel's `#name`.
 * @param opts.title - The channel's title.
 * @param opts.agents - The agents to seat, in roster order.
 * @param opts.timeoutMs - Hard ceiling on the stream's collection.
 * @returns The room and its live stream.
 */
export async function openRoomFor(
  ctx: RoomScriptContext,
  opts: {
    slug: string;
    title: string;
    agents: readonly RoomAgentSpec[];
    timeoutMs?: number;
  }
): Promise<OpenedRoom> {
  const dirs: Record<string, string> = {};
  for (const agent of opts.agents) dirs[agent.slug] = agentDir(ctx.sandbox, agent.slug);

  const room = await createRoomWithAgents({
    baseUrl: ctx.baseUrl,
    title: opts.title,
    slug: opts.slug,
    agents: dirs,
  });

  for (const agent of opts.agents) {
    if (!agent.responseMode) continue;
    const authorId = room.agents[agent.slug];
    if (!authorId) continue;
    await setResponseMode({
      baseUrl: ctx.baseUrl,
      roomId: room.roomId,
      authorId,
      responseMode: agent.responseMode,
    });
    // The roster was read at creation, when every agent was still seated at the
    // channel default. Left stale, the transcript would record a `silent` member
    // as `engaged` — evidence that quietly contradicts what the case did.
    const member = room.members[authorId];
    if (member) member.responseMode = agent.responseMode;
  }

  const stream = openRoomStream({
    baseUrl: ctx.baseUrl,
    roomId: room.roomId,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  await stream.ready;
  return { room, stream };
}

/**
 * Set how long a burst is gathered before it becomes one turn
 * (`rooms.collectDebounceMs`), through the same `PATCH /api/config` a person
 * uses.
 *
 * The burst case needs it: the shipped window is 500ms, and asserting "three
 * messages, one turn" against a 500ms budget would be measuring the harness's
 * HTTP latency rather than the collector. The value is read PER BURST, so this
 * binds the very next message.
 *
 * @param baseUrl - The running harness server.
 * @param debounceMs - The window to set.
 */
export async function setCollectDebounce(baseUrl: string, debounceMs: number): Promise<void> {
  const res = await fetch(`${baseUrl}/api/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rooms: { collectDebounceMs: debounceMs } }),
  });
  if (!res.ok) {
    throw new Error(`could not set rooms.collectDebounceMs: ${res.status} ${await res.text()}`);
  }
}

/**
 * Hard ceiling on one CREDENTIALED room drive — the WHOLE case, from the
 * subscribe to the last settle, not one budget per `settle()` call.
 *
 * Five minutes because the two-turn cases (acknowledgments, restraint) have to
 * fit two real model turns plus the quiet window that proves nothing followed.
 * This is the honest wall-clock bound on such a case: not "a handful of posts,
 * therefore fast", but at most this, and the number means what it says now that
 * the budget is per drive.
 */
export const CREDENTIALED_TIMEOUT_MS = 300_000;

/** Quiet window that ends a credentialed collection when no reply is coming. */
export const CREDENTIALED_QUIET_MS = 20_000;

/** The per-case spend ceiling every credentialed rooms case declares. */
export const CREDENTIALED_CEILING_USD = 0.5;

/**
 * Whether the named agent has posted anything yet on the collected stream.
 *
 * The settle predicate every credentialed case shares: a real model answers when
 * it answers, so a case stops collecting on the agent having SPOKEN rather than
 * on a quiet window it would otherwise have to wait out in full.
 *
 * @param frames - The collected room frames.
 * @param room - The room facts the script recorded.
 * @param slug - The seeded agent's slug.
 * @returns True once that agent has committed at least one post.
 */
export function agentSpoke(
  frames: Parameters<typeof observedEntries>[0],
  room: RoomFacts,
  slug: string
): boolean {
  const authorId = room.agents[slug];
  if (!authorId) return false;
  return observedEntries(frames).some((e) => e.authorId === authorId && e.kind === 'post');
}

/**
 * Case-insensitive `includes` — the shape every credentialed rooms predicate is
 * built from, since those cases read the agent's words and must do so
 * deterministically.
 *
 * @param text - The agent's post.
 * @param needle - The token that must appear in it.
 * @returns True when `needle` occurs in `text`, ignoring case.
 */
export function hasText(text: string, needle: string): boolean {
  return text.toLowerCase().includes(needle.toLowerCase());
}

/**
 * The `@handle` a seated agent is addressed by, as the roster minted it.
 *
 * A handle is derived from the manifest name and suffixed on a collision, so a
 * case must READ it rather than predict it — writing `@ada` into a prompt that
 * the server seated as `ada-2` is a mention that resolves to nobody, and the
 * case would then measure addressing rather than what it meant to.
 *
 * @param room - The room facts.
 * @param slug - The seeded agent's slug.
 * @returns The `@handle` to write into a message.
 */
export function mentionOf(room: RoomFacts, slug: string): string {
  const authorId = room.agents[slug];
  const handle = authorId ? room.members[authorId]?.handle : undefined;
  if (!handle) throw new Error(`the agent "${slug}" was seated without an addressable handle`);
  return `@${handle}`;
}
