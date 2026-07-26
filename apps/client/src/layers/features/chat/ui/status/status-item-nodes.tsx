import type { ReactNode } from 'react';
import type {
  ConnectionState,
  ContextUsage,
  GitStatusError,
  GitStatusResponse,
  PermissionMode,
  UpdateSessionRequest,
  UsageStatus,
} from '@dorkos/shared/types';
import type { Workspace } from '@dorkos/shared/workspace';
import type { SessionStatusData } from '@/layers/entities/session';
import {
  CwdItem,
  GitStatusItem,
  PermissionModeItem,
  RuntimeItem,
  ModelConfigPopover,
  ContextItem,
  UsageStatusItem,
  hasRenderableUsage,
  ConnectionItem,
  SubagentsItem,
  type ActiveSubagent,
  type ContextCompactAction,
  type StatusBarItemKey,
  type StatusDensity,
  type RuntimeChipState,
} from '@/layers/features/status';
import { AgentIdentityChip } from './AgentIdentityChip';

/** Everything the status line's items need in order to render. */
export interface StatusItemNodesInput {
  /** Session id; empty until the route has one. */
  sessionId: string;
  /** Agent identity for the left-cluster anchor. */
  agent: { name?: string; color?: string; emoji?: string; path?: string };
  /** Derived session status — directory, model, effort, fast mode, permissions. */
  status: SessionStatusData;
  /** Apply a session change (model, effort, fast mode). */
  onUpdateSession: (opts: UpdateSessionRequest) => void;
  /** Apply a permission-mode change, gated by the auto-mode confirmation. */
  onChangeMode: (mode: PermissionMode) => void;
  /** Whether the active model can run the `auto` permission mode. */
  modelSupportsAutoMode: boolean;
  /** Git status for the session's directory, when the query has resolved. */
  gitStatus: GitStatusResponse | GitStatusError | undefined;
  /** The managed workspace this session is bound to, if any. */
  workspace: Workspace | null | undefined;
  /** Runtime chip state (display runtime, model, selectability). */
  runtimeChip: RuntimeChipState;
  /** The percent to display for the context window, or `null` before the first reading. */
  contextPercent: number | null;
  /** The SDK context breakdown, when it has arrived. */
  contextUsage: ContextUsage | null;
  /** The inline compact action, or `null` when this runtime cannot compact. */
  compact: ContextCompactAction | null;
  /** Runtime-neutral usage descriptor. */
  usage: UsageStatus | null;
  /** Whether the runtime declares it can track cost. */
  supportsCostTracking: boolean;
  /**
   * The subagents this turn has in flight — the `running` half of the fold, never
   * the runtime's catalogue of callable agent types (DOR-462).
   */
  runningSubagents: readonly ActiveSubagent[];
  /** Live-sync connection state. */
  connectionState: ConnectionState;
  /**
   * How much the measured bar width lets each item say.
   *
   * Every item below the `full` tier renders glyph + value: no runtime model half,
   * no effort or Fast badges, bounded labels (spec composer-status-redesign §6.1).
   * The narrowest tier goes further and drops the agent's name, keeping the avatar.
   */
  density: StatusDensity;
}

/**
 * Render every status line item that has something to show, keyed by registry key.
 *
 * A key is present only when its data has arrived and the runtime's capabilities
 * allow it — the promotion rules then decide which of those earn a slot. Absence
 * here means "nothing to draw", which is why `selectPromotedItems` treats a
 * missing node as an automatic no.
 *
 * @param input - All the data and callbacks the items need.
 */
export function buildStatusItemNodes(
  input: StatusItemNodesInput
): Partial<Record<StatusBarItemKey, ReactNode>> {
  const { sessionId, agent, status, runtimeChip, onUpdateSession } = input;
  const nodes: Partial<Record<StatusBarItemKey, ReactNode>> = {};
  // One boolean, threaded to every item that can be verbose. The budget counts
  // slots, so a count is only honest while the slots are all about one size —
  // `"Default (recommended)"` at ~160px beside `"78%"` at ~33px is what broke it.
  // (Not to be confused with `input.compact`, which is the *compaction* action.)
  const compactItems = input.density !== 'full';

  // The chip renders nothing until name, color, and emoji have all resolved; gate
  // the slot on the same condition so the line never reserves space for it.
  if (agent.name && agent.color && agent.emoji) {
    nodes.agent = (
      <AgentIdentityChip
        agentName={agent.name}
        agentColor={agent.color}
        agentEmoji={agent.emoji}
        agentPath={agent.path}
        nameHidden={input.density === 'avatar'}
      />
    );
  }

  if (status.cwd) nodes.cwd = <CwdItem cwd={status.cwd} />;

  if (input.gitStatus) {
    nodes.git = (
      <GitStatusItem data={input.gitStatus} workspace={input.workspace} compact={compactItems} />
    );
  }

  if (runtimeChip.runtime !== null) {
    nodes.runtime = (
      <RuntimeItem
        runtime={runtimeChip.runtime}
        model={runtimeChip.model}
        onChangeRuntime={runtimeChip.onChangeRuntime}
        canSelect={runtimeChip.canSelect}
        compact={compactItems}
      />
    );
  }

  nodes.model = (
    <ModelConfigPopover
      model={status.model}
      onChangeModel={(model) => onUpdateSession({ model })}
      effort={status.effort}
      onChangeEffort={(effort) => onUpdateSession({ effort: effort ?? undefined })}
      fastMode={status.fastMode}
      onChangeFastMode={(fastMode) => onUpdateSession({ fastMode })}
      disabled={!sessionId}
      sessionId={sessionId || undefined}
      runtime={runtimeChip.runtime}
      compact={compactItems}
    />
  );

  nodes.permission = (
    <PermissionModeItem
      mode={status.permissionMode}
      onChangeMode={input.onChangeMode}
      disabled={!sessionId}
      runtime={runtimeChip.runtime}
      modelSupportsAutoMode={input.modelSupportsAutoMode}
      compact={compactItems}
    />
  );

  if (input.contextPercent !== null) {
    nodes.context = (
      <ContextItem
        percent={input.contextPercent}
        contextUsage={input.contextUsage}
        compact={input.compact}
      />
    );
  }

  // `supportsCostTracking` gates the whole item, even the subscription-utilization
  // display: today every runtime that reports usage also reports cost, and a
  // runtime that declares it cannot track cost must never show a cost figure.
  if (input.usage && hasRenderableUsage(input.usage) && input.supportsCostTracking) {
    nodes.usage = <UsageStatusItem usage={input.usage} />;
  }

  if (input.runningSubagents.length > 0) {
    nodes.subagents = <SubagentsItem running={input.runningSubagents} />;
  }

  nodes.connection = (
    <ConnectionItem connectionState={input.connectionState} compact={compactItems} />
  );

  return nodes;
}
