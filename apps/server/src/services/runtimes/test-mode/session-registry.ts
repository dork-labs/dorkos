/** In-memory rows and unannounced draft settings for the test-mode runtime. */
import type { PermissionModeId } from '@dorkos/shared/types';
import { TrackedSessionRegistry } from '../shared/session/session-registry.js';
import { TEST_MODE_CAPABILITIES } from './runtime-constants.js';

/**
 * The mode a session is BORN in when nothing asks for one — read off this
 * runtime's own declaration rather than restated here.
 *
 * It used to be the literal `'default'`, which `test-mode` does not declare.
 * A fresh session therefore opened showing a mode its own picker could not
 * offer, and once the session PATCH started checking the request against the
 * runtime's declaration (DOR-811), switching BACK to that mode was refused —
 * a session stuck in a state it could not return to.
 *
 * The `??` is a type bound, not a policy: `RuntimeCapabilities` types `default`
 * as optional, and `TEST_MODE_CAPABILITIES` always declares it. Falling back to
 * the first declared descriptor keeps the one property that matters — the birth
 * mode is always a mode this runtime declares — without a second copy of an id.
 */
const BIRTH_PERMISSION_MODE: PermissionModeId =
  TEST_MODE_CAPABILITIES.permissionModes.default ??
  TEST_MODE_CAPABILITIES.permissionModes.values[0]!.id;

/** Metadata fields the registry can save for a draft or tracked session. */
export interface TrackedSessionPatch {
  permissionMode?: PermissionModeId;
  model?: string;
  cwd?: string;
}

/** Test-mode adds pre-message settings and optional recording titles. */
export class TestModeSessionRegistry extends TrackedSessionRegistry<TrackedSessionPatch> {
  private readonly pendingSettings = new Map<string, TrackedSessionPatch>();

  constructor(runtimeType = 'test-mode', labelTitle?: (title: string) => string) {
    super({ runtime: runtimeType, defaultPermissionMode: BIRTH_PERMISSION_MODE, labelTitle });
  }

  override register(sessionId: string, patch: TrackedSessionPatch = {}): void {
    super.register(sessionId, this.consumePendingSettings(sessionId, patch));
  }

  override recordMessage(
    sessionId: string,
    content: string,
    patch: TrackedSessionPatch = {}
  ): void {
    super.recordMessage(sessionId, content, this.consumePendingSettings(sessionId, patch));
  }

  override rename(sessionId: string, title: string): void {
    super.rename(sessionId, title, this.consumePendingSettings(sessionId, {}));
  }

  /** Observe the exact pre-message settings entry without creating a session. */
  observeDraftSettingsOwner(sessionId: string): () => boolean {
    const pending = this.pendingSettings.get(sessionId);
    return () => !this.has(sessionId) && this.pendingSettings.get(sessionId) === pending;
  }

  /** Save draft settings without announcing a conversation before its first message. */
  applySettings(sessionId: string, patch: TrackedSessionPatch): boolean {
    if (!this.has(sessionId)) {
      this.pendingSettings.set(sessionId, { ...this.pendingSettings.get(sessionId), ...patch });
      return true;
    }
    this.register(sessionId, patch);
    return true;
  }

  override reset(): void {
    this.pendingSettings.clear();
    super.reset();
  }

  private consumePendingSettings(
    sessionId: string,
    patch: TrackedSessionPatch
  ): TrackedSessionPatch {
    const pending = this.pendingSettings.get(sessionId);
    if (pending === undefined) return patch;
    this.pendingSettings.delete(sessionId);
    return {
      ...pending,
      ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
    };
  }
}
