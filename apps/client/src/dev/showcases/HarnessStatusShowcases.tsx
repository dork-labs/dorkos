/**
 * Agent file sharing, as the profile's Skills page draws it.
 *
 * Every visual state the `entities/harness` slice can produce, from fixture
 * data rather than from a live query, so the whole page renders with no server
 * behind it. What it is for: a tone regression — a dropped chip that starts
 * shouting, a warning that stops — is invisible one state at a time and obvious
 * with all seven side by side.
 *
 * @module dev/showcases/HarnessStatusShowcases
 */
import { useMemo, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HarnessStatusResponse } from '@dorkos/shared/harness-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import {
  HarnessDriftBanner,
  HarnessStateChip,
  HarnessSyncSummary,
  NotEnabledNotice,
  NotSharedPanel,
  ProjectLevelNoticesPanel,
  SkillHarnessRow,
  SkillsWithHarnessesList,
  HARNESS_STATUS_ALL_SHARED,
  HARNESS_STATUS_NOT_SET_UP,
  HARNESS_STATUS_NO_SKILLS,
  HARNESS_STATUS_READY,
  HARNESS_STATUS_UNAVAILABLE,
  HARNESS_STATUS_UNREADABLE,
} from '@/layers/entities/harness';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { createPlaygroundTransport } from '../playground-transport';
import {
  EVERY_CHIP_STATE,
  HARNESS_STATUS_SIX_TOOLS,
  LONG_PATH_ROW,
  SIX_TOOLS,
  SIX_TOOL_ROW,
  THREE_TOOLS,
  readyRow,
} from './harness-status-showcase-data';

/** The folder every demo below claims to be about. */
const FIXTURE_PATH = '/Users/kai/code/dorkos';

/** What a list demo is handed instead of a server. */
type Answer = HarnessStatusResponse | 'loading' | 'error';

/**
 * The playground transport with one answer swapped in.
 *
 * A stub rather than a pre-seeded cache: the list refetches on mount, so a
 * cache entry alone would be replaced by whatever the transport said next —
 * which in the playground is `null` and an error card.
 */
function stubTransport(answer: Answer): Transport {
  const base = createPlaygroundTransport();
  return new Proxy(base, {
    get: (target, prop) => {
      if (prop !== 'getHarnessStatus') return Reflect.get(target, prop);
      return (): Promise<HarnessStatusResponse> => {
        if (answer === 'loading') return new Promise<HarnessStatusResponse>(() => {});
        if (answer === 'error') return Promise.reject(new Error('the playground has no server'));
        return Promise.resolve(answer);
      };
    },
  });
}

/**
 * One list, drawn against one answer, with a cache and a transport of its own.
 *
 * Its own `QueryClient` per demo on purpose: they all name one project path, so
 * a shared cache would make the last demo to mount decide what every other one
 * showed.
 */
function ListFixture({ answer }: { answer: Answer }) {
  const transport = useMemo(() => stubTransport(answer), [answer]);
  const queryClient = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    []
  );
  return (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <SkillsWithHarnessesList projectPath={FIXTURE_PATH} />
      </TransportProvider>
    </QueryClientProvider>
  );
}

/**
 * One banner, drawn against one status, with a cache and a transport of its own.
 *
 * The same isolation as {@link ListFixture} and for the same reason: every demo
 * here names one project path, so a shared cache would let the last one to mount
 * decide what the rest showed.
 */
function BannerFixture({ status }: { status: HarnessStatusResponse }) {
  const transport = useMemo(() => stubTransport(status), [status]);
  const queryClient = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    []
  );
  return (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <HarnessDriftBanner projectPath={FIXTURE_PATH} />
      </TransportProvider>
    </QueryClientProvider>
  );
}

/** A ready tree with one thing wrong with it, and no sweep pending. */
function troubleWith(counts: Partial<HarnessStatusResponse['counts']>): HarnessStatusResponse {
  return {
    ...HARNESS_STATUS_ALL_SHARED,
    clean: false,
    counts: { ...HARNESS_STATUS_ALL_SHARED.counts, ...counts },
  };
}

/**
 * A demo penned to the docked panel's narrowest width, where the wrapping shows.
 *
 * 320px is the floor `useRightPanelSizing` enforces, so it is the narrowest a
 * person can drag the profile. `max-w` and not a fixed width: on a screen
 * narrower than that the pen would otherwise reach past the card holding it and
 * clip its own chips — which is a bug in the demo, not in the row it is
 * demonstrating.
 */
function AtPanelWidth({ children }: { children: ReactNode }) {
  return (
    <div className="border-border/60 w-full max-w-[320px] rounded-md border border-dashed p-3">
      {children}
    </div>
  );
}

/** The absolute project path the adoptable row's printed command carries. */
const SHOWCASE_PROJECT = '/Users/you/projects/dorkos';

