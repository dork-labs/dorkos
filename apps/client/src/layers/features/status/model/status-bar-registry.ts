/**
 * The single source of truth for the composer status line: which items exist,
 * which cluster each lives in, when each one earns a slot, and how urgent it is
 * when slots are contested.
 *
 * The line is **quiet by default**. An item appears only when its `promote` rule
 * fires — when it is actionable or anomalous — or when a person pinned it. A
 * number that always reads 34% is wallpaper, so the 91% that matters would not
 * register either.
 *
 * @module features/status/model/status-bar-registry
 */
import type { LucideIcon } from 'lucide-react';
import {
  FolderOpen,
  GitBranch,
  Bot,
  Cpu,
  BarChart3,
  Zap,
  Gauge,
  Shield,
  ClipboardList,
  Wifi,
  Users,
  UserRound,
} from 'lucide-react';
import { useCallback } from 'react';
import type { ConnectionState, UsageStatus } from '@dorkos/shared/types';
import type { StatusBarPin } from '@dorkos/shared/config-schema';
import { STATUS_BAR_PIN_KEYS } from '@dorkos/shared/config-schema';
import { CONTEXT_ACTION_PERCENT, CONTEXT_PROMOTE_PERCENT } from '@/layers/entities/session';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import { isBypassPermissionMode, isBypassSemantics } from '@/layers/shared/lib';
import { useStatusBarPrefs, useUpdateStatusBarPrefs } from '@/layers/entities/config';

/** Union of every status line item key. */
export type StatusBarItemKey =
  | 'agent'
  | 'cwd'
  | 'git'
  | 'runtime'
  | 'model'
  | 'cache'
  | 'context'
  | 'usage'
  | 'permission'
  | 'plan'
  | 'subagents'
  | 'connection';

/**
 * Which half of the strict two-cluster layout an item belongs to. `left` is who
 * and where (identity, directory, branch); `right` is state and numbers. One
 * flexible gap separates them and no separator ever touches it — a middot
 * floating in whitespace is what reads as "centered".
 */
export type StatusBarCluster = 'left' | 'right';

/**
 * Section an item occupies in the Session popover. `null` — no row of its own.
 *
 * There was a third section, `controls`, and it is gone with its last member
 * (DOR-1758): both switches that lived there — `sound`, then `polling` — turned
 * out to be machine-wide preferences wearing a per-session badge. The one switch
 * still in the panel, `plan`, is genuinely this session's and sits in `session`
 * where it can also be pinned into the line.
 */
export type StatusBarItemGroup = 'session' | 'diagnostics';

/** Everything the promotion rules read. Assembled once per render by the status bar. */
export interface StatusPromotionContext {
  /** Resolved working directory, or `null` when unknown. */
  cwd: string | null;
  /** Working-tree shape for {@link cwd}, or `null` while git status is unresolved. */
  git: GitPromotionState | null;
  /** The percent the context item would display (0-100), or `null` before the first reading. */
  contextPercent: number | null;
  /** Live-sync connection state of this session's durable event stream. */
  connectionState: ConnectionState;
  /**
   * The session's permission mode — any id the runtime declares (DOR-811),
   * wider than the shared `PermissionMode` enum's known names (test-mode's
   * ids sit outside it on purpose). `string`, matching `SessionStatusData`,
   * so nothing here narrows with a cast (DOR-820).
   */
  permissionMode: string;
  /**
   * That mode as its runtime declared it, or `null` while the capability map is
   * still arriving. What ranks the item is what the mode DOES, not what it is
   * called — `null` falls back to the mode's name, which agrees for every
   * runtime shipped today.
   */
  permissionDescriptor: PermissionModeDescriptor | null;
  /**
   * The way of working this runtime offers and whether the session is in it, or
   * `null` when the runtime offers none (most of them) — the same rule every
   * other nullable field here follows: nothing to say, no slot.
   */
  plan: PlanPromotionState | null;
  /** Runtime identity, or `null` while it is still resolving. */
  runtime: RuntimePromotionState | null;
  /** Runtime-neutral usage descriptor, or `null` when the session has none. */
  usage: UsageStatus | null;
  /**
   * How many subagents this session has **in flight right now** — never how many
   * it could call.
   *
   * The distinction is the whole item. `getSubagents()` returns the runtime's
   * catalogue of agent types, which for Claude Code is a fixed list that is never
   * empty, so a rule reading it promoted the item on every session forever — the
   * definition of the wallpaper this line exists to remove (DOR-462). Running
   * subagents come from the turn's `subagent_update` events instead, so the item
   * appears while work is delegated and leaves when it finishes.
   *
   * Deliberately not called `runningSubagentCount`: {@link SessionDiagnostics} has
   * a field by that name which the SERVER projects, and the two can legitimately
   * disagree. This one is the client's own fold of the turn it is watching.
   */
  subagentsInFlight: number;
}

