/**
 * What a scripted turn needs from the rest of the server: the rooms, the
 * capability registries, the session canvas, the heartbeat and the test
 * account world.
 *
 * Startup builds it from both sides (`startup/test-composition/`) and hands it
 * to every test-mode runtime it registers, which passes it to each scenario on
 * {@link ScenarioContext}. So the scripted turns call the real thing while
 * nothing in this folder imports the space side (spec
 * `computer-side-starts-alone` §5.13).
 *
 * @module services/runtimes/test-mode/scenario-world
 */
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import type { CanvasChannelDocEventsContext } from '@dorkos/shared/canvas-channel-schemas';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import type { UiCanvasContent } from '@dorkos/shared/schemas';
import type { LocalBrowserService } from '../../session/local-browser/service.js';
import type { ScenarioContext } from './interaction-gate.js';
import type { ScenarioFn } from './scenario-store.js';

/** Who a scripted turn acts as when it calls a capability, and from where. */
export interface ScenarioCallContext {
  /** The agent the call is made as. */
  identity?: { agentPath: string; displayName: string; createdAt: string };
  /** The session the call comes from. */
  sessionId?: string;
  /** Where the turn stands. */
  cwd?: string;
}

/**
 * Invoke one capability by id through the real registry, the way an in-session
 * MCP call lands.
 *
 * @returns What the capability answered.
 * @throws What the capability throws, including its refusals.
 */
export type ScenarioInvoke = (
  capabilityId: string,
  input: unknown,
  context: ScenarioCallContext
) => Promise<unknown>;

/** A room author, as a scripted turn reads one. */
export interface ScenarioRoomAuthor {
  /** The author's natural key: an agent's home folder for an agent. */
  naturalKey: string;
  /** The name the room shows. */
  displayName: string;
}

/** A picture a capability answered with, beside the JSON that describes it. */
export interface ScenarioImage {
  /** The picture: base64 bytes and the media type they are. */
  image: { data: string; mimeType: string };
  /** The JSON the model is shown beside it. */
  payload: unknown;
}

/** The server a scripted turn runs against, composed by startup. */
export interface ScenarioWorld {
  /** This server's rooms, read at call time. */
  rooms: {
    /** The author with this id, or `undefined` when the room has none. */
    authorOf(authorId: string): ScenarioRoomAuthor | undefined;
    /** The name the rooms know the agent at this home by. */
    agentNameOf(agentPath: string): string | undefined;
    /** The room's entries after `afterSeq`, oldest first. */
    entriesAfter(roomId: string, afterSeq: number): RoomEntry[];
    /** The `rooms.*` capabilities. */
    invoke: ScenarioInvoke;
  };
  /** The `heartbeat.*` capabilities. */
  heartbeat: { invoke: ScenarioInvoke };
  /**
   * The `local_browser.*` capabilities over the boot-owned browser service.
   *
   * @param browser - The service the person's Browser tab is on.
   */
  localBrowserTools(browser: LocalBrowserService): ScenarioInvoke;
  /**
   * The picture in a capability's answer, or `undefined` when it carries none.
   *
   * @param result - What a capability answered.
   */
  imageOf(result: unknown): ScenarioImage | undefined;
  /**
   * The error payload a capability refused with, or `undefined` when `error`
   * is not a capability's refusal.
   *
   * @param error - What a capability call threw.
   */
  refusalOf(error: unknown): { payload: unknown } | undefined;
  /**
   * The agent home a turn stands in, read the way every runtime reads it.
   *
   * @param opts - The turn's options: its folder and the agent it is for.
   */
  agentHomeOf(opts: MessageOpts | undefined): string | undefined;
  /**
   * Put a document on a session's canvas as its agent. A no-op on a server
   * with no canvas.
   *
   * @param sessionId - The session whose canvas it goes on.
   * @param content - The document.
   */
  openSessionCanvas(sessionId: string, content: UiCanvasContent): void;
  /**
   * Render a document-events entry exactly as a production runtime's prompt
   * carries it.
   *
   * @param context - The entry's data.
   */
  renderDocEvents(context: CanvasChannelDocEventsContext): string;
  /**
   * The scenario a turn runs instead of its own when the test account world
   * forces its account out (DOR-3143); `undefined` otherwise. Records the
   * launch either way.
   *
   * @param sessionId - The session the turn runs on.
   * @param opts - The turn's options, for its launch hint and room.
   */
  forcedLimitScenario(sessionId: string, opts: MessageOpts | undefined): ScenarioFn | undefined;
  /** Clear the test account world, so no test inherits one. */
  resetAccountWorld(): void;
}

/**
 * The world this turn runs against.
 *
 * @param ctx - The turn's context.
 * @throws When the runtime was registered without one.
 */
export function worldOf(ctx: Pick<ScenarioContext, 'world'>): ScenarioWorld {
  if (!ctx.world) {
    throw new Error(
      'This scripted turn needs the scenario world, which startup hands the runtime.'
    );
  }
  return ctx.world;
}
