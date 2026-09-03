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
import {
  StatusLine,
  SessionPopover,
  applyStatusBudget,
  selectPromotedItems,
} from '@/layers/features/status';
// `resolveStatusBudget` is not in the slice's barrel — in the app it is reached
// only through `useStatusBudget`, which needs a live element to measure. The
// showcase supplies the width itself, so it calls the same pure function directly
// rather than reimplement the tier table and let it drift.
import { resolveStatusBudget } from '@/layers/features/status/model/status-budget';
import { buildStatusItemNodes } from '@/layers/features/chat/ui/status/status-item-nodes';
import { AgentIdentityChip } from '@/layers/features/chat/ui/status/AgentIdentityChip';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import {
  AGENT,
  DEGRADED,
  DEGRADED_ON_DEFAULT,
  DELEGATING,
  HEALTHY,
  PLANNING,
  WAITING_ON_BACKGROUND_TASKS,
  RATE_LIMITED,
  SAMPLED_WIDTHS,
  TIER_WIDTHS,
  type StatusScenario,
} from './status-line-showcase-data';

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
 * Local state for one demo Session panel: its open flag plus control toggles that
 * actually flip. The controls are client state in the app too, so these are the real
 * thing rather than a stub.
 *
 * @internal
 */
function useSessionPanelState() {
  const [open, setOpen] = useState(false);
  const [sound, setSound] = useState(true);
  const [refresh, setRefresh] = useState(false);
  const [planning, setPlanning] = useState(false);

  return {
    open,
    onOpenChange: setOpen,
    controls: {
      sound,
      onToggleSound: () => setSound((s) => !s),
      refresh,
      onToggleRefresh: () => setRefresh((r) => !r),
      plan: { active: planning, onToggle: setPlanning },
    },
  };
}

/**
 * One status line at one width, run through the real promotion + budget pipeline.
 *
 * @param props - The session state to promote, the bar width to fit it into, and any
 *   pinned keys.
 */
function BudgetedLine({
  scenario,
  width,
  pins = [],
}: {
  scenario: StatusScenario;
  width: number;
  pins?: readonly string[];
}) {
  const panel = useSessionPanelState();
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
    selectPromotedItems({ ctx: scenario.ctx, pins, nodes }),
    budget
  );

  return (
    <div className="space-y-1.5">
      <p className="text-muted-foreground text-3xs font-mono">
        {width}px · density <span className="text-foreground">{budget.density}</span> · right budget{' '}
        <span className="text-foreground">{budget.rightBudget}</span> · showing{' '}
        <span className="text-foreground">{items.length}</span> ·{' '}
        {overflow > 0 ? (
          <span className="text-foreground">+{overflow} in the panel</span>
        ) : (
          'everything fits'
        )}
        {budget.dropped.length > 0 && ` · left cluster drops ${budget.dropped.join(', ')}`}
        {pins.length > 0 && ` · pinned ${pins.join(', ')}`}
      </p>
      {/* A fixed width, because the budget is a function of the bar's measured
          width — a fluid box would make every row report the same tier. */}
      <div className="border-border/60 bg-background rounded-md border" style={{ width }}>
        {/* The real Session anchor, not a `⋯` glyph: it is `shrink-0`, it carries the
            `+N`, and on a coarse pointer it claims a 44px target. A stand-in would
            leave every row here ~25px roomier than the app, in the one section that
            is about running out of room. */}
        <StatusLine
          items={items}
          trailing={
            <SessionPopover
              open={panel.open}
              onOpenChange={panel.onOpenChange}
              diagnostics={scenario.diagnostics}
              controls={panel.controls}
              promotionContext={scenario.ctx}
              overflowCount={overflow}
            />
          }
        />
      </div>
    </div>
  );
}

/**
 * Status line and Session panel showcases: `StatusLine` across density tiers, the
 * promoted set at rest versus under stress, what a pin does and does not buy,
 * `SessionPopover`, and the `AgentIdentityChip` anchor.
 */