/** The two things about a working tree that can make it news. */
export interface GitPromotionState {
  /** Whether the working tree has uncommitted changes. */
  dirty: boolean;
  /** Whether HEAD is on a conventional default branch (`main`/`master`, not detached). */
  onDefaultBranch: boolean;
}

/** What the composer's Plan switch needs in order to rank itself. */
interface PlanPromotionState {
  /** Whether the session is planning right now. */
  active: boolean;
}

/** The two things about a runtime that can make it news. */
interface RuntimePromotionState {
  /** Whether this is the server's default runtime. */
  isDefault: boolean;
  /** Whether the runtime can still be chosen (pre-first-message). */
  canSelect: boolean;
}

/**
 * Branch names treated as "the default" when deciding whether the git item is
 * news. The git status endpoint reports no default-branch name, and asking the
 * remote for one would turn a status chip into a network dependency — these two
 * cover effectively every repository DorkOS opens.
 */
const DEFAULT_BRANCH_NAMES = new Set(['main', 'master']);

/**
 * Derive the git promotion inputs from a branch name and cleanliness.
 *
 * @param branch - Current branch name, or the HEAD SHA when detached.
 * @param clean - Whether the working tree has no changes.
 * @param detached - Whether HEAD is detached (never a default branch).
 */
export function gitPromotionState(
  branch: string,
  clean: boolean,
  detached: boolean
): GitPromotionState {
  return {
    dirty: !clean,
    onDefaultBranch: !detached && DEFAULT_BRANCH_NAMES.has(branch),
  };
}

/**
 * Budget ranks, highest first. Part of the line's honesty: when the bar cannot
 * fit everything that promoted, the items that survive are the ones most likely
 * to be a real problem. `severity` resolves against live state, not just the
 * item, because "context at 91%" and "context at 72%" are not the same news —
 * and an item that is only in the line because someone pinned it ranks
 * {@link SEVERITY.QUIET}, since a pin says "show me", not "shout at me".
 */
const SEVERITY = {
  /** The identity anchor — never contested out of the left cluster. */
  AGENT_ANCHOR: 1000,
  CONNECTION_LOST: 100,
  CONTEXT_CRITICAL: 90,
  USAGE_EXHAUSTED: 80,
  PERMISSION_BYPASS: 70,
  CONTEXT_WARNING: 50,
  USAGE_WARNING: 50,
  PERMISSION_ELEVATED: 40,
  /**
   * Planning is on. Ranked with an elevated permission mode because it is the
   * same kind of fact — how much this agent will do on its own — and a person
   * who has forgotten it is on wonders why nothing is happening.
   */
  PLAN_ACTIVE: 40,
  /**
   * Work is being delegated — news, but never a problem, so it sits below every
   * warning and above the configuration facts.
   *
   * It shipped at 60, above both warnings, which meant a session that was running
   * a subagent AND approaching its usage limit spent a scarce slot on the
   * subagent and put the limit under the `⋯` (DOR-462). Nothing about a healthy
   * delegation outranks a number heading for a ceiling.
   */
  SUBAGENTS_RUNNING: 35,
  RUNTIME_NON_DEFAULT: 30,
  GIT_DIRTY: 20,
  MODEL: 10,
  CWD: 5,
  /** Promoted, but nothing about it is urgent. */
  QUIET: 0,
} as const;

