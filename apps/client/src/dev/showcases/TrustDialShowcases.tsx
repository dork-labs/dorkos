/**
 * The Trust Dial across every runtime that ships, the states a dial can be in
 * that are easy to get wrong, the two surfaces nobody is watching — an
 * integration binding and a scheduled task — and the two places a person says
 * where NEW sessions should start (spec `trust-dial`, decisions 1–3, 5 and 6).
 *
 * Every demo is the REAL component driven by the REAL declared modes, copied from
 * each adapter's `runtime-constants`. That is the whole point: the dial's job is
 * to render what a runtime said about itself, so a hand-tuned fixture would
 * demonstrate the fixture. Selecting a stop here is live — the state is local, so
 * the caption rewrites itself as it would in a session.
 *
 * @module dev/showcases/TrustDialShowcases
 */
import { useState, type ReactNode } from 'react';
import type { PermissionModeDescriptor, PermissionStop } from '@dorkos/shared/agent-runtime';
import { PlanModeItem, AutonomyConfirmDialog, MakeDefaultStopLine } from '@/layers/features/status';
import { GlobalTrustRow, TrustRow, type GlobalTrustRowRuntime } from '@/layers/features/settings';
import { Button, TrustDial, UnattendedAutonomyDialog } from '@/layers/shared/ui';
import { needsConsentRitual } from '@/layers/shared/lib';
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
    promise:
      'Acts without approval prompts — including outside this project. Still asks when it needs your call.',
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
    promise:
      "Acts without approval prompts, anywhere on your machine, network included — and can't pause to ask.",
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
    promise:
      'Acts without approval prompts — including outside this project. Still asks when it needs your call.',
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

/**
 * The same dial on a surface nobody is watching — a relay binding or a scheduled
 * task. Two things change and nothing else does: a stored mode with no stop is
 * kept until somebody picks one and SAVES, and any stop that never asks asks first
 * — with copy about what stops happening on this particular surface.
 */
function UnattendedDial({
  descriptors,
  initial,
  subject,
  consequence,
}: {
  descriptors: PermissionModeDescriptor[];
  initial: string;
  /** How this surface names itself in the stranded sentence. */
  subject: 'This integration' | 'This task';
  consequence: ReactNode;
}) {
  const [mode, setMode] = useState(initial);
  const [pending, setPending] = useState<PermissionModeDescriptor | null>(null);
  // The runtime's own word for the mode wherever it declared one, exactly as the
  // real callers resolve it — a hardcoded label here would demonstrate the
  // hardcode rather than the component.
  const modeLabel = descriptors.find((d) => d.id === mode)?.label ?? mode;
  return (
    <div className="w-72">
      <TrustDial
        mode={mode}
        descriptors={descriptors}
        strandsWorkingMode
        strandedNote={
          <>
            {subject} is set to “{modeLabel}”, which is not one of these. Saving keeps it as it is —
            pick a stop to change it.
          </>
        }
        onChangeMode={(next) => {
          // The same rule the real callers apply, so the playground shows the
          // dialog on Codex's never-asking middle stop exactly as they do.
          const descriptor = descriptors.find((d) => d.id === next);
          if (descriptor && needsConsentRitual(descriptor)) {
            setPending(descriptor);
            return;
          }
          setMode(next);
        }}
      />
      <UnattendedAutonomyDialog
        descriptor={pending}
        consequence={consequence}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending) setMode(pending.id);
          setPending(null);
        }}
      />
    </div>
  );
}

/** What a binding gives up at a stop that never asks. */
const BINDING_CONSEQUENCE = (
  <>
    At a stop that asks, an action this agent needs permission for waits for an answer: where your
    integration can show buttons, it arrives in the chat as Approve and Deny, and only the people on
    the approver list may answer. Either way an ask nobody answers is refused after 10 minutes and
    the agent carries on without it. Here nothing is asked at all — anyone who can send a message
    through this integration sets off whatever the agent decides to do.
  </>
);