/**
 * The skill row, in every shape it takes.
 *
 * The collapsed and expanded pair first, because the collapse is the one thing
 * on this page a person can be surprised by; then one row per exception, so the
 * seven chip words and their four tones can be read against each other.
 */
export function SkillRowShowcases() {
  return (
    <PlaygroundSection
      title="Skill rows"
      description="One skill, and what each of your agent tools does with it. A row every enabled tool has and is current on collapses to a single chip — with thirty-one skills, a wall of identical chips is what a person reads past to find the row that matters — and any exception expands it again on its own. The chip words are plain phrases, never the state names this product invented, and only the three states you have to decide something about carry the warning tone."
    >
      <ShowcaseLabel>Healthy — collapsed to one chip, and expanded</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="divide-border flex flex-col divide-y">
          <SkillHarnessRow
            row={readyRow('release')}
            enabled={THREE_TOOLS}
            projectPath={SHOWCASE_PROJECT}
            showEveryHarness={false}
          />
          <SkillHarnessRow
            row={readyRow('release')}
            enabled={THREE_TOOLS}
            projectPath={SHOWCASE_PROJECT}
            showEveryHarness
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Every chip word, side by side</ShowcaseLabel>
      <ShowcaseDemo>
        <ul className="flex flex-wrap items-center gap-1">
          {EVERY_CHIP_STATE.map((state) => (
            <HarnessStateChip
              key={state}
              harness="codex"
              cell={{ state, reason: `what the plan said about a ${state} cell` }}
            />
          ))}
        </ul>
      </ShowcaseDemo>

      <ShowcaseLabel>One row per exception</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="divide-border flex flex-col divide-y">
          {[
            'browser-testing',
            'writing-changelogs',
            'debugging-systematically',
            'marketplace-dev',
            'chat-self-test',
          ].map((name) => (
            <SkillHarnessRow
              key={name}
              row={readyRow(name)}
              enabled={THREE_TOOLS}
              projectPath={SHOWCASE_PROJECT}
              showEveryHarness={false}
            />
          ))}
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>A very long source path, and six tools at once</ShowcaseLabel>
      <ShowcaseDemo>
        <AtPanelWidth>
          <div className="divide-border flex flex-col divide-y">
            <SkillHarnessRow
              row={LONG_PATH_ROW}
              enabled={THREE_TOOLS}
              projectPath={SHOWCASE_PROJECT}
              showEveryHarness={false}
            />
            <SkillHarnessRow
              row={SIX_TOOL_ROW}
              enabled={SIX_TOOLS}
              projectPath={SHOWCASE_PROJECT}
              showEveryHarness={false}
            />
          </div>
        </AtPanelWidth>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/**
 * The three blocks that sit around the list, each drawn from the same tree.
 *
 * Every reason is the projection plan's own sentence, repeated verbatim —
 * `dorkos harness sync` prints these exact strings, and two surfaces describing
 * one fact in two voices is how a person stops trusting either.
 */
export function HarnessPanelShowcases() {
  return (
    <PlaygroundSection
      title="Agent file panels"
      description="What sits around the list: one collapsed panel per tool that is missing something, a panel for the notices that belong to the project rather than to any one tool, and the line about a tool whose files are in the folder that DorkOS is not sharing to. That last one is copy and not a button on purpose — turning a tool on writes a file everybody on the project shares, and a button in a side panel with no diff and no undo promises more than the fact it fixes."
    >
      <ShowcaseLabel>Not shared with a tool — collapsed, with the count</ShowcaseLabel>
      <ShowcaseDemo>
        <NotSharedPanel rows={HARNESS_STATUS_READY.rows} enabled={THREE_TOOLS} />
      </ShowcaseDemo>

      <ShowcaseLabel>Project-level notices — all four kinds</ShowcaseLabel>
      <ShowcaseDemo>
        <ProjectLevelNoticesPanel entries={HARNESS_STATUS_READY.projectLevel} />
      </ShowcaseDemo>

      <ShowcaseLabel>A tool DorkOS found and is not sharing to</ShowcaseLabel>
      <ShowcaseDemo>
        <NotEnabledNotice notEnabled={HARNESS_STATUS_READY.notEnabled} />
      </ShowcaseDemo>

      <ShowcaseLabel>All three, at the docked panel’s narrowest</ShowcaseLabel>
      <ShowcaseDemo>
        <AtPanelWidth>
          <div className="flex flex-col gap-2">
            <NotEnabledNotice notEnabled={HARNESS_STATUS_READY.notEnabled} />
            <NotSharedPanel rows={HARNESS_STATUS_READY.rows} enabled={THREE_TOOLS} />
            <ProjectLevelNoticesPanel entries={HARNESS_STATUS_READY.projectLevel} />
          </div>
        </AtPanelWidth>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/**
 * The banner's four branches, the disclosure, and the receipt.
 *
 * Worth all six side by side because the tones are the point: a page that
 * coloured "some files are out of date" the same red as "something is in the
 * way" would be a page where neither means anything. Drift and adoptable are
 * `info`, a conflict and a pending deletion are `warning`, and nothing here is
 * ever `critical` — a file that has not been written yet is not an error.
 */
export function HarnessSyncShowcases() {
  return (
    <PlaygroundSection
      title="Agent files banner"
      description="At most one line at the top of the Skills page, and only when a sync would change something. The one branch with a button is the one a click can fix. When a sync would also DELETE something, the paths are named before the click — each with the engine's own sentence about why it goes — because a button that removes files without a manifest of them is the failure this whole surface exists to prevent."
    >
      <ShowcaseLabel>Out of date — the only branch with a button</ShowcaseLabel>
      <ShowcaseDemo>
        <BannerFixture status={troubleWith({ drifted: 2 })} />
      </ShowcaseDemo>

      <ShowcaseLabel>Out of date, and a click also removes two files</ShowcaseLabel>
      <ShowcaseDemo>
        <BannerFixture status={{ ...HARNESS_STATUS_READY, clean: false }} />
      </ShowcaseDemo>

      <ShowcaseLabel>
        Something else is in the way — no button, because a re-run cannot help
      </ShowcaseLabel>
      <ShowcaseDemo>
        <BannerFixture status={troubleWith({ conflicts: 1 })} />
      </ShowcaseDemo>

      <ShowcaseLabel>A skill only some tools can see</ShowcaseLabel>
      <ShowcaseDemo>
        <BannerFixture status={troubleWith({ adoptable: 3 })} />
      </ShowcaseDemo>

      <ShowcaseLabel>Nothing to say — a clean tree draws no banner at all</ShowcaseLabel>
      <ShowcaseDemo>
        <BannerFixture status={HARNESS_STATUS_ALL_SHARED} />
      </ShowcaseDemo>

      <ShowcaseLabel>What changed, after a sync</ShowcaseLabel>
      <ShowcaseDemo>
        <HarnessSyncSummary
          onDismiss={() => undefined}
          result={{
            status: HARNESS_STATUS_ALL_SHARED,
            applied: 4,
            swept: HARNESS_STATUS_READY.sweepPreview,
            removals: HARNESS_STATUS_READY.removals,
            conflicts: 0,
            askedAbout: ['acme-tools'],
          }}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>The disclosure at the docked panel’s narrowest</ShowcaseLabel>
      <ShowcaseDemo>
        <AtPanelWidth>
          <BannerFixture status={{ ...HARNESS_STATUS_READY, clean: false }} />
        </AtPanelWidth>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** The states the list answers with, and the label each demo carries. */
const PAGE_STATES: { label: string; answer: Answer }[] = [
  { label: 'Reading', answer: 'loading' },
  { label: 'Couldn’t read it', answer: 'error' },
  { label: 'Ready — six skills across three tools', answer: HARNESS_STATUS_READY },
  { label: 'Ready — everything shared and current', answer: HARNESS_STATUS_ALL_SHARED },
  { label: 'Ready — no skills yet', answer: HARNESS_STATUS_NO_SKILLS },
  { label: 'Not set up in this folder', answer: HARNESS_STATUS_NOT_SET_UP },
  { label: 'The settings could not be read', answer: HARNESS_STATUS_UNREADABLE },
  { label: 'Not available in this build', answer: HARNESS_STATUS_UNAVAILABLE },
];

/**
 * The whole list, in every state one read can end in.
 *
 * The four that are not `ready` say what is true and what would change it
 * instead of drawing an empty list — an empty list would tell a person they
 * have no skills, which is the failure this page exists to end.
 */
export function SkillsPageStateShowcases() {
  return (
    <PlaygroundSection
      title="Skills page states"
      description="The list the profile's Skills page composes, against every answer one read can end in. Loading draws the shape of what is coming rather than a spinner. The zero-skills state is the only one that means 'you have none', and it is measured over everything on disk rather than over installed packages — which is what the page it replaced got wrong."
    >
      {PAGE_STATES.map(({ label, answer }) => (
        <div key={label}>
          <ShowcaseLabel>{label}</ShowcaseLabel>
          <ShowcaseDemo>
            <ListFixture answer={answer} />
          </ShowcaseDemo>
        </div>
      ))}

      <ShowcaseLabel>All six tools, at the docked panel’s narrowest</ShowcaseLabel>
      <ShowcaseDemo>
        <AtPanelWidth>
          <ListFixture answer={HARNESS_STATUS_SIX_TOOLS} />
        </AtPanelWidth>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
