/** Canonical local-only target preparation for private event notifications. */
import { createHash } from 'node:crypto';
import { eq, sessionMetadata, type Db } from '@dorkos/db';
import { readManifest } from '@dorkos/shared/manifest';
import { stableStringify } from '@dorkos/shared/capabilities';
import type { ConnectorOwnerAuthority } from '../principal/server-principal.js';
import type {
  ConnectorEventSessionOrigin,
  ConnectorEventSessionTargetPort,
} from './session-source-adapter.js';

/** Exact persisted agent snapshot; a changed registration cannot inherit an old notification. */
export function readConnectorEventSessionOrigin(
  db: Db,
  agentId: string
): ConnectorEventSessionOrigin | undefined {
  const agent = db.$client
    .prepare('SELECT id, runtime, project_path, updated_at FROM agents WHERE id = ?')
    .get(agentId) as
    { id: string; runtime: string; project_path: string; updated_at: string } | undefined;
  if (!agent) return undefined;
  return {
    agentId: agent.id,
    runtime: agent.runtime,
    agentPath: agent.project_path,
    authorityDigest: createHash('sha256').update(stableStringify(agent)).digest('hex'),
  };
}

/** Production dependencies intentionally expose no runtime dispatch or session creation methods. */
export interface ConnectorEventSessionTargetOptions {
  db: Db;
  ownsAgent(owner: ConnectorOwnerAuthority, agentId: string): boolean;
  sessions: {
    has(runtime: string): boolean;
    persistSessionRuntime(
      sessionId: string,
      runtime: string,
      agentPath: string,
      options: { interactive: boolean }
    ): Promise<boolean>;
  };
}

/** Persists normal session defaults through RuntimeRegistry while keeping runtime effects deferred. */
export class CanonicalConnectorEventSessionTarget implements ConnectorEventSessionTargetPort {
  constructor(private readonly options: ConnectorEventSessionTargetOptions) {}

  /** Resolve the exact current registered agent and manifest runtime without a fallback. */
  async resolve(
    owner: ConnectorOwnerAuthority,
    agentId: string
  ): Promise<ConnectorEventSessionOrigin | undefined> {
    if (!this.options.ownsAgent(owner, agentId)) return undefined;
    const origin = readConnectorEventSessionOrigin(this.options.db, agentId);
    if (!origin || !this.options.sessions.has(origin.runtime)) return undefined;
    const manifest = await readManifest(origin.agentPath);
    if (
      !manifest ||
      manifest.id !== agentId ||
      manifest.runtime !== origin.runtime ||
      stableStringify(origin) !==
        stableStringify(readConnectorEventSessionOrigin(this.options.db, agentId))
    )
      return undefined;
    return origin;
  }

  /** Bind local metadata only, preserving registry defaults and first-write-wins ownership. */
  async bind(sessionId: string, origin: ConnectorEventSessionOrigin): Promise<void> {
    await this.options.sessions.persistSessionRuntime(sessionId, origin.runtime, origin.agentPath, {
      interactive: false,
    });
  }

  /** Synchronous same-transaction origin check used immediately before protected runtime dispatch. */
  current(
    owner: ConnectorOwnerAuthority,
    sessionId: string,
    origin: ConnectorEventSessionOrigin
  ): boolean {
    if (
      !this.options.ownsAgent(owner, origin.agentId) ||
      !this.options.sessions.has(origin.runtime) ||
      stableStringify(origin) !==
        stableStringify(readConnectorEventSessionOrigin(this.options.db, origin.agentId))
    )
      return false;
    const session = this.options.db
      .select({ runtime: sessionMetadata.runtime, agentPath: sessionMetadata.agentPath })
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, sessionId))
      .get();
    return session?.runtime === origin.runtime && session.agentPath === origin.agentPath;
  }
}
