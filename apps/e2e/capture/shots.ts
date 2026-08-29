import {
  DESKTOP_VIEWPORT,
  DEVICE_SCALE_FACTOR,
  MOBILE_SCALE_FACTOR,
  MOBILE_VIDEO_SIZE,
  MOBILE_VIEWPORT,
  VIDEO_SIZE,
} from './config.js';

/**
 * The shot registry — the single source of truth for every piece of product
 * media the capture pipeline produces. A "shot" is one logical surface of the
 * DorkOS UI (the cockpit, the topology graph, a streaming chat) captured for a
 * downstream consumer. Marketing, docs, and changelogs all draw from this one
 * list, so a shot can be added for docs without ever appearing on the marketing
 * site, and vice-versa.
 *
 * The record/process phases derive their behavior from this registry (which
 * shots to skip, what target dimensions to normalize to, which shots ship a
 * loop), and the published `manifest.json` carries a snapshot of it (`shots`)
 * so the marketing site and docs guard-tests stay consistent with the pipeline
 * without importing across the app boundary.
 *
 * @module capture/shots
 */

/**
 * Who consumes a shot. A shot may serve more than one surface; only shots
 * tagged `marketing` appear in the marketing-site feature catalog.
 */
export type ShotConsumer = 'marketing' | 'docs' | 'changelog';

/**
 * What a shot produces. `still` ships a single light still; `loop` ships a
 * light still *and* an animated dark loop (webm) with a dark poster extracted
 * from the loop itself (frame 0, or the settled pre-seam frame — see
 * {@link Shot.posterFrame}). There is no "loop without a still", so a
 * two-value kind is exhaustive — see the note in the README on why `both` was
 * not adopted.
 */
export type ShotKind = 'still' | 'loop';

/** Device framing for a shot — drives both the capture viewport and target dimensions. */
export type ShotFrame = 'desktop' | 'mobile';

/** A single registered shot. */
export interface Shot {
  /** Stable id (kebab-case). The file convention is `<id>-<theme>.<ext>`. */
  readonly id: string;
  /** Still-only or still-plus-loop. */
  readonly kind: ShotKind;
  /** Device framing. */
  readonly frame: ShotFrame;
  /** Which downstream surfaces reference this shot. Never empty. */
  readonly consumers: readonly ShotConsumer[];
  /**
   * When true, the record phase does not capture this shot from the live app —
   * a human-supplied override in `overrides/<id>/` is the sole source. Use for
   * surfaces the automated harness cannot reach (a real device recording, a
   * hardware demo). The override still runs through the same optimization path.
   */
  readonly skipAuto?: boolean;
  /**
   * Which frame of the encoded loop becomes the dark poster (loops only).
   * `first` (the default) uses frame 0, so the poster→autoplay handoff is
   * pixel-identical. `settled` uses the last clean frame before the end-seam
   * crossfade — for loops that open on a build-up (streaming text, a loading
   * skeleton) whose money state only exists near the end. The handoff then
   * jumps from the settled poster back to the opening frame; that trade is
   * deliberate, because the poster is also what GitHub release notes and docs
   * embed as a still, and a skeleton there reads as a broken screenshot.
   */
  readonly posterFrame?: 'first' | 'settled';
}

/**
 * Every product-media shot. The 17 marketing surfaces are the current catalog;
 * docs- or changelog-only shots are added here with the appropriate
 * `consumers` and simply do not surface on `/features`.
 */
