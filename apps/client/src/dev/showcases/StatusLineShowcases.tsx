/**
 * The composer status line, its width budget, and the Session panel behind the
 * `⋯` (spec composer-status-redesign, DOR-452).
 *
 * What is worth looking at here is *behaviour*, not appearance: which items earn
 * a slot, which one loses it first as the bar narrows, and what the `+N` admits
 * to. So every demo runs the real pipeline —
 * `buildStatusItemNodes` → `selectPromotedItems` → `resolveStatusBudget` →
 * `applyStatusBudget` → `StatusLine` — with a fixed container width standing in
 * for the `ResizeObserver` the app measures with. A hand-drawn row of chips would
 * look right and prove nothing.
 *
 * @module dev/showcases/StatusLineShowcases
 */
import { useState } from 'react';
import type { GitStatusResponse, SubagentInfo, UsageStatus } from '@dorkos/shared/types';
import type { SessionStatusData } from '@/layers/entities/session';
import {
  StatusLine,
  SessionPopover,
  applyStatusBudget,
  gitPromotionState,
  selectPromotedItems,
  type SessionDiagnostics,
  type StatusPromotionContext,
} from '@/layers/features/status';
// `resolveStatusBudget` is not in the slice's barrel — in the app it is reached
// only through `useStatusBudget`, which needs a live element to measure. The
// showcase supplies the width itself, so it calls the same pure function directly
// rather than reimplement the tier table and let it drift.
import { resolveStatusBudget } from '@/layers/features/status/model/status-budget';
import {
  buildStatusItemNodes,
  type StatusItemNodesInput,
} from '@/layers/features/chat/ui/status/status-item-nodes';
import { AgentIdentityChip } from '@/layers/features/chat/ui/status/AgentIdentityChip';
import type { RuntimeChipState } from '@/layers/features/chat/model/status/use-runtime-chip';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

const AGENT = {
  name: 'dorkbot',
  color: '#6366f1',
  emoji: '🤖',
  path: '/Users/dev/code/dorkos',
} as const;

const CWD = '/Users/dev/code/dorkos';

const CLEAN_GIT: GitStatusResponse = {
  branch: 'main',
  ahead: 0,
  behind: 0,
  modified: 0,
  staged: 0,
  untracked: 0,
  conflicted: 0,
  clean: true,
  detached: false,
  tracking: 'origin/main',
};

const DIRTY_GIT: GitStatusResponse = {
  branch: 'dor-452-status-line',
  ahead: 2,
  behind: 0,
  modified: 3,
  staged: 1,
  untracked: 2,
  conflicted: 0,
  clean: false,
  detached: false,
  tracking: 'origin/dor-452-status-line',
};

const DEFAULT_RUNTIME_CHIP: RuntimeChipState = {
  runtime: 'claude-code',
  model: 'claude-opus-4-6',
  canSelect: false,
  onChangeRuntime: () => {},
};

const CODEX_RUNTIME_CHIP: RuntimeChipState = {
  runtime: 'codex',
  model: 'gpt-5.3-codex',
  canSelect: false,
  onChangeRuntime: () => {},
};

const USAGE_OK: UsageStatus = {
  kind: 'subscription',
  utilization: 0.22,
  windowLabel: '5-hour window',
  costUsd: 0.41,
  state: 'ok',
};

const USAGE_WARNING: UsageStatus = {
  kind: 'subscription',
  utilization: 0.87,
  windowLabel: '5-hour window',
  costUsd: 6.12,
  state: 'warning',
};

const SUBAGENTS: SubagentInfo[] = [
  { name: 'Explore', description: 'Read-only search agent' },
  { name: 'code-reviewer', description: 'Reviews completed work' },
];

const HEALTHY_STATUS: SessionStatusData = {
  permissionMode: 'default',
  model: 'claude-opus-4-6',
  effort: null,
  fastMode: false,
  costUsd: 0.41,
  contextPercent: 31,
  isStreaming: false,
  cwd: CWD,
};

const DEGRADED_STATUS: SessionStatusData = {
  ...HEALTHY_STATUS,
  permissionMode: 'bypassPermissions',
  model: 'gpt-5.3-codex',
  costUsd: 6.12,
  contextPercent: 88,
};

/** One session's worth of state, minus the density the width decides. */
interface StatusScenario {
  /** What this state is, in the words a reviewer would use. */
  label: string;
  /** Live state the promotion rules read. */
  ctx: StatusPromotionContext;
  /** Everything the items need, minus `density`. */
  input: Omit<StatusItemNodesInput, 'density'>;
}

