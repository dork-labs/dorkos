/**
 * OpenCode's tracked settings and live metadata while the sidecar is still
 * binding or unavailable. Native history remains owned by the sidecar.
 */
import type { Session, PermissionModeId } from '@dorkos/shared/types';
import { TrackedSessionRegistry } from '../../shared/session/session-registry.js';

/**
 * Metadata fields the registry can update on a tracked session.
 *
 * **No `effort`, deliberately.** OpenCode's prompt API accepts no effort field
 * — verified against both the pinned and the current SDK — so an effort tracked
 * here could only ever be echoed back to whoever set it while changing nothing
 * about how the agent thinks. Tracking it was the quiet lie; not having it is
 * what lets the UI say "Not supported by OpenCode" and be telling the truth
 * (spec `execution-defaults` §4).
 */
export interface OpenCodeSessionPatch {
  permissionMode?: PermissionModeId;
  model?: string;
  fastMode?: boolean;
  cwd?: string;
}

/** Overlay locally tracked choices onto native OpenCode rows. */
export class OpenCodeSessionRegistry extends TrackedSessionRegistry<OpenCodeSessionPatch> {
  constructor() {
    super({ runtime: 'opencode', defaultPermissionMode: 'default' });
  }

  /** Capture this exact private owner before a birth-only settings read can yield. */
  prepareSettingsOwner(sessionId: string) {
    return this.observeMemoryOwner(sessionId);
  }

  /**
   * Overlay DorkOS-tracked settings onto a listed session — OpenCode has no
   * per-session permission mode, so the mapper hardcodes `'default'` and the
   * tracked value (kept current by `updateSession`) wins.
   *
   * @param session - The listed session, changed in place.
   */
  overlayTrackedSettings(session: Session): void {
    const tracked = this.get(session.id);
    if (!tracked) return;
    session.permissionMode = tracked.permissionMode;
    if (tracked.model !== undefined) session.model = tracked.model;
    if (tracked.fastMode !== undefined) session.fastMode = tracked.fastMode;
  }
}
