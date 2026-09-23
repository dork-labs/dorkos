import type { Browser, Page } from '@playwright/test';
import type { Desktop, LaunchContext } from './desktop.js';
import type { CommunityServer, Infrastructure } from './infra.js';

/**
 * What every stage of the two-Desktop journey shares: the runner's context,
 * the Communities' names, and the state and helpers the setup stage builds.
 *
 * @module community-two-desktop/world
 */

/** What the journey needs from the runner. */
export interface JourneyContext {
  browser: Browser;
  launch: LaunchContext;
  infra: Infrastructure;
  proof: CommunityServer;
  isolation: CommunityServer;
  /** Record one step: log it, time it, keep its evidence, rethrow a failure. */
  step: <T>(name: string, work: () => Promise<T>) => Promise<T>;
  /** Save a screenshot under the run's screenshots folder; returns its relative path. */
  shot: (page: Page, name: string) => Promise<string>;
  /** Soft observations, recorded in the receipt without failing the run. */
  findings: Array<Record<string, unknown>>;
  /** The apps, as they are launched, so the runner can close them and shoot them on failure. */
  desktops: Desktop[];
  /** Values the receipt should carry. */
  receipt: Record<string, unknown>;
  /** The people's browser pages by name, so the runner can shoot them on failure. */
  browserPages: Record<string, Page>;
}

/** The Community both people are in. */
export const COMMUNITY = 'Desktop Proof';
/** A's second Community, which B never joins. */
export const ISOLATION = 'Isolation Proof';
/** The private channel only A is in. */
export const PRIVATE_CHANNEL = 'core-team';

/** One Community message, as the local server returns it. */
export interface Entry {
  id: string;
  text: string;
  authorKind?: string;
  authorDisplayName?: string;
  attachments: Array<{ id: string; name: string }>;
}
/** One Community room, as the local server lists it. */
export interface Room {
  roomId: string;
  title: string;
}

/** The journey's shared state, built by the setup stage (steps 1-9). */
export interface World {
  ctx: JourneyContext;
  step: JourneyContext['step'];
  shot: JourneyContext['shot'];
  findings: JourneyContext['findings'];
  /** Person A's app (owns both Communities). */
  a: Desktop;
  /** Person B's app (a member of Desktop Proof only). */
  b: Desktop;
  /** A's browser on Desktop Proof. */
  owner: Page;
  /** B's browser on Desktop Proof. */
  member: Page;
  /** A's browser on Isolation Proof. */
  isolationOwner: Page;
  communityOrigin: string;
  isolationOrigin: string;
  /** Desktop Proof's community id, from its invite links. */
  communityId: string;
  refA: string;
  /** B's current connection; later stages reconnect and replace it. */
  refB: string;
  refIso: string;
  /** Desktop Proof's #general. */
  room: Room;
  /** A per-run marker in every message this run sends. */
  stamp: string;
  MSG_A: string;
  MSG_B: string;
  THREAD_B: string;
  ATTACH_TEXT: string;
  ATTACH_NAME: string;
  ATTACH_BODY: string;
  ISOLATED_MSG: string;
  /** The 40 history rows step 15b adds, oldest first. */
  fillers: string[];
  /** Every Desktop Proof room id seen so far, for the local-lookup checks. */
  communityRoomIds: string[];
  /** Open Desktop Proof's #general in an app. */
  openGeneral: (local: Desktop, ref: string) => Promise<void>;
  /** Scroll until a message is on screen at the newest end of the feed. */
  seeNewest: (local: Desktop, text: string) => Promise<void>;
  /** Scroll up by hand and wait until the app remembers that row. */
  scrollUpAndRemember: (
    local: Desktop,
    ref: string,
    newest: string
  ) => Promise<{ anchorText: string; body: unknown }>;
  /** Resize an app's window. */
  resize: (local: Desktop, width: number, height: number) => Promise<void>;
  /** Assert neither app asked its local rooms route for a Community room. */
  noLocalLookups: () => Promise<Record<string, unknown>>;
  /** Create a one-time invite to #general from an owner's browser. */
  createInvite: (page: Page) => Promise<string>;
  /** Check a product contract; a failure is recorded as a product bug and the run continues. */
  productCheck: (check: string, repro: string, verify: () => Promise<void>) => Promise<void>;
}