/**
 * A resting session: clean tree on the default branch, a third of the context
 * window used, connected, default permissions, the default runtime. Nothing here
 * is news, so almost nothing shows.
 */
const HEALTHY: StatusScenario = {
  label: 'Healthy — nothing to report',
  ctx: {
    cwd: CWD,
    git: gitPromotionState(CLEAN_GIT.branch, CLEAN_GIT.clean, CLEAN_GIT.detached),
    contextPercent: 31,
    connectionState: 'connected',
    permissionMode: 'default',
    runtime: { isDefault: true, canSelect: false },
    usage: USAGE_OK,
    subagentCount: 0,
  },
  input: {
    sessionId: 'showcase-healthy',
    agent: { name: AGENT.name, color: AGENT.color, emoji: AGENT.emoji, path: AGENT.path },
    status: HEALTHY_STATUS,
    onUpdateSession: () => {},
    onChangeMode: () => {},
    modelSupportsAutoMode: true,
    gitStatus: CLEAN_GIT,
    workspace: null,
    runtimeChip: DEFAULT_RUNTIME_CHIP,
    contextPercent: 31,
    contextUsage: null,
    compact: null,
    usage: USAGE_OK,
    supportsCostTracking: true,
    subagents: [],
    connectionState: 'connected',
  },
};

/**
 * Everything going wrong at once — the state the width budget exists for. The
 * live link is down, the context window is nearly full, permissions are bypassed,
 * the runtime is not the default, the tree is dirty on a feature branch, usage is
 * near its ceiling, and two subagents are available.
 */
const DEGRADED: StatusScenario = {
  label: 'Degraded — connection lost, context critical, bypass permissions, non-default runtime',
  ctx: {
    cwd: CWD,
    git: gitPromotionState(DIRTY_GIT.branch, DIRTY_GIT.clean, DIRTY_GIT.detached),
    contextPercent: 88,
    connectionState: 'disconnected',
    permissionMode: 'bypassPermissions',
    runtime: { isDefault: false, canSelect: false },
    usage: USAGE_WARNING,
    subagentCount: SUBAGENTS.length,
  },
  input: {
    sessionId: 'showcase-degraded',
    agent: { name: AGENT.name, color: AGENT.color, emoji: AGENT.emoji, path: AGENT.path },
    status: DEGRADED_STATUS,
    onUpdateSession: () => {},
    onChangeMode: () => {},
    modelSupportsAutoMode: false,
    gitStatus: DIRTY_GIT,
    workspace: null,
    runtimeChip: CODEX_RUNTIME_CHIP,
    contextPercent: 88,
    contextUsage: null,
    compact: null,
    usage: USAGE_WARNING,
    supportsCostTracking: true,
    subagents: SUBAGENTS,
    connectionState: 'disconnected',
  },
};

/**
 * One bar width per density tier, widest first — the tier floors from
 * `status-budget` (640 / 440 / 340) plus one width below the last of them.
 *
 * Capped at 640 on purpose. These boxes are a fixed pixel width, and the
 * playground's content column is ~680px on a 1280px laptop; a wider row would
 * scroll its own `⋯` out of sight, which is the one thing this demo must never
 * hide. The `full` tier's budget keeps growing above 640 — see `BudgetTable`,
 * which reports that from the same function without drawing a 1440px bar.
 */
const TIER_WIDTHS = [640, 520, 375, 320] as const;

/** Widths sampled by {@link BudgetTable} — two per tier, from phone to wide desktop. */
const SAMPLED_WIDTHS = [320, 375, 440, 520, 640, 764, 890, 1024, 1440] as const;

/**
 * What each width affords, straight from `resolveStatusBudget`.
 *
 * The spec writes the widest tier's budget as "4+" because it grows with the
 * width above 640px, one slot per `FULL_SLOT_COST_PX`. That growth is the part a
 * rendered row cannot show inside a playground column, so it is reported as
 * numbers instead of faked with a scaled-down bar.
 */