export interface StatusBarItemConfig {
  /** Stable identity — used for pins, React keys, and the popover rows. */
  key: StatusBarItemKey;
  /** Human-readable label shown in the popover. */
  label: string;
  /** One line of plain-language explanation shown under the label. */
  description: string;
  /** Which cluster of the two-cluster line this item renders in. */
  cluster: StatusBarCluster;
  /** Popover section, or `null` when the item has no configurable row. */
  group: StatusBarItemGroup | null;
  /** Lucide icon for the popover row. */
  icon: LucideIcon;
  /**
   * The quiet-by-default rule: `true` when this item's current state earns it a
   * slot in the line. Never consulted for {@link neverInLine} items.
   */
  promote: (ctx: StatusPromotionContext) => boolean;
  /** Budget rank for the item's current state — higher survives a contested slot. */
  severity: (ctx: StatusPromotionContext) => number;
  /**
   * Set when the item can never enter the line at all, whatever its state and
   * however hard someone pins it. `cache` is pure diagnostics: a number that
   * only changes when the runtime says so, and never news.
   */
  neverInLine?: true;
  /**
   * Set when the item's value is a **number whose magnitude is the message** —
   * a percentage, an amount of money. It renders whole or not at all: the row may
   * not squeeze it, and it never abbreviates.
   *
   * The line's rule is that a width the budget got wrong degrades into an
   * ellipsis. That rule is right for a name and wrong for a number. `Bypass
   * permi…` is the same fact in fewer letters; `8…` is a *different number* —
   * an 88%-full context window reading as 8% is wrong by 10×, which is worse
   * than the item not being there at all (DOR-461 review). So a rigid item keeps
   * its pixels and the deficit lands on the items that can honestly give some
   * up. When even that is not enough, the honest outcome is for the width budget
   * to drop the item to the `⋯` — where the number is still exact — and the
   * browser guard fails loudly if it does not.
   *
   * Rigidity is expensive, so it is not for every number — but an item with no
   * compressible part has no other honest option. `subagents` is glyph plus
   * digits: there is no label to abbreviate, so a row that squeezes it can only
   * take digits away, and `12` losing one reads as `1`, confidently and wrongly.
   *
   * It went both ways before this settled. Rigid at its old `N running` width
   * (77px) it was the quietest item on the row holding pixels that `connection` —
   * severity 100 — then had to give up, and `connection` measured 24px. The
   * inversion was the width, not the rigidity: as a bare count the item is ~36px,
   * which is what its shrink floor already reserved, so protecting it costs the
   * row nothing it was not already spending. The word moved to the tooltip and
   * the accessible name, where a narrow row cannot cut it.
   *
   * The test in `status-bar-registry.test` is the list, and adding to it is a
   * claim that the row can afford one more thing that will not move.
   */
  rigid?: true;
}

/** Human-readable labels for each popover group, used as section headers. */
const GROUP_LABELS: Record<StatusBarItemGroup, string> = {
  session: 'Session',
  diagnostics: 'Diagnostics',
};

/**
 * Whether a permission mode sits off the dial's safest stop ('ask', which
 * always asks first) — the one fact both the Permissions item's `promote`
 * and `severity` need to agree on (DOR-820). Reads the descriptor when one
 * has arrived, the same way the bypass check beside it prefers a descriptor
 * over a name: PATCHing to a mode whose NAME merely differs from 'default'
 * says nothing about what it DOES — test-mode's `always-deny` is its
 * SAFEST mode and is not named 'default'. Falls back to the name only
 * before the capability map lands.
 *
 * A single function rather than one check per caller on purpose: `promote`
 * and `severity` disagreeing (one elevated, one not) is exactly the
 * register-drift bug this ticket closed, and a shared predicate is what
 * keeps a future edit from reintroducing it in only one of the two places.
 */
function isElevatedPermissionMode(ctx: StatusPromotionContext): boolean {
  return ctx.permissionDescriptor
    ? ctx.permissionDescriptor.stop !== 'ask'
    : ctx.permissionMode !== 'default';
}

/**
 * Every status line item, in render order within its cluster.
 *
 * Promotion rules, per spec composer-status-redesign §4.1: `agent`, `model`, and
 * `cwd` always show (who you are talking to, what answers you get, what it can
 * touch); everything else stays silent until it has something to say.
 */