export const SHOTS: readonly Shot[] = [
  // --- Desktop stills (marketing; several also embed in the docs) ---
  // `cockpit` keeps a word the product no longer says (DOR-1517 retired
  // "cockpit" and "mission control" from all user-facing prose). The id is a
  // purely internal key, and it names `cockpit-light.png` in the live
  // `public/product/manifest.json` plus every archived per-version manifest
  // back to v0.46.0. Renaming it would orphan that generated media, which no
  // visitor ever sees a word of, so the key stays and the copy moved on.
  { id: 'cockpit', kind: 'still', frame: 'desktop', consumers: ['marketing', 'docs'] },
  { id: 'agents', kind: 'still', frame: 'desktop', consumers: ['marketing', 'docs'] },
  { id: 'tasks', kind: 'still', frame: 'desktop', consumers: ['marketing', 'docs'] },
  { id: 'marketplace', kind: 'still', frame: 'desktop', consumers: ['marketing', 'docs'] },
  { id: 'tool-approval', kind: 'still', frame: 'desktop', consumers: ['marketing', 'docs'] },
  // --- Desktop loops (marketing) ---
  { id: 'topology', kind: 'loop', frame: 'desktop', consumers: ['marketing'] },
  { id: 'chat-streaming', kind: 'loop', frame: 'desktop', consumers: ['marketing'] },
  { id: 'subagents', kind: 'loop', frame: 'desktop', consumers: ['marketing'] },
  { id: 'multi-session', kind: 'loop', frame: 'desktop', consumers: ['marketing'] },
  { id: 'personality', kind: 'loop', frame: 'desktop', consumers: ['marketing'] },
  // canvas is also embedded in the docs (docs/guides/generative-ui.mdx).
  { id: 'canvas', kind: 'loop', frame: 'desktop', consumers: ['marketing', 'docs'] },
  { id: 'canvas-editing', kind: 'loop', frame: 'desktop', consumers: ['marketing'] },
  // agent-discovery is also embedded in the docs (docs/guides/agent-discovery.mdx).
  { id: 'agent-discovery', kind: 'loop', frame: 'desktop', consumers: ['marketing', 'docs'] },
  // gen-ui-widgets is also embedded in the docs (docs/guides/generative-ui.mdx).
  // Both gen-ui loops open on streaming text + a loading skeleton (the reveal
  // is the money), so their posters come from the settled end state instead.
  {
    id: 'gen-ui-widgets',
    kind: 'loop',
    frame: 'desktop',
    consumers: ['marketing', 'docs'],
    posterFrame: 'settled',
  },
  // gen-ui-tictactoe is also embedded in the docs (docs/guides/generative-ui.mdx).
  {
    id: 'gen-ui-tictactoe',
    kind: 'loop',
    frame: 'desktop',
    consumers: ['marketing', 'docs'],
    posterFrame: 'settled',
  },
  // --- Mobile stills (marketing) ---
  { id: 'mobile-sessions', kind: 'still', frame: 'mobile', consumers: ['marketing'] },
  { id: 'mobile-approval', kind: 'still', frame: 'mobile', consumers: ['marketing'] },
  // --- Mobile loop (marketing) ---
  { id: 'mobile-chat', kind: 'loop', frame: 'mobile', consumers: ['marketing'] },
  // --- Desktop stills (docs-only; not on /features) ---
  // The marketplace package detail sheet (permissions preview + install),
  // embedded in docs/marketplace/index.mdx.
  { id: 'marketplace-detail', kind: 'still', frame: 'desktop', consumers: ['docs'] },
  // The Workbench: Files tab open beside an opened code file in Canvas, tab
  // strip visible. Embedded in docs/guides/workbench.mdx.
  { id: 'workbench', kind: 'still', frame: 'desktop', consumers: ['docs'] },
  // The Installed packages panel with a global + agent-scoped ("overrides
  // global") row for the same package. Embedded in docs/marketplace/index.mdx.
  { id: 'marketplace-installed', kind: 'still', frame: 'desktop', consumers: ['docs'] },
  // Settings → DorkOS account, pending and linked states from one device-flow
  // drive (capture-cloud-link-stub). Embedded in docs/self-hosting/dorkos-accounts.mdx.
  { id: 'accounts-pending', kind: 'still', frame: 'desktop', consumers: ['docs'] },
  { id: 'accounts-linked', kind: 'still', frame: 'desktop', consumers: ['docs'] },
  // --- Desktop stills (the power surfaces) ---
  // The three power surfaces v0.64.0 shipped, whose release notes had to
  // describe them in words for want of a picture. A docs page that later embeds
  // one adds `docs` here — the site's shot guard fails the build otherwise.
  //
  // The Control Center flyout: the global Trust Dial, the power switches, and
  // the Exceptions ledger. Also `marketing`: it is the money shot for the
  // `control-center` feature card, which bound its media the day this asset
  // existed.
  { id: 'control-center', kind: 'still', frame: 'desktop', consumers: ['marketing', 'changelog'] },
  // The other two stay changelog-only: no `/features` card binds them and no
  // docs page embeds them.
  //
  // The one-time full-power consent door, the modal that asks the power
  // question once.
  { id: 'full-power-door', kind: 'still', frame: 'desktop', consumers: ['changelog'] },
  // Settings → Rooms: the four reply-limit dials behind the Control Center's
  // "Limit automatic replies" switch.
  { id: 'settings-rooms', kind: 'still', frame: 'desktop', consumers: ['changelog'] },
  // --- Desktop stills (v0.66.0 release headline) ---
  // A channel's Files section: ROOM.md pinned above a couple of real,
  // committed files, each with its provenance column drawn ("who last
  // touched it").
  { id: 'room-files', kind: 'still', frame: 'desktop', consumers: ['changelog'] },
  // A scheduled task's edit form, Advanced settings expanded to the Runs-on
  // fieldset (runtime + model).
  { id: 'task-runtime-picker', kind: 'still', frame: 'desktop', consumers: ['changelog'] },
];

/** Index of shots by id for O(1) lookup. */
const SHOTS_BY_ID = new Map<string, Shot>(SHOTS.map((s) => [s.id, s]));

/** Look up a shot by id, or `undefined` if it is not registered. */
export function getShot(id: string): Shot | undefined {
  return SHOTS_BY_ID.get(id);
}

/** True when the shot exists and is flagged to skip automated capture. */
export function isAutoSkipped(id: string): boolean {
  return getShot(id)?.skipAuto === true;
}