function BudgetTable() {
  return (
    <table className="font-mono text-xs">
      <thead className="text-muted-foreground text-left">
        <tr>
          <th className="pr-6 font-medium">bar width</th>
          <th className="pr-6 font-medium">density</th>
          <th className="pr-6 font-medium">right budget</th>
          <th className="font-medium">left cluster drops</th>
        </tr>
      </thead>
      <tbody>
        {SAMPLED_WIDTHS.map((width) => {
          const budget = resolveStatusBudget(width);
          return (
            <tr key={width}>
              <td className="pr-6 tabular-nums">{width}px</td>
              <td className="pr-6">{budget.density}</td>
              <td className="pr-6 tabular-nums">{budget.rightBudget}</td>
              <td className="text-muted-foreground">
                {budget.dropped.length > 0 ? budget.dropped.join(', ') : '—'}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * One status line at one width, run through the real promotion + budget pipeline.
 *
 * @param props - The session state to promote and the bar width to fit it into.
 */
function BudgetedLine({ scenario, width }: { scenario: StatusScenario; width: number }) {
  const budget = resolveStatusBudget(width);
  // Mirrors `ChatStatusSection`: the inline Compact action is the first thing the
  // line gives up, so it is offered only at the widest tier. Below that the
  // Session panel carries it as a full-width button instead.
  const inlineCompact =
    budget.density === 'full' && scenario.ctx.contextPercent !== null
      ? { pending: false, onCompact: () => {} }
      : null;
  const nodes = buildStatusItemNodes({
    ...scenario.input,
    compact: inlineCompact,
    density: budget.density,
  });
  const { items, overflow } = applyStatusBudget(
    selectPromotedItems({ ctx: scenario.ctx, pins: [], nodes }),
    budget
  );

  return (
    <div className="space-y-1.5">
      <p className="text-muted-foreground font-mono text-[10px]">
        {width}px · density <span className="text-foreground">{budget.density}</span> · right budget{' '}
        <span className="text-foreground">{budget.rightBudget}</span> · showing{' '}
        <span className="text-foreground">{items.length}</span> ·{' '}
        {overflow > 0 ? (
          <span className="text-foreground">+{overflow} in the panel</span>
        ) : (
          'everything fits'
        )}
        {budget.dropped.length > 0 && ` · left cluster drops ${budget.dropped.join(', ')}`}
      </p>
      {/* A fixed width, because the budget is a function of the bar's measured
          width — a fluid box would make every row report the same tier. */}
      <div className="border-border/60 bg-background rounded-md border" style={{ width }}>
        <StatusLine items={items} trailing={<span className="px-1 opacity-50">⋯</span>} />
      </div>
    </div>
  );
}

const DIAGNOSTICS: SessionDiagnostics = {
  sessionId: '9f3c1a7e-4b2d-4f10-9c85-2a6e1b0d7f44',
  cwd: CWD,
  gitBranch: DIRTY_GIT.branch,
  gitDirty: true,
  runtime: 'codex',
  model: 'gpt-5.3-codex',
  effort: 'high',
  permissionMode: 'bypassPermissions',
  contextPercent: 88,
  cache: { readTokens: 141_200, creationTokens: 18_400, contextTokens: 176_000 },
  usage: USAGE_WARNING,
  connectionState: 'disconnected',
  lastEventSeq: 2471,
  queueDepth: 2,
  clientVersion: '0.57.0',
};

/**
 * Status line and Session panel showcases: `StatusLine` across density tiers,
 * the promoted set at rest versus under stress, `SessionPopover`, and the
 * `AgentIdentityChip` anchor.
 */
export function StatusLineShowcases() {
  const [sessionOpen, setSessionOpen] = useState(false);
  const [countedOpen, setCountedOpen] = useState(false);
  const [sound, setSound] = useState(true);
  const [refresh, setRefresh] = useState(false);

  const controls = {
    sound,
    onToggleSound: () => setSound((s) => !s),
    refresh,
    onToggleRefresh: () => setRefresh((r) => !r),
  };

  return (
    <>
      <PlaygroundSection
        title="StatusLine — density tiers"
        description="One degraded session at four bar widths, one per tier. The line never scrolls and never wraps, so each width fills the right cluster by urgency until its budget runs out and reports the rest as +N on the ⋯. Read down the column: the item that goes first is the least urgent one, and nothing is ever lost."
      >
        <ShowcaseLabel>Degraded session, narrowing bar</ShowcaseLabel>
        <ShowcaseDemo className="overflow-x-auto">
          <div className="space-y-5">
            {TIER_WIDTHS.map((width) => (
              <BudgetedLine key={width} scenario={DEGRADED} width={width} />
            ))}
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>What every width affords</ShowcaseLabel>
        <ShowcaseDemo className="overflow-x-auto">
          <BudgetTable />
        </ShowcaseDemo>

        <p className="text-muted-foreground text-xs">
          640px is the widest row drawn here, not the widest the tier goes: these boxes are a fixed
          pixel width and the playground column is narrower than a real desktop bar, so anything
          wider would scroll its own ⋯ out of view. The table above carries the rest, read from the
          same <code>resolveStatusBudget</code> the app measures with.
        </p>
        <p className="text-muted-foreground text-xs">
          The 640px row is the tier at its floor holding everything that can promote, so it is the
          most compressed the line ever gets: both clusters shrink, values truncate, and adjacent
          items close to touching. The row still satisfies the invariant the e2e spec defends
          (content never extends past the row, so nothing is clipped out of reach) — this is what
          the budget looks like when its prediction is exactly spent.
        </p>
      </PlaygroundSection>

      <PlaygroundSection
        title="StatusLine — promoted set"
        description="The same component at the same width, two session states. Quiet by default means a healthy session says almost nothing; every promotion rule fires at once under stress, which is exactly when severity ordering has to be right."
      >
        <ShowcaseLabel>At rest — clean tree, connected, default permissions</ShowcaseLabel>
        <ShowcaseDemo className="overflow-x-auto">
          <BudgetedLine scenario={HEALTHY} width={640} />
        </ShowcaseDemo>

        <ShowcaseLabel>Under stress — same width, everything wrong</ShowcaseLabel>
        <ShowcaseDemo className="overflow-x-auto">
          <BudgetedLine scenario={DEGRADED} width={640} />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="SessionPopover"
        description="The reveal behind the ⋯ — every row with its live value, a pin on the rows you may keep in the line, and Copy diagnostics. Click a ⋯ below to open it (⌘. does it in a real session)."
      >
        <ShowcaseLabel>Everything fits — plain ⋯</ShowcaseLabel>
        <ShowcaseDemo>
          <SessionPopover
            open={sessionOpen}
            onOpenChange={setSessionOpen}
            diagnostics={DIAGNOSTICS}
            controls={controls}
            promotionContext={DEGRADED.ctx}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>
          Items dropped — +N, with the compact action promoted to a button
        </ShowcaseLabel>
        <ShowcaseDemo>
          <SessionPopover
            open={countedOpen}
            onOpenChange={setCountedOpen}
            diagnostics={DIAGNOSTICS}
            controls={controls}
            promotionContext={DEGRADED.ctx}
            overflowCount={4}
            urgentAction={{ label: 'Compact conversation — 88% full', onAction: () => {} }}
          />
        </ShowcaseDemo>

        <p className="text-muted-foreground text-xs">
          Two things only a real session can show. <strong>Pins</strong> live in server config (
          <code>ui.statusBar.pins</code>) so they sync across surfaces and an agent can set them —
          the playground has no server, so every row reads unpinned and clicking a pin does not
          stick. <strong>Row order</strong> is registry order here; on a phone the panel sorts
          Session rows most-urgent-first, which needs a real viewport, not a narrowed demo box.
        </p>
      </PlaygroundSection>

      <PlaygroundSection
        title="AgentIdentityChip"
        description="Who you are talking to — the identity anchor of the left cluster. Click opens the agent profile; right-click (long-press on touch) offers switch agent, profile, and new session."
      >
        <ShowcaseLabel>With a name — every tier down to 340px</ShowcaseLabel>
        <ShowcaseDemo>
          <AgentIdentityChip
            agentName={AGENT.name}
            agentColor={AGENT.color}
            agentEmoji={AGENT.emoji}
            agentPath={AGENT.path}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>
          Avatar only — the narrowest tier, name kept for screen readers
        </ShowcaseLabel>
        <ShowcaseDemo>
          <AgentIdentityChip
            agentName={AGENT.name}
            agentColor={AGENT.color}
            agentEmoji={AGENT.emoji}
            agentPath={AGENT.path}
            nameHidden
          />
        </ShowcaseDemo>

        <ShowcaseLabel>No path — plain identity, no context menu and no click target</ShowcaseLabel>
        <ShowcaseDemo>
          <AgentIdentityChip
            agentName={AGENT.name}
            agentColor={AGENT.color}
            agentEmoji={AGENT.emoji}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>A long name truncates rather than pushing the line wider</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="border-border/60 w-40 rounded-md border p-1">
            <AgentIdentityChip
              agentName="release-engineering-assistant"
              agentColor="#f59e0b"
              agentEmoji="🚀"
              agentPath={AGENT.path}
            />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}