export const STATUS_BAR_REGISTRY: readonly StatusBarItemConfig[] = [
  {
    key: 'agent',
    label: 'Agent',
    description: 'Who you are talking to',
    cluster: 'left',
    group: null,
    icon: UserRound,
    promote: () => true,
    severity: () => SEVERITY.AGENT_ANCHOR,
  },
  {
    key: 'cwd',
    label: 'Directory',
    description: 'The folder this session can touch',
    cluster: 'left',
    group: 'session',
    icon: FolderOpen,
    promote: (ctx) => ctx.cwd !== null,
    severity: () => SEVERITY.CWD,
  },
  {
    key: 'git',
    label: 'Git',
    description: 'Branch and uncommitted changes',
    cluster: 'left',
    group: 'session',
    icon: GitBranch,
    promote: (ctx) => ctx.git !== null && (ctx.git.dirty || !ctx.git.onDefaultBranch),
    severity: (ctx) => (ctx.git?.dirty ? SEVERITY.GIT_DIRTY : SEVERITY.QUIET),
  },
  {
    key: 'runtime',
    label: 'Runtime',
    description: 'Which runtime runs this session',
    cluster: 'right',
    group: 'session',
    icon: Cpu,
    promote: (ctx) => ctx.runtime !== null && (!ctx.runtime.isDefault || ctx.runtime.canSelect),
    severity: (ctx) =>
      ctx.runtime && !ctx.runtime.isDefault ? SEVERITY.RUNTIME_NON_DEFAULT : SEVERITY.QUIET,
  },
  {
    key: 'model',
    label: 'Model',
    description: 'The model answering you',
    cluster: 'right',
    group: 'session',
    icon: Bot,
    promote: () => true,
    severity: () => SEVERITY.MODEL,
  },
  {
    key: 'cache',
    label: 'Cache',
    description: 'How much of the prompt came from cache',
    cluster: 'right',
    group: 'session',
    icon: Zap,
    promote: () => false,
    severity: () => SEVERITY.QUIET,
    neverInLine: true,
  },
  {
    key: 'context',
    label: 'Context',
    description: 'How full the conversation window is',
    cluster: 'right',
    group: 'session',
    icon: BarChart3,
    rigid: true,
    promote: (ctx) => ctx.contextPercent !== null && ctx.contextPercent >= CONTEXT_PROMOTE_PERCENT,
    severity: (ctx) => {
      if (ctx.contextPercent === null) return SEVERITY.QUIET;
      if (ctx.contextPercent >= CONTEXT_ACTION_PERCENT) return SEVERITY.CONTEXT_CRITICAL;
      if (ctx.contextPercent >= CONTEXT_PROMOTE_PERCENT) return SEVERITY.CONTEXT_WARNING;
      return SEVERITY.QUIET;
    },
  },
  {
    key: 'usage',
    label: 'Usage & cost',
    description: 'Subscription limits or what this session has cost',
    cluster: 'right',
    group: 'session',
    icon: Gauge,
    rigid: true,
    promote: (ctx) => ctx.usage?.state === 'warning' || ctx.usage?.state === 'exhausted',
    severity: (ctx) => {
      if (ctx.usage?.state === 'exhausted') return SEVERITY.USAGE_EXHAUSTED;
      if (ctx.usage?.state === 'warning') return SEVERITY.USAGE_WARNING;
      return SEVERITY.QUIET;
    },
  },
  {
    key: 'permission',
    label: 'Permissions',
    description: 'How much the agent may do before it checks with you',
    cluster: 'right',
    group: 'session',
    icon: Shield,
    // Both PROMOTE (is this worth a slot at all) and SEVERITY (how urgent a
    // slot) read the same fact, `isElevatedPermissionMode` — they used to
    // agree by accident (both switched on the mode's name) and a fix to only
    // one would have reintroduced the disagreement DOR-820 exists to end:
    // test-mode's always-deny, its SAFEST mode, would have kept being
    // PROMOTED even after its severity read QUIET.
    //
    // Claude's `plan` mode is `stop: 'ask'` — the dial's safest position,
    // read-only by its own descriptor — so this now reads it as QUIET,
    // same as an ordinary default session. That is intended, not a
    // regression: `plan` is not a risk to flag on THIS item. The separate
    // `plan` item above (well, below in file order, but the item that owns
    // `ctx.plan`) is what tells a person planning is on, at its own
    // `PLAN_ACTIVE` severity — and `status-item-nodes.tsx` omits this item's
    // own rendered node entirely while a way of working holds the session,
    // so the two never compete for one budget slot. Pinned in
    // `status-bar-registry.test.ts` ("plan mode reads QUIET here, on
    // purpose").
    promote: (ctx) => isElevatedPermissionMode(ctx),
    severity: (ctx) => {
      const bypassed = ctx.permissionDescriptor
        ? isBypassSemantics(ctx.permissionDescriptor)
        : isBypassPermissionMode(ctx.permissionMode);
      if (bypassed) return SEVERITY.PERMISSION_BYPASS;
      return isElevatedPermissionMode(ctx) ? SEVERITY.PERMISSION_ELEVATED : SEVERITY.QUIET;
    },
  },
  {
    key: 'plan',
    label: 'Plan',
    description: 'Work out a plan first, and change nothing until you approve it',
    cluster: 'right',
    // A Session row, and pinnable, because the line's width budget can drop this
    // item on a narrow bar (a phone, the Obsidian panel) — and an item you can
    // only reach in the line is an item a narrow bar can take away. The row
    // carries the same switch, so planning stays reachable at every width.
    group: 'session',
    icon: ClipboardList,
    // Offered whenever the runtime has one, on or off — a switch nobody can find
    // is not a switch. Runtimes that declare no way of working render nothing at
    // all, so this costs a slot on Claude sessions only.
    promote: (ctx) => ctx.plan !== null,
    severity: (ctx) => (ctx.plan?.active ? SEVERITY.PLAN_ACTIVE : SEVERITY.QUIET),
  },
  {
    key: 'subagents',
    label: 'Subagents',
    description: 'Subagents working on this turn',
    cluster: 'right',
    group: 'diagnostics',
    icon: Users,
    rigid: true,
    promote: (ctx) => ctx.subagentsInFlight > 0,
    severity: (ctx) => (ctx.subagentsInFlight > 0 ? SEVERITY.SUBAGENTS_RUNNING : SEVERITY.QUIET),
  },
  {
    key: 'connection',
    label: 'Live updates',
    description: 'The live link that delivers messages',
    cluster: 'right',
    group: 'diagnostics',
    icon: Wifi,
    promote: (ctx) => ctx.connectionState !== 'connected',
    severity: (ctx) =>
      ctx.connectionState === 'connected' ? SEVERITY.QUIET : SEVERITY.CONNECTION_LOST,
  },
  // `sound` used to live here as a switch. It is gone (DOR-1385): it read as a
  // per-session control and was not one — it flipped a preference for every
  // session on the machine — and there are three sounds now, of which the
  // every-turn chime is the least important and the only one it could reach.
  // They are set together in Settings → Notifications, which is also where the
  // browser-notification and escalation settings live.
  //
  // `polling` ("Watch for agents you started somewhere else") is gone for the same reason
  // (DOR-1758): it read the global `enableMessagePolling` store field, so a
  // person flipping it inside one session's panel changed every window on the
  // machine. Settings → Preferences is its one home now.
] as const;