/** What a scheduled run gives up at a stop that never asks. */
const TASK_CONSEQUENCE = (
  <>
    A scheduled run has nobody to ask, so nothing is asked: no approval card, no message, no record
    of a decision anybody made. At a stop that asks, an action it cannot take is refused and the run
    works around it. Here it simply happens.
  </>
);

/** The three runtimes the settings surfaces below talk about, with their modes. */
const SETTINGS_RUNTIMES = [
  { runtime: 'claude-code', label: 'Claude Code', descriptors: CLAUDE },
  { runtime: 'codex', label: 'Codex', descriptors: CODEX },
  { runtime: 'opencode', label: 'OpenCode', descriptors: OPENCODE },
];

/**
 * Settings' shared trust setting and the per-runtime override beneath it, live
 * (spec `trust-dial` decision 6B, as the runtimes redesign rebuilt it).
 *
 * One question is now asked in one row under the runtime cards, and each card
 * carries its own way out of it — so the two components are shown together, with
 * the same state behind them that the tab keeps. The writes stay local: this is
 * a playground, and the real thing changes where every new session starts.
 */
function LiveSettingsTrust({ initial }: { initial: PermissionStop | null }) {
  const [stop, setStop] = useState<PermissionStop | null>(initial);
  const [overrides, setOverrides] = useState<Record<string, PermissionStop | null>>({});
  const runtimes: GlobalTrustRowRuntime[] = SETTINGS_RUNTIMES.map((entry) => ({
    runtime: entry.runtime,
    label: entry.label,
    stop: overrides[entry.runtime] ?? null,
  }));
  const globalStop = stop ?? 'ask';
  return (
    <div className="w-full max-w-xl space-y-6">
      <GlobalTrustRow
        stop={stop}
        effectiveStop="ask"
        runtimes={runtimes}
        onChange={setStop}
        onChangeRuntime={(runtime, next) =>
          setOverrides((current) => ({ ...current, [runtime]: next }))
        }
      />
      {/* Each card's own row, which is where the per-runtime override moved. In
          the tab these sit one per card, above this row rather than below it. */}
      <div className="space-y-4 border-t pt-4">
        {SETTINGS_RUNTIMES.map((entry) => (
          <TrustRow
            key={entry.runtime}
            runtimeType={entry.runtime}
            runtimeLabel={entry.label}
            descriptors={entry.descriptors}
            stop={overrides[entry.runtime] ?? null}
            globalStop={globalStop}
            onChange={(next) => setOverrides((current) => ({ ...current, [entry.runtime]: next }))}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The in-session offer, under the dial a person just moved (decision 6C).
 *
 * Driven by a real stop change, because the offer's whole point is that it is a
 * response to one: pick a stop and the line appears for a few seconds, exactly
 * as it does in a session. It withholds itself for the stop that is already the
 * default, which is the behaviour worth seeing next to the behaviour it replaces.
 */
function LiveMakeDefaultOffer() {
  const [mode, setMode] = useState('default');
  const [offered, setOffered] = useState<PermissionStop | null>(null);
  const [madeDefault, setMadeDefault] = useState<PermissionStop>('ask');
  return (
    <div className="w-72">
      <TrustDial
        mode={mode}
        descriptors={CLAUDE}
        onChangeMode={(next) => {
          setMode(next);
          const picked = CLAUDE.find((d) => d.id === next);
          setOffered(picked && picked.stop !== madeDefault ? picked.stop : null);
        }}
      />
      <MakeDefaultStopLine
        stop={offered}
        onMakeDefault={() => {
          if (offered) setMadeDefault(offered);
          setOffered(null);
        }}
        onDismiss={() => setOffered(null)}
      />
      <p className="text-muted-foreground text-3xs px-1">
        New sessions currently start in: {madeDefault}
      </p>
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

/**
 * The consent door, opened on demand.
 *
 * Two modes reach it and they must not look identical: Codex's full access is
 * green and names itself, while its middle stop is amber, keeps the dial's word
 * ("Act"), and carries the sentence that says what the word does not.
 */
function LiveAutonomyDialog({
  descriptor,
  trigger,
}: {
  descriptor: PermissionModeDescriptor;
  trigger: string;
}) {
  const [open, setOpen] = useState(false);
  const [lastAnswer, setLastAnswer] = useState<string | null>(null);
  const autonomy = descriptor;
  return (
    <div className="flex items-center gap-3">
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        {trigger}
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
        description="How much this agent may do before it checks with you, rendered from what each runtime declared about its own modes. The words never change; the caption underneath does all the truth-telling."
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

        <ShowcaseLabel>
          Full autonomy — green, because full power is what the product is for
        </ShowcaseLabel>
        <ShowcaseDemo>
          <LiveDial descriptors={CLAUDE} initial="bypassPermissions" />
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
        title="Trust Dial — the door into a mode that never asks"
        description="A stop that stops the asking cannot be walked back, so it asks twice — and that is not only the top of the dial. On a runtime that cannot pause mid-turn, the MIDDLE stop never asks either, and it goes through the same door in its own words. The consequence sentence is always the runtime's own; the scope note says what it does not cover."
      >
        <ShowcaseLabel>
          Full autonomy, on a Codex session — green, and it names itself
        </ShowcaseLabel>
        <ShowcaseDemo>
          <LiveAutonomyDialog descriptor={CODEX[2]!} trigger="Choose Full autonomy (Codex)" />
        </ShowcaseDemo>

        <ShowcaseLabel>
          Codex&rsquo;s middle stop — amber, keeps the dial&rsquo;s word, says what the word hides
        </ShowcaseLabel>
        <ShowcaseDemo>
          <LiveAutonomyDialog descriptor={CODEX[1]!} trigger="Choose Act (Codex)" />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Trust Dial — the surfaces nobody is watching"
        description="An integration binding and a scheduled task ask the same question with the same control. Two things differ: a stored mode with no stop is kept until somebody picks one AND saves, and the confirmation for a stop that never asks names what stops happening HERE — the approval that would have arrived in a chat, the card a run would have waited on."
      >
        <ShowcaseLabel>
          A binding saved at Plan — kept and named, never quietly widened
        </ShowcaseLabel>
        <ShowcaseDemo>
          <UnattendedDial
            descriptors={CLAUDE}
            initial="plan"
            subject="This integration"
            consequence={BINDING_CONSEQUENCE}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>A task saved at a mode this runtime no longer declares</ShowcaseLabel>
        <ShowcaseDemo>
          <UnattendedDial
            descriptors={CLAUDE.filter((d) => d.id !== 'auto')}
            initial="auto"
            subject="This task"
            consequence={TASK_CONSEQUENCE}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>
          The binding’s door — the approver list, and the 10-minute deny (try Act as well as Full
          autonomy)
        </ShowcaseLabel>
        <ShowcaseDemo>
          <UnattendedDial
            descriptors={CODEX}
            initial="default"
            subject="This integration"
            consequence={BINDING_CONSEQUENCE}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>The task’s door — an unattended run is never shown a card</ShowcaseLabel>
        <ShowcaseDemo>
          <UnattendedDial
            descriptors={CLAUDE}
            initial="acceptEdits"
            subject="This task"
            consequence={TASK_CONSEQUENCE}
          />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="Trust Dial — where new sessions start"
        description="Settings asks this question once, for every runtime, and each runtime card carries its own way out of it. Note the vocabulary: a session dial says 'Ask first' because a person is choosing what to do next, while these settings surfaces say 'Asks before acting' because they describe what agents will keep doing. Same three stops, one reading voice each. A card can sit at Full autonomy while the shared row reads Asks before acting, and the note says so either way."
      >
        <ShowcaseLabel>Settings — Asks before acting, the shipped default</ShowcaseLabel>
        <ShowcaseDemo responsive>
          <LiveSettingsTrust initial={null} />
        </ShowcaseDemo>

        <ShowcaseLabel>
          Settings — Full autonomy standing, with the note that keeps it findable
        </ShowcaseLabel>
        <ShowcaseDemo responsive>
          <LiveSettingsTrust initial="autonomy" />
        </ShowcaseDemo>

        <ShowcaseLabel>
          In session — “Make default”, offered only when it would change something
        </ShowcaseLabel>
        <ShowcaseDemo>
          <LiveMakeDefaultOffer />
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
