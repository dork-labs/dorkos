import { readOriginalEngineViewRegistrationFacet } from './current-operation-engine.js';
import { registerOriginalReadPresenceViews } from './current-view-registration-read-presence.js';
import { registerOriginalTokenEntryViews } from './current-view-registration-token-entry.js';
import { registerOriginalRoomLifecycleViews } from './current-view-registration-room.js';

/** Register original frozen views only for the exact private constructor engine. */
export function registerOriginalEngineViews(engineOwner: object): void {
  readOriginalEngineViewRegistrationFacet(engineOwner);
  registerOriginalReadPresenceViews(engineOwner);
  registerOriginalTokenEntryViews(engineOwner);
  registerOriginalRoomLifecycleViews(engineOwner);
}