/** Look up one registry item by key. */
export function getStatusBarItem(key: StatusBarItemKey): StatusBarItemConfig | undefined {
  return STATUS_BAR_REGISTRY.find((item) => item.key === key);
}

/**
 * Whether a person may pin this item into the line.
 *
 * Only Session rows are pinnable. Diagnostics rows are system-managed — that is
 * the invariant that stops pins from quietly
 * becoming ten visibility toggles again. And nothing marked
 * {@link StatusBarItemConfig.neverInLine} is pinnable, because a pin overrides a
 * promotion rule, not a categorical exclusion.
 */
export function isPinnable(item: StatusBarItemConfig): boolean {
  return item.group === 'session' && item.neverInLine !== true;
}

/**
 * Bridge to the server-persisted pin list (`ui.statusBar.pins`, DOR-431 →
 * DOR-452): the pinned keys plus the two actions that change them.
 *
 * Pins are config, not `localStorage`, so the same items follow you between the
 * desktop app, the browser, and Obsidian, and an agent can set them via
 * `config_patch`. Both actions write the whole list — the config schema treats
 * `pins` as one array and a PATCH replaces arrays wholesale.
 *
 * A pin whose key is no longer pinnable is ignored downstream rather than
 * rejected, so removing an item from the registry cannot strand the line.
 */
export function useStatusBarPins(): {
  pins: readonly StatusBarPin[];
  toggle: (key: StatusBarItemKey) => void;
  reset: () => void;
} {
  const { pins } = useStatusBarPrefs();
  const { setPins } = useUpdateStatusBarPrefs();

  const toggle = useCallback(
    (key: StatusBarItemKey) => {
      // Only pinnable keys can enter the list: the config enum would reject
      // anything else, and the schema is the boundary worth trusting.
      const pin = STATUS_BAR_PIN_KEYS.find((candidate) => candidate === key);
      if (!pin) return;
      setPins(pins.includes(pin) ? pins.filter((k) => k !== pin) : [...pins, pin]);
    },
    [pins, setPins]
  );

  const reset = useCallback(() => setPins([]), [setPins]);

  return { pins, toggle, reset };
}

/** Registry items for one popover group, in registry order. */
export function getGroupedRegistryItems(): {
  group: StatusBarItemGroup;
  label: string;
  items: StatusBarItemConfig[];
}[] {
  const groups: StatusBarItemGroup[] = ['session', 'diagnostics'];
  return groups
    .map((group) => ({
      group,
      label: GROUP_LABELS[group],
      items: STATUS_BAR_REGISTRY.filter((item) => item.group === group),
    }))
    .filter((g) => g.items.length > 0);
}