export function StatusLineShowcases() {
  const plainPanel = useSessionPanelState();
  const countedPanel = useSessionPanelState();

  return (
    <>
      <PlaygroundSection
        title="StatusLine — density tiers"
        description="One degraded session at each tier's floor — the most a tier may say in the fewest pixels it may say it in. The line never scrolls and never wraps, so each width fills the right cluster by urgency until its budget runs out and reports the rest as +N on the ⋯. Read down the column: the item that goes first is the least urgent one, and nothing is ever lost."
      >
        <ShowcaseLabel>Degraded session, narrowing bar</ShowcaseLabel>
        <ShowcaseDemo className="overflow-x-auto">
          <div className="space-y-5">
            {TIER_WIDTHS.map((width) => (
              <BudgetedLine key={width} scenario={DEGRADED} width={width} />
            ))}
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>
          The same tier floor, holding the longest permission label DorkOS ships
        </ShowcaseLabel>
        <ShowcaseDemo className="overflow-x-auto">
          <BudgetedLine scenario={DEGRADED_ON_DEFAULT} width={640} />
        </ShowcaseDemo>

        <ShowcaseLabel>Delegating — twelve subagents, drawn as a whole number</ShowcaseLabel>
        <ShowcaseDemo className="overflow-x-auto">
          <div className="space-y-5">
            {TIER_WIDTHS.map((width) => (
              <BudgetedLine key={width} scenario={DELEGATING} width={width} />
            ))}
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>
          Rate limited — the three loudest signals are the three that draw
        </ShowcaseLabel>
        <ShowcaseDemo className="overflow-x-auto">
          <div className="space-y-5">
            {TIER_WIDTHS.map((width) => (
              <BudgetedLine key={width} scenario={RATE_LIMITED} width={width} />
            ))}
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>
          Planning at the two narrow tiers — Plan holds the slot, not an empty permission chip
          (DOR-1236)
        </ShowcaseLabel>
        <ShowcaseDemo className="overflow-x-auto">
          <div className="space-y-5">
            {/* The `compact` and `identity` floors — the two tiers whose right-cluster
                budget (3 slots) actually contests `permission` against `plan`. Drawn at
                their real tier floors, not an arbitrary narrow width: this page's own
                e2e guard (`status-line-fit.spec.ts`) asserts every row here sits at a
                floor `resolveStatusBudget` defines, so a reproduction has to use one. */}
            {TIER_WIDTHS.filter((width) => width === 440 || width === 340).map((width) => (
              <BudgetedLine key={width} scenario={PLANNING} width={width} />
            ))}
          </div>
        </ShowcaseDemo>
        <p className="text-muted-foreground text-xs">
          Before the fix, this exact reproduction — reconnecting, 92% context, planning — put the
          permission item and the composer&apos;s Plan switch at the same severity (40). The
          tie-break in <code>applyStatusBudget</code> is a stable sort over registry order, and the
          registry lists <code>permission</code> before <code>plan</code>, so the contested slot at
          these two narrow widths went to a permission chip with nothing to report while the Plan
          chip — the one that IS news — landed under the <code>⋯</code>. The permission item now
          omits its node entirely while Plan holds the session, so there is nothing left to contest
          the slot with.
        </p>

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
          The 640px rows are the <code>full</code> tier at its floor holding everything that can
          promote — the tightest the widest tier ever gets. It used to be the tightest by more than
          it admitted: the agent chip rendered ~22px past its own box and the context item ~39px
          past its, each painting over the item beside it, because neither could shrink (DOR-461).
          Both can now, so a width the budget over-promised degrades into an ellipsis. The row
          itself was never able to report that — <code>scrollWidth ≤ clientWidth</code> holds on an{' '}
          <code>overflow-hidden</code> row with shrinkable clusters whether the content fit or was
          absorbed — so the guard is geometric instead:{' '}
          <code>apps/e2e/tests/chat/status-line-fit.spec.ts</code> measures these rows and fails
          when two items&apos; painted extents intersect.
        </p>
        <p className="text-muted-foreground text-xs">
          The single row under the second heading is the same 640px carrying the longest permission
          label DorkOS ships. A slot is priced at 13 characters (<code>STATUS_VALUE_MAX_CHARS</code>
          ) and this tier draws the label whole, so <code>Bypass permissions</code> at 18 takes a
          92px slot where Codex&apos;s <code>Full access</code> takes 63 — which is why the floor
          sells three right-cluster slots rather than four, and reports the rest on the{' '}
          <code>⋯</code>.
        </p>
      </PlaygroundSection>

      <PlaygroundSection
        title="StatusLine — promoted set"
        description="The same component at the same width, two session states. Quiet by default means a healthy session says almost nothing; every promotion rule fires at once under stress, which is exactly when severity ordering has to be right."
      >
        <ShowcaseLabel>At rest — clean tree, connected, default permissions</ShowcaseLabel>
        <ShowcaseDemo className="overflow-x-auto">
          <BudgetedLine scenario={HEALTHY} width={640} />
          <BudgetedLine scenario={WAITING_ON_BACKGROUND_TASKS} width={640} />
        </ShowcaseDemo>

        <ShowcaseLabel>Under stress — same width, everything wrong</ShowcaseLabel>
        <ShowcaseDemo className="overflow-x-auto">
          <BudgetedLine scenario={DEGRADED} width={640} />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="StatusLine — what a pin does"
        description="A pin says “show me”, not “shout at me”. It puts a quiet item in the line — and that is all it does: it buys no immunity from a contested slot or from a tier that gives up the whole left cluster. The pin controls need a server, but the pin's effect is a plain argument to selectPromotedItems, so these rows are the real behaviour."
      >
        <ShowcaseLabel>Pinned — a clean branch with nothing to report, shown anyway</ShowcaseLabel>
        <ShowcaseDemo className="overflow-x-auto">
          <BudgetedLine scenario={HEALTHY} width={640} pins={['git']} />
        </ShowcaseDemo>

        <ShowcaseLabel>The same pin at 340px — the tier drops it regardless</ShowcaseLabel>
        <ShowcaseDemo className="overflow-x-auto">
          <BudgetedLine scenario={HEALTHY} width={340} pins={['git']} />
        </ShowcaseDemo>

        <ShowcaseLabel>
          Pinned and outranked — it enters the line, then loses the slot
        </ShowcaseLabel>
        <ShowcaseDemo className="overflow-x-auto">
          <BudgetedLine scenario={DEGRADED_ON_DEFAULT} width={640} pins={['runtime']} />
        </ShowcaseDemo>

        <p className="text-muted-foreground text-xs">
          Compare the first row with the at-rest row in the section above: the branch is the same
          state either way, in the line only because it is pinned. At 340px it is gone again —{' '}
          <code>applyStatusBudget</code> drops the left keys the density cannot afford without
          consulting the pin, which is the one caveat the docs owe a reader who pins a branch. In
          the third row the runtime is on the server default with nothing to report, so it enters at{' '}
          <code>QUIET</code> and four louder items take the slots; it is not lost, it is the honest
          part of the <code>+N</code>.
        </p>
      </PlaygroundSection>

      <PlaygroundSection
        title="SessionPopover"
        description="The reveal behind the ⋯ — every row with its live value, a pin on the rows you may keep in the line, and Copy diagnostics. Click a ⋯ below to open it (⌘. does it in a real session)."
      >
        <ShowcaseLabel>Everything fits — plain ⋯</ShowcaseLabel>
        <ShowcaseDemo>
          <SessionPopover
            open={plainPanel.open}
            onOpenChange={plainPanel.onOpenChange}
            diagnostics={DEGRADED.diagnostics}
            controls={plainPanel.controls}
            promotionContext={DEGRADED.ctx}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>
          Items dropped — +N, with the compact action promoted to a button
        </ShowcaseLabel>
        <ShowcaseDemo>
          <SessionPopover
            open={countedPanel.open}
            onOpenChange={countedPanel.onOpenChange}
            diagnostics={DEGRADED.diagnostics}
            controls={countedPanel.controls}
            promotionContext={DEGRADED.ctx}
            overflowCount={4}
            urgentAction={{ label: 'Compact conversation — 88% full', onAction: () => {} }}
          />
        </ShowcaseDemo>

        <p className="text-muted-foreground text-xs">
          Two things only a real session can show. <strong>Pin controls</strong> write to server
          config (<code>ui.statusBar.pins</code>) so they sync across surfaces and an agent can set
          them — the playground has no server, so every row reads unpinned and clicking a pin does
          not stick. (What a pin then <em>does</em> needs no server; see the section above.){' '}
          <strong>Row order</strong> is registry order here; on a phone the panel sorts Session rows
          most-urgent-first, which needs a real viewport, not a narrowed demo box.
        </p>
      </PlaygroundSection>

      <AgentIdentityChipShowcase />
    </>
  );
}

/**
 * The identity anchor of the status line's left cluster.
 *
 * Its own exported component because the Identity page renders it too — it is a
 * session-chrome surface first, so its registry entry stays on Chat and its
 * anchor with it (spec `identity-consistency` §W4.2).
 */
export function AgentIdentityChipShowcase() {
  return (
    <PlaygroundSection
      title="AgentIdentityChip"
      description="Who you are talking to — the identity anchor of the left cluster. Click opens the profile, the same one every other face in the cockpit opens; right-click (long-press on touch) offers switch agent, view profile, and new session."
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

      <ShowcaseLabel>Avatar only — the narrowest tier, name kept for screen readers</ShowcaseLabel>
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
  );
}
