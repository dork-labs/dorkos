/**
 * Per-agent upgrade awareness, held in memory and atomically persisted outside
 * settings and the rebuildable agent cache. Only this server writes this file.
 * @module session/new-since/seen-versions
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gt, valid } from 'semver';
import { writeFileAtomic } from '@dorkos/shared/atomic-write';
import type { NewSinceData } from '@dorkos/shared/additional-context';
import { IS_DEV_BUILD, SERVER_VERSION } from '../../../lib/version.js';
import { logger } from '../../../lib/logger.js';
import {
  notesSince,
  releaseNoteLine,
  type AgentReleaseNote,
} from '../../runtimes/shared/awareness/agent-release-notes.js';

/** A claim to hand back if no turn started. */
export interface NewSinceClaim {
  agentId: string;
  previousVersion: string;
  data: NewSinceData;
}

/** One store per server; taking and restoring cannot interleave across sessions. */
export class SeenVersions {
  private readonly versions = new Map<string, string>();
  private readonly claims = new Map<string, NewSinceClaim>();
  private readonly file: string;
  private pending: Promise<void> = Promise.resolve();

  /** Load the server-owned state once. Missing or damaged state starts silently. */
  constructor(
    dorkHome: string,
    private readonly options: { version: string; dev: boolean; notes?: readonly AgentReleaseNote[] }
  ) {
    this.file = path.join(dorkHome, 'state', 'agent-seen-versions.json');
    if (options.dev) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [id, version] of Object.entries(parsed)) {
          if (typeof version === 'string' && valid(version)) this.versions.set(id, version);
        }
      }
    } catch {
      /* A first run has nothing to compare against. */
    }
  }

  /** Claim the update once; a first run only records the baseline. */
  takeNewSince(agentId: string): NewSinceClaim | null {
    const current = this.options.version;
    if (this.options.dev || !valid(current)) return null;
    const previous = this.versions.get(agentId);
    if (previous !== undefined && !gt(current, previous)) return null;
    this.versions.set(agentId, current);
    this.persist();
    if (previous === undefined) return null;
    const notes = notesSince(previous, current, this.options.notes);
    if (notes.length === 0) return null;
    const claim: NewSinceClaim = {
      agentId,
      previousVersion: previous,
      data: {
        previousVersion: previous,
        currentVersion: current,
        lines: notes.slice(0, 8).map(releaseNoteLine),
        omitted: Math.max(0, notes.length - 8),
      },
    };
    this.claims.set(agentId, claim);
    return claim;
  }

  /** Restore only this claim, never a later successful take or a newer version. */
  restoreNewSince(claim: NewSinceClaim): void {
    if (this.claims.get(claim.agentId) !== claim) return;
    this.claims.delete(claim.agentId);
    this.versions.set(claim.agentId, claim.previousVersion);
    this.persist();
  }

  /** Forget the receipt after dispatch, while retaining the recorded version. */
  delivered(claim: NewSinceClaim): void {
    if (this.claims.get(claim.agentId) === claim) this.claims.delete(claim.agentId);
  }

  /** Wait for queued atomic writes, including restores. */
  async flush(): Promise<void> {
    await this.pending;
  }

  private persist(): void {
    const snapshot = JSON.stringify(Object.fromEntries(this.versions));
    this.pending = writeFileAtomic(this.file, snapshot).catch((err) => {
      logger.warn('[new-since] Could not save seen versions', { err });
    });
  }
}

let store: SeenVersions | undefined;

/** Wire the resolved data directory once during session-services startup. */
export function initSeenVersions(dorkHome: string): void {
  store = new SeenVersions(dorkHome, { version: SERVER_VERSION, dev: IS_DEV_BUILD });
}

/** The boot-wired store, absent in harnesses that do not run ordinary turns. */
export function seenVersions(): SeenVersions | undefined {
  return store;
}