/** Pixel dimensions of a produced asset. */
export interface Dimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * The pixel dimensions a shot's asset is normalized to, by kind. Stills are
 * captured (and overrides scaled) at the device-scaled viewport; loops are
 * encoded at the logical video size. These are the numbers the manifest and the
 * media-guard test expect.
 *
 * @param shot - The shot whose target size to resolve.
 * @param kind - `still` for the light still/poster, `loop` for the webm.
 * @returns The target width and height in pixels.
 */
export function shotTargetDimensions(shot: Shot, kind: ShotKind): Dimensions {
  if (shot.frame === 'mobile') {
    return kind === 'loop'
      ? { ...MOBILE_VIDEO_SIZE }
      : {
          width: MOBILE_VIEWPORT.width * MOBILE_SCALE_FACTOR,
          height: MOBILE_VIEWPORT.height * MOBILE_SCALE_FACTOR,
        };
  }
  return kind === 'loop'
    ? { ...VIDEO_SIZE }
    : {
        width: DESKTOP_VIEWPORT.width * DEVICE_SCALE_FACTOR,
        height: DESKTOP_VIEWPORT.height * DEVICE_SCALE_FACTOR,
      };
}

/**
 * Shots always placed on shard 0 in a parallel record, in registry order:
 *
 * - `multi-session` and `mobile-sessions` are the SIDEBAR surfaces — their money
 *   is an inhabited Now/Today panel. Each drive mints its own Today rows by
 *   opening the conversations it started, but the Now zone above them counts
 *   every turn still running or still stopped for an approval anywhere in the
 *   same stack. Pinning both to shard 0 keeps that summary tied to one stack's
 *   state instead of letting it vary with shard placement. (No other shot reads
 *   the sidebar's zones: the remaining chat surfaces are single-session views,
 *   and the cockpit's recent activity comes from the seeded sessions present in
 *   every shard.)
 * - `agent-discovery` flips its stack's global onboarding state, which every
 *   other shot in the same stack needs left dismissed — it stays a singleton on
 *   shard 0, where the record phase drives it in the closing pair (discovery,
 *   then the door), after every shot that reads the dismissed state, and
 *   restores that state after. Each shard has its own `DORK_HOME`, so the flip
 *   is already isolated; pinning makes the placement deterministic for any N.
 * - `accounts-pending` and `accounts-linked` come from ONE linear device flow
 *   (link → pending → auto-flip → linked, capture-cloud-link-stub); a
 *   round-robin split would put them on different stacks and break the flow,
 *   so both ride shard 0 as a unit — the same single-stack rationale as the
 *   session-list shots above.
 * - `full-power-door` un-answers the stack's power decision so the one-time
 *   consent modal becomes eligible again — a global config flip every other shot
 *   in the same stack needs left settled, or the modal would focus-trap itself
 *   over their frames. Same shape as `agent-discovery`, and the second half of
 *   that closing pair: driven dead last of all, and restored afterwards. Each
 *   shard has its own `DORK_HOME`, so the flip is already isolated; pinning
 *   makes the placement deterministic for any N.
 */
export const SHARD_0_PINNED_SHOTS: readonly string[] = [
  'multi-session',
  'mobile-sessions',
  'agent-discovery',
  'accounts-pending',
  'accounts-linked',
  'full-power-door',
];

/**
 * Partition shots across `shardCount` stacks for a parallel record. Assignment
 * is round-robin by registry order (deterministic and roughly balanced across
 * the loop-heavy tail), except {@link SHARD_0_PINNED_SHOTS}, which always land
 * on shard 0 (within a shard, drives execute in the record phase's fixed
 * sequence, so their relative order is preserved automatically). Each returned
 * bucket is the set of shot ids one worker process captures; the union is
 * exactly `shots`.
 *
 * @param shots - The shots to capture (already filtered of `skipAuto` shots).
 * @param shardCount - Number of parallel stacks (>= 1).
 * @returns One shot-id array per shard, indexed by shard number.
 */
export function partitionShots(shots: readonly Shot[], shardCount: number): string[][] {
  const buckets: string[][] = Array.from({ length: Math.max(1, shardCount) }, () => []);
  const pinned = new Set(SHARD_0_PINNED_SHOTS);
  let cursor = 0;
  for (const shot of shots) {
    if (pinned.has(shot.id)) {
      buckets[0]!.push(shot.id);
      continue;
    }
    buckets[cursor % buckets.length]!.push(shot.id);
    cursor++;
  }
  return buckets;
}

/** The registry snapshot embedded in the published manifest (`manifest.shots`). */
export interface ShotManifestEntry {
  readonly id: string;
  readonly kind: ShotKind;
  readonly frame: ShotFrame;
  readonly consumers: readonly ShotConsumer[];
}

/** Project the registry into the serializable form the manifest carries. */
export function shotsManifest(): ShotManifestEntry[] {
  return SHOTS.map(({ id, kind, frame, consumers }) => ({ id, kind, frame, consumers }));
}
