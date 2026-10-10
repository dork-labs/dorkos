/**
 * DorkBot's first-run welcome in #team (spec `one-minute-onboarding` §4.2).
 *
 * Posted once: the entry id is kept in `onboarding.welcomeEntryId`, and a later
 * call answers with it without posting again. The welcome is scripted and
 * token-free, and it goes through the room's non-dispatching greeting path
 * (`RoomService.postAgentGreeting`), so it starts no agent turn and raises no
 * notification even though #team seats every agent.
 *
 * @module services/core/onboarding/welcome
 */
import path from 'node:path';
import type { Room, RoomEntry } from '@dorkos/shared/room-schemas';
import { TEAM_ROOM_WELL_KNOWN } from '@dorkos/shared/room-schemas';
import { dorkbotWelcomeText } from '@dorkos/shared/dorkbot-templates';
import type { OnboardingWelcomeResult } from '@dorkos/shared/onboarding-schemas';
import { logConfigWrite } from '../operator/config-write.js';
import { FirstRunError, type FirstRunConfigPort } from './first-run.js';

/** The room calls the welcome needs. */
export interface WelcomeRooms {
  /** The room holding a well-known key, or `null`. */
  findWellKnownRoom(key: string): Room | null;
  /** One room's agent members, with their directories. */
  listAgentMembers(roomId: string): { authorId: string; agentPath: string }[];
  /** Post an agent's scripted greeting without waking anyone. */
  postAgentGreeting(roomId: string, input: { authorId: string; text: string }): RoomEntry;
}

/** What posting the welcome needs. Injectable for tests. */
export interface WelcomeDeps {
  /** Config reads and writes. */
  config: FirstRunConfigPort;
  /** The rooms. */
  rooms: WelcomeRooms;
  /** DorkBot's directory. */
  dorkbotPath: string;
  /** What to call the person, when anything says. */
  personName: () => string | null;
}

/** #team, or DorkBot's seat in it, is not there to post into yet. */
export class WelcomeUnavailableError extends Error {
  /** The HTTP status the route answers with. */
  readonly status = 503;

  /**
   * Build the refusal.
   *
   * @param message - The sentence a person reads.
   */
  constructor(message: string) {
    super(message);
    this.name = 'WelcomeUnavailableError';
  }
}

/**
 * Post DorkBot's welcome into #team, once, and return its entry.
 *
 * @param deps - The config, the rooms, DorkBot's directory and the name.
 * @throws {FirstRunError} 409 once the first run finished without a welcome.
 * @throws {WelcomeUnavailableError} 503 when #team or DorkBot's seat in it is
 *   missing.
 */
export function postFirstRunWelcome(deps: WelcomeDeps): OnboardingWelcomeResult {
  const room = deps.rooms.findWellKnownRoom(TEAM_ROOM_WELL_KNOWN);
  if (!room) throw new WelcomeUnavailableError('#team is not ready yet. Try again.');
  const onboarding = deps.config.get('onboarding');
  if (onboarding.welcomeEntryId !== null) {
    return { roomId: room.id, entryId: onboarding.welcomeEntryId };
  }
  if (onboarding.completedAt !== null) {
    throw new FirstRunError(409, 'onboarding_complete', 'Setup is already finished.');
  }
  const dorkbot = deps.rooms
    .listAgentMembers(room.id)
    .find((member) => path.resolve(member.agentPath) === path.resolve(deps.dorkbotPath));
  if (!dorkbot) throw new WelcomeUnavailableError('DorkBot is not in #team yet. Try again.');
  const entry = deps.rooms.postAgentGreeting(room.id, {
    authorId: dorkbot.authorId,
    text: dorkbotWelcomeText(onboarding.firstRunPath, deps.personName()),
  });
  const next = { ...deps.config.get('onboarding'), welcomeEntryId: entry.id };
  deps.config.set('onboarding', next);
  logConfigWrite('the first-run welcome', 'onboarding', onboarding, next);
  return { roomId: room.id, entryId: entry.id };
}
