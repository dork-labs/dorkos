/**
 * Codex's tracked display metadata. Runtime discovery still combines these
 * rows with native rollouts and the durable thread map. The registry does not
 * own those stores or the transcript.
 */
import type { Session, PermissionModeId, EffortLevel } from '@dorkos/shared/types';
import { sessionShownToPerson } from '@dorkos/shared/kickoff';
import { TrackedSessionRegistry } from '../shared/session/session-registry.js';

/** Metadata fields the registry can update on a tracked session. */
export interface CodexSessionPatch {
  permissionMode?: PermissionModeId;
  model?: string;
  effort?: EffortLevel;
  fastMode?: boolean;
  cwd?: string;
}

/** Codex-specific writes layered over the shared tracked metadata. */
export class CodexSessionRegistry extends TrackedSessionRegistry<CodexSessionPatch> {
  constructor() {
    super({ runtime: 'codex', defaultPermissionMode: 'default' });
  }

  override recordMessage(
    sessionId: string,
    content: string,
    patch: CodexSessionPatch & { title?: string } = {}
  ): void {
    super.recordMessage(sessionId, content, patch, (session) => {
      // "Tools are back" lasts until the next message (DOR-4393). Null lets
      // the list-to-detail merge clear the old badge.
      if (session.dorkosTools === 'back') session.dorkosTools = null;
    });
  }

  /** Apply settings only to an already tracked session. */
  applySettings(sessionId: string, patch: CodexSessionPatch): boolean {
    if (!this.has(sessionId)) return false;
    this.register(sessionId, patch);
    return true;
  }

  /** Update and announce a changed tools badge on an already tracked chat. */
  noteDorkosTools(sessionId: string, listed: boolean): void {
    const session = this.get(sessionId);
    if (!session) return;
    const next = !listed ? 'lost' : session.dorkosTools === 'lost' ? 'back' : session.dorkosTools;
    if (next === session.dorkosTools) return;
    this.set({ ...session, dorkosTools: next });
  }

  /** Seed durable rows once without overwriting fresher live metadata. */
  hydrate(sessions: Session[]): void {
    for (const session of sessions) {
      if (!this.has(session.id)) this.set(sessionShownToPerson(session));
    }
  }

  /** Adopt verified native identity while retaining choices staged before its import. */
  adoptNative(session: Session): void {
    const current = this.get(session.id);
    const copy = {
      ...sessionShownToPerson(session),
      ...(current
        ? {
            permissionMode: current.permissionMode,
            ...(current.model !== undefined ? { model: current.model } : {}),
            ...(current.effort !== undefined ? { effort: current.effort } : {}),
            ...(current.fastMode !== undefined ? { fastMode: current.fastMode } : {}),
            ...(current.dorkosTools !== undefined ? { dorkosTools: current.dorkosTools } : {}),
          }
        : {}),
    };
    this.set(copy);
  }
}
