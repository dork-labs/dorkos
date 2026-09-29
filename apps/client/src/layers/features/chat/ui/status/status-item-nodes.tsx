import type { ReactNode } from 'react';
import type {
  ConnectionState,
  ContextUsage,
  GitStatusError,
  GitStatusResponse,
  UpdateSessionRequest,
  UsageStatus,
} from '@dorkos/shared/types';
import type { SessionContextUsage } from '@dorkos/shared/session-stream';
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
  accountChipPromotion,
  isUsageAbsorbed,
  ConnectionItem,
  SubagentsItem,
  type ActiveSubagent,
  type ContextCompactAction,
  type StatusBarItemKey,
  type StatusDensity,
  type RuntimeChipState,
  type SessionAccount,
  type UsageSource,
  type MakeDefaultStopLineProps,
} from '@/layers/features/status';
import { AgentIdentityChip } from './AgentIdentityChip';
import { AccountStatusItem } from './AccountStatusItem';

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
  /**
   * Apply a permission-mode change, gated by the auto-mode confirmation. Any
   * id the runtime declares (DOR-811), matching `PermissionModeItem.onChangeMode`
   * and `TrustDial.onChangeMode` — `string` rather than `PermissionMode` so
   * the whole call chain states that honestly instead of narrowing with a
   * cast (DOR-820).
   */
  onChangeMode: (mode: string) => void;
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
  /**
   * Which account the session spends and how it is doing (`useSessionAccount`).
   * The chip renders only while its `visible` gate is open.
   */
  account: SessionAccount;
  /** The percent to display for the context window, or `null` before the first reading. */
  contextPercent: number | null;
  /** The SDK context breakdown, when it has arrived. */
  contextUsage: ContextUsage | null;
  /**
   * The session status's own context reading, which a reopened session has
   * before any turn (with `observedAt`), or `null`.
   */
  contextReading: SessionContextUsage | null;
  /** The inline compact action, or `null` when this runtime cannot compact. */
  compact: ContextCompactAction | null;
  /** Runtime-neutral usage descriptor: the session's account reading, or its own (`useStatusUsage`). */
  usage: UsageStatus | null;
  /**
   * Where {@link usage} came from. An `account` reading is the account's
   * windows, never a cost the runtime measured, so it shows on every runtime.
   */
  usageSource: UsageSource | null;
  /** When {@link usage} was observed, ISO-8601, or `null` when not known. */
  usageObservedAt: string | null;
  /**
   * The moment the line reads freshness from. The same clock that decides
   * whether the budget pays for "· old" (`usageStale`), so the item and the
   * budget never disagree about it near the hour.
   */
  now: Date;
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
   * Every item below the `full` tier renders glyph + value: no effort or Fast
   * badges, bounded labels (spec composer-status-redesign §6.1). The runtime
   * chip's own `· <model>` half stays dropped at every tier, `full` included —
   * the model item already says it, so repeating it costs pixels for nothing
   * (DOR-1971). The narrowest tier goes further and drops the agent's name,
   * keeping the avatar.
   */
  density: StatusDensity;
}

/** A usage with every cost figure removed, for a runtime that cannot track cost. */
function withoutCost(usage: UsageStatus): UsageStatus {
  const { costUsd: _costUsd, costBasis: _costBasis, ...rest } = usage;
  return rest;
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
        account={runtimeChip.account}
        // Always compact here, never `compactItems`: `nodes.model` below draws
        // the model's name unconditionally, at every density, so the runtime
        // chip's own `· <model>` half is redundant at EVERY tier, not only
        // below `full`. Gating it on density instead of hardcoding `true` was
        // the bug (DOR-1971): at the widest tier `compactItems` is `false`, so
        // this chip read "Claude Code · Opus" right next to the model item's
        // own "Opus" — the model name rendered twice in the composer.
        compact
      />
    );
  }

  // The account chip sits beside the runtime it belongs to, and only where
  // accounts are told apart (two or more on a runtime that supports them).
  const accountPromotion = accountChipPromotion(input.account);
  if (accountPromotion !== null) {
    nodes.account = <AccountStatusItem sessionId={sessionId} account={input.account} />;
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

  // A way of working (Plan) holding the session leaves this item with nothing to
  // report — the trust dial has no stop selected while Plan runs it (spec
  // `trust-dial`, decision 1, `specs/trust-dial/04-design-decisions.md:13`).
  // Omitted here rather than built-but-relabeled: `selectPromotedItems` skips a
  // key with no node before it ever reaches the promotion rule, so leaving this
  // key absent is what frees its budget slot for `plan` instead of spending it on
  // an empty chip (DOR-1236).
  //
  // Historically this also broke a SEVERITY tie: the registry used to derive
  // `permission`'s severity from the mode's NAME, so Claude's `plan` id (not
  // literally `'default'`) read as `PERMISSION_ELEVATED`, tying `PLAN_ACTIVE`
  // (both 40) — and the stable sort in `applyStatusBudget` breaks ties by
  // registry order, which lists `permission` first, so a node built-but-empty
  // here would have won the contested slot and pushed `plan` under the `⋯`.
  // `status-bar-registry.ts` now derives severity from the descriptor instead
  // (DOR-820): `plan` is `stop: 'ask'`, the dial's safest position, so it reads
  // QUIET on this item honestly — no tie to break any more. The omission
  // stays anyway, because "planning" is still `plan`'s fact to report, not
  // this item's, whatever its severity happens to resolve to.
  if (!input.plan?.active) {
    nodes.permission = (
      <PermissionModeItem
        mode={status.permissionMode}
        onChangeMode={input.onChangeMode}
        disabled={!sessionId}
        // Nothing has answered what this session runs at yet, so the item says
        // nothing rather than painting the placeholder `status.permissionMode`
        // carries on those frames (DOR-2103).
        pending={!status.permissionModeKnown}
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
        reading={input.contextReading}
      />
    );
  }

  // `supportsCostTracking` gates the session's OWN usage, even its
  // subscription-utilization display: a runtime that declares it cannot track
  // cost must never show a figure it measured. An `account` reading is exempt:
  // it is the account's windows from the shared store, not a turn's cost, and
  // it is how a Codex session shows its weekly window from open (spec
  // `claude-account-ui` §6.8). Any cost the session carried is dropped from it
  // on such a runtime.
  //
  // While the account chip shows, it carries usage itself, so this item is
  // not built at all: a pin bypasses promotion, and must not bring a second
  // usage display back (`isUsageAbsorbed`, the registry's rule too).
  const usage =
    input.usage && input.usageSource === 'account' && !input.supportsCostTracking
      ? withoutCost(input.usage)
      : input.usage;
  if (
    usage &&
    hasRenderableUsage(usage) &&
    (input.supportsCostTracking || input.usageSource === 'account') &&
    !isUsageAbsorbed({ account: accountPromotion })
  ) {
    nodes.usage = (
      <UsageStatusItem usage={usage} observedAt={input.usageObservedAt} now={input.now} />
    );
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
