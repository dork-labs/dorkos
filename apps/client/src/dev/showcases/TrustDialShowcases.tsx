/**
 * The Trust Dial across every runtime that ships, plus the three states a dial
 * can be in that are easy to get wrong (spec `trust-dial`, decisions 1–3).
 *
 * Every demo is the REAL component driven by the REAL declared modes, copied from
 * each adapter's `runtime-constants`. That is the whole point: the dial's job is
 * to render what a runtime said about itself, so a hand-tuned fixture would
 * demonstrate the fixture. Selecting a stop here is live — the state is local, so
 * the caption rewrites itself as it would in a session.
 *
 * @module dev/showcases/TrustDialShowcases
 */
import { useState } from 'react';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import { TrustDial, PlanModeItem, AutonomyConfirmDialog } from '@/layers/features/status';
import { Button } from '@/layers/shared/ui';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/** Claude Code's declared modes, in its declared order. */
const CLAUDE: PermissionModeDescriptor[] = [
  {
    id: 'default',
    label: 'Default',
    stop: 'ask',
    asks: 'always',
    reach: 'edit',
    promise: 'Asks before it edits a file or runs a command.',
  },
  {
    id: 'acceptEdits',
    label: 'Accept edits',
    stop: 'act',
    asks: 'when-risky',
    reach: 'edit',
    promise: 'Edits files on its own. Asks before it runs a command.',
  },
  {
    id: 'plan',
    label: 'Plan',
    stop: 'ask',
    axis: 'working',
    asks: 'always',
    reach: 'read',
    promise: 'Reads and plans only. Nothing changes until you approve the plan.',
  },
  {
    id: 'bypassPermissions',
    label: 'Bypass permissions',
    stop: 'autonomy',
    asks: 'never',
    reach: 'everything',
    promise: 'Runs everything without asking, including outside this project.',
  },
  {
    id: 'auto',
    label: 'Auto',
    stop: 'act',
    asks: 'when-risky',
    reach: 'edit',
    promise: 'Edits files on its own and weighs each command, asking you about the risky ones.',
  },
];

/** Codex's declared modes — the runtime the divergent caption exists for. */
const CODEX: PermissionModeDescriptor[] = [
  {
    id: 'default',
    label: 'Read only',
    stop: 'ask',
    asks: 'never',
    reach: 'read',
    promise: 'Reads files and answers questions. Nothing on your machine changes.',
    native: 'read-only',
  },
  {
    id: 'acceptEdits',
    label: 'Workspace write',
    stop: 'act',
    asks: 'never',
    reach: 'workspace',
    promise: "Edits files and runs commands inside the workspace — Codex can't pause to ask.",
    native: 'workspace-write',
  },
  {
    id: 'bypassPermissions',
    label: 'Full access',
    stop: 'autonomy',
    asks: 'never',
    reach: 'everything',
    promise: 'Runs everything without asking, anywhere on your machine, network included.',
    native: 'danger-full-access',
  },
];

/** OpenCode's declared modes. */
const OPENCODE: PermissionModeDescriptor[] = [
  {
    id: 'default',
    label: 'Default',
    stop: 'ask',
    asks: 'always',
    reach: 'edit',
    promise: 'Asks before it edits a file, runs a command, or fetches a page.',
  },
  {
    id: 'acceptEdits',
    label: 'Accept edits',
    stop: 'act',
    asks: 'when-risky',
    reach: 'edit',
    promise: 'Edits files on its own. Asks before it runs a command.',
  },
  {
    id: 'bypassPermissions',
    label: 'Bypass permissions',
    stop: 'autonomy',
    asks: 'never',
    reach: 'everything',
    promise: 'Runs everything without asking, including outside this project.',
  },
];

/** test-mode's declared modes — ids no client table has ever heard of. */
const TEST_MODE: PermissionModeDescriptor[] = [
  {
    id: 'always-allow',
    label: 'Always allow',
    stop: 'autonomy',
    asks: 'never',
    reach: 'everything',
    promise: 'Approves every request without asking. For tests only.',
  },
  {
    id: 'always-deny',
    label: 'Always deny',
    stop: 'ask',
    asks: 'always',
    reach: 'read',
    promise: 'Refuses every request. For tests only.',
  },
  {
    id: 'scripted',
    label: 'Scripted',
    stop: 'act',
    asks: 'when-risky',
    reach: 'edit',
    promise: "Answers each request the way the test scenario's script says. For tests only.",
  },
];

/** A runtime with no middle ground — the stop is absent, never disabled. */
const TWO_STOP: PermissionModeDescriptor[] = [CLAUDE[0], CLAUDE[3]];

/** One live dial, in the width the status popover gives it. */
function LiveDial({
  descriptors,
  initial,
  planActive,
}: {
  descriptors: PermissionModeDescriptor[];
  initial: string;
  planActive?: boolean;
}) {
  const [mode, setMode] = useState(initial);
  return (
    <div className="w-72">
      <TrustDial
        mode={mode}
        descriptors={descriptors}
        onChangeMode={setMode}
        planActive={planActive}
      />
    </div>
  );
}

