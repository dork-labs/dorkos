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
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import type { Workspace } from '@dorkos/shared/workspace';
import type { SessionStatusData } from '@/layers/entities/session';
import {
  CwdItem,
  GitStatusItem,
  PermissionModeItem,
  PlanModeItem,
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
  type MakeDefaultStopLineProps,
} from '@/layers/features/status';
import { AgentIdentityChip } from './AgentIdentityChip';

/** The Plan switch's declared mode, current state, and toggle. */
export interface PlanChipState {
  /** The way-of-working mode this runtime declares. */
  descriptor: PermissionModeDescriptor;
  /** Whether the session is planning right now. */
  active: boolean;
  /** Switch planning on, or off and back to the stop the session came from. */
  onToggle: (next: boolean) => void;
}

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
  /**
   * The offer to make the stop just chosen the default for every new session,
   * or `null` when there is nothing to offer (spec `trust-dial`, decision 6C).
   */
  makeDefault: MakeDefaultStopLineProps | null;
  /** Told whenever the permissions picker opens or closes. */
  onPermissionPickerOpenChange: (open: boolean) => void;
  /**
   * The composer's Plan switch, or `null` when this runtime declares no way of
   * working. Resolved by the caller from the runtime's capability profile —
   * nothing here decides which mode counts as planning.
   */
  plan: PlanChipState | null;
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
   * the runtime's catalogue of callable agent types (DOR-462). Names them for the
   * tooltip; it is {@link liveSubagentCount} that decides whether there are any.
   */
  runningSubagents: readonly ActiveSubagent[];
  /**
   * How many helpers are running as the SERVER counts them — the number drawn.
   *
   * Separate from `runningSubagents.length` because a background task outlives
   * its turn and the turn's rows do not (DOR-1100): after the history reload the
   * list is empty while the children are still working.
   */
  liveSubagentCount: number;
  /** True when the agent has stopped talking and those children are what remain. */
  waitingOnSubagents: boolean;
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

  // `disabled={!sessionId}` looks vestigial in the cockpit and is not.
  //
  // Spec `execution-defaults` §3.3 asks that model and effort be choosable
  // BEFORE a session's first message, and in the cockpit they already are: the
  // `/session` route loader always redirects to a URL carrying a session id —
  // the most recent cached one, or a fresh UUID — so `sessionId` is non-empty
  // from the first paint (pinned by `session-route-loader.test.ts`, and
  // browser-verified on a cold `/session?dir=…`, where the picker opens and the
  // "Send a message first" tooltip never renders).
  //
  // The guard survives because the EMBED has no router and no loader: Obsidian's
  // shell reads the id from the store, which starts `null` and is set back to
  // `null` on a directory switch. There, `updateSession` has no session to PATCH,
  // and a picker that silently wrote nowhere would be worse than one that says
  // why it is not ready. Closing that gap means minting an id in the embed shell,
  // which is a change to a surface this repo cannot yet verify end to end.
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

  // A way of working (Plan) holding the session leaves this item with nothing to
  // report — the trust dial has no stop selected while Plan runs it (spec
  // `trust-dial`, decision 1, `specs/trust-dial/04-design-decisions.md:13`).
  // Omitted here rather than built-but-relabeled: `selectPromotedItems` skips a
  // key with no node before it ever reaches the promotion rule, so leaving this
  // key absent is what frees its budget slot for `plan` instead of spending it on
  // an empty chip (DOR-1236). The two rank the same severity
  // (`PERMISSION_ELEVATED` / `PLAN_ACTIVE`, both 40) and the stable sort in
  // `applyStatusBudget` breaks ties by registry order, which lists `permission`
  // first — so a node built-but-empty here would still win the contested slot
  // and push the one chip that IS news, `plan`, under the `⋯`.
  if (!input.plan?.active) {
    nodes.permission = (
      <PermissionModeItem
        mode={status.permissionMode}
        onChangeMode={input.onChangeMode}
        disabled={!sessionId}
        runtime={runtimeChip.runtime}
        modelSupportsAutoMode={input.modelSupportsAutoMode}
        compact={compactItems}
        makeDefault={input.makeDefault}
        onOpenChange={input.onPermissionPickerOpenChange}
      />
    );
  }

  if (input.plan) {
    nodes.plan = (
      <PlanModeItem
        descriptor={input.plan.descriptor}
        active={input.plan.active}
        onToggle={input.plan.onToggle}
        disabled={!sessionId}
      />
    );
  }

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

  if (input.liveSubagentCount > 0) {
    nodes.subagents = (
      <SubagentsItem
        count={input.liveSubagentCount}
        running={input.runningSubagents}
        waiting={input.waitingOnSubagents}
      />
    );
  }

  nodes.connection = (
    <ConnectionItem connectionState={input.connectionState} compact={compactItems} />
  );

  return nodes;
}
