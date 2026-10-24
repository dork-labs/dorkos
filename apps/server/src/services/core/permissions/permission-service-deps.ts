/**
 * What the permission service reads and writes through, kept apart from the
 * service so its file stays under the line ratchet.
 *
 * @module services/core/permissions/permission-service-deps
 */
import type { PermissionStop } from '@dorkos/shared/agent-runtime';
import type {
  AgentPermissions,
  PermissionChange,
  PermissionConfigInput,
} from '@dorkos/shared/permissions';
import type { ActivityService } from '../../activity/activity-service.js';
import type { PermissionActionInfo, PermissionAgentRef } from './permission-service.js';
import type { LevelReach } from './level-reach-note.js';

/** The stored Files & commands stops: the global one, and each runtime's own. */
export interface StoredTrustStops {
  /** `runtimes.defaultTrustStop`. */
  global: PermissionStop | null;
  /** Each runtime's own stop, by runtime id (`claude-code`, `codex`, `opencode`). */
  perRuntime: Readonly<Record<string, PermissionStop | null>>;
}

/** Everything the service reads and writes through. */
export interface PermissionServiceDeps {
  /** The install's `permissions` config section, read and written whole. */
  config: {
    get: () => PermissionConfigInput & { upgradeSweptVersion: string | null };
    set: (next: PermissionConfigInput & { upgradeSweptVersion: string | null }) => void;
    /** The stored Files & commands stops. */
    trustStops: () => StoredTrustStops;
    /** Write the global Files & commands stop (`null` = not set). */
    setGlobalTrustStop: (stop: PermissionStop | null) => void;
    /**
     * Write one runtime's own Files & commands stop (`null` = not set). Returns
     * false for a runtime this build does not know, which writes nothing.
     */
    setRuntimeTrustStop: (runtime: string, stop: PermissionStop | null) => boolean;
  };
  /** The registered agents and the manifest write-through. */
  agents: {
    list: () => PermissionAgentRef[];
    /** Read an agent's stored overrides fresh off its manifest file. */
    readPermissions: (projectPath: string) => Promise<AgentPermissions | undefined>;
    /** Write an agent's overrides through the manifest (absent = inherit all). */
    writePermissions: (agentId: string, next: AgentPermissions | undefined) => Promise<void>;
    /**
     * The agent's settings exactly as its file holds them, for the arrival
     * screen, which must see what it is narrowing. Defaults to
     * {@link readPermissions}.
     */
    readStoredPermissions?: (projectPath: string) => Promise<AgentPermissions | undefined>;
  };
  /** Every action an agent can reach, with its area. Read per call. */
  actions: () => PermissionActionInfo[];
  /** Whether the record of screened arrivals can be read and saved. */
  arrivalsHealthy?: () => boolean;
  /** The Activity log, absent in a process with none. */
  activity?: Pick<ActivityService, 'emit' | 'list' | 'get'>;
  /**
   * What a change to a level adds to its history line: how many existing chats
   * it reaches, and which rose (DOR-3175). Absent, or `undefined` for a change
   * that moves no chat, and the line is as it was.
   */
  levelReach?: (changes: readonly PermissionChange[]) => Promise<LevelReach | undefined>;
}