/** The composer's Plan switch, wired to its own state. */
function LivePlanChip() {
  const [active, setActive] = useState(false);
  return (
    <div className="text-muted-foreground flex items-center gap-4 text-xs">
      <PlanModeItem descriptor={CLAUDE[2]} active={active} onToggle={setActive} />
      <span>{active ? 'on — the dial is frozen' : 'off'}</span>
    </div>
  );
}

/** The door into Full autonomy, opened on demand. */
function LiveAutonomyDialog() {
  const [open, setOpen] = useState(false);
  const [lastAnswer, setLastAnswer] = useState<string | null>(null);
  const autonomy = CODEX[2];
  return (
    <div className="flex items-center gap-3">
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Choose Full autonomy (Codex)
      </Button>
      {/* The playground shows what the checkbox ANSWERS rather than acting on
          it: writing the real acknowledgement here would silence the dialog for
          whoever opened the playground to look at it. */}
      {lastAnswer && <span className="text-muted-foreground text-xs">{lastAnswer}</span>}
      <AutonomyConfirmDialog
        canRemember
        descriptor={open ? autonomy : null}
        onCancel={() => {
          setOpen(false);
          setLastAnswer('Cancelled');
        }}
        onConfirm={(rememberChoice) => {
          setOpen(false);
          setLastAnswer(
            rememberChoice ? 'Confirmed — and asked not to be shown again' : 'Confirmed once'
          );
        }}
      />
    </div>
  );
}

/** Trust Dial showcases for the dev playground. */
export function TrustDialShowcases() {
  return (
    <>
      <PlaygroundSection
        title="Trust Dial — one question, three stops"
        description="How much this agent may do without asking, rendered from what each runtime declared about its own modes. The words never change; the caption underneath does all the truth-telling."
      >
        <ShowcaseLabel>Claude Code — Act carries the Auto refinement inside it</ShowcaseLabel>
        <ShowcaseDemo>
          <LiveDial descriptors={CLAUDE} initial="acceptEdits" />
        </ShowcaseDemo>

        <ShowcaseLabel>
          Codex — the same middle stop, a materially different promise (amber)
        </ShowcaseLabel>
        <ShowcaseDemo>
          <LiveDial descriptors={CODEX} initial="acceptEdits" />
        </ShowcaseDemo>

        <ShowcaseLabel>OpenCode — three stops, nothing to warn about</ShowcaseLabel>
        <ShowcaseDemo>
          <LiveDial descriptors={OPENCODE} initial="default" />
        </ShowcaseDemo>

        <ShowcaseLabel>
          test-mode — mode ids no client table knows, described correctly anyway
        </ShowcaseLabel>
        <ShowcaseDemo>
          <LiveDial descriptors={TEST_MODE} initial="always-allow" />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Trust Dial — the awkward states"
        description="A dial with nothing lit, a dial that cannot move, and a runtime that has no middle ground. Each one is a state the old six-item picker showed silently."
      >
        <ShowcaseLabel>
          Stranded — the session is at a mode this runtime no longer offers
        </ShowcaseLabel>
        <ShowcaseDemo>
          <LiveDial descriptors={CLAUDE} initial="dontAsk" />
        </ShowcaseDemo>

        <ShowcaseLabel>Planning — the stops are frozen until Plan goes off</ShowcaseLabel>
        <ShowcaseDemo>
          <LiveDial descriptors={CLAUDE} initial="plan" planActive />
        </ShowcaseDemo>

        <ShowcaseLabel>A runtime with no middle stop — absent, not greyed out</ShowcaseLabel>
        <ShowcaseDemo>
          <LiveDial descriptors={TWO_STOP} initial="default" />
        </ShowcaseDemo>

        <ShowcaseLabel>Before the runtime has answered — no stops, no claims</ShowcaseLabel>
        <ShowcaseDemo>
          <LiveDial descriptors={[]} initial="default" />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Trust Dial — the door into Full autonomy"
        description="The one stop a person cannot walk back asks twice. The consequence sentence is the runtime's own — what Full autonomy means differs by agent — and the scope note says what it does not cover. Asked once per session, and the segmented control stops at the ends so an arrow key cannot wander in."
      >
        <ShowcaseLabel>The confirmation, on a Codex session</ShowcaseLabel>
        <ShowcaseDemo>
          <LiveAutonomyDialog />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Plan — a way of working, beside the composer"
        description="Plan left the trust axis: it is not a level of trust but a way of working, so it sits in the status line as a switch. Only runtimes that declare such a mode render it at all."
      >
        <ShowcaseLabel>The switch, on and off</ShowcaseLabel>
        <ShowcaseDemo>
          <LivePlanChip />
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}
