/**
 * Settings → Runtimes, one card at a time.
 *
 * The two components these cards replaced had no playground coverage at all,
 * because both read config through hooks and could only ever be seen in the one
 * state a running server happened to be in. `RuntimeCardView` is props-only by
 * design (spec `runtimes-settings-redesign`, decision 7), so every state the
 * design session drew is reachable here without a server: connected and not,
 * default and default-but-broken, a model that is gone, an effort that does
 * nothing.
 *
 * Two rules the demos below follow:
 *
 * - **The real component, the real declarations.** Modes and settings sections
 *   come from the playground's capability mirror, and the collapsed summary line
 *   is computed by the same `buildRuntimeCardSummary` the app calls. A card here
 *   says what the card there would say.
 * - **The sections own their own reads.** `ClaudeAccountsSection` is a feature
 *   component with hooks, so it is given a seeded query cache rather than props;
 *   the power source is shown through `PowerSourceSectionView`, the props-only
 *   half that exists for exactly this.
 *
 * @module dev/showcases/RuntimeCardShowcases
 */
import type { ReactNode } from 'react';
import { ClaudeAccountsSection, PowerSourceSectionView } from '@/layers/features/settings';
import { describePowerSource, renderRuntimeConnect } from '@/layers/features/runtime-connect';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { LiveRuntimeCard, MockedQueryProvider } from './settings-showcase-helpers';
import { MOCK_RETIRED_MODEL_ID, MOCK_SERVER_CONFIG_MULTI_ACCOUNT } from './settings-mock-data';

/** The power source OpenCode's card names, worded the way the picker words it. */
const OPENCODE_PROVIDER = 'ollama';

/**
 * The catalog a runtime offers before any provider is connected: a capped
 * slice with every row marked `unverified`. The Model row must admit that
 * (DOR-1674), the same admission the composer picker makes (DOR-1660).
 */
const UNVERIFIED_CATALOG = [
  {
    value: 'anthropic/claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    description: 'OpenRouter · anthropic/claude-sonnet-5',
    unverified: true,
  },
  {
    value: 'openai/gpt-5.2',
    displayName: 'GPT-5.2',
    description: 'OpenRouter · openai/gpt-5.2',
    unverified: true,
  },
  {
    value: 'google/gemini-3-pro',
    displayName: 'Gemini 3 Pro',
    description: 'OpenRouter · google/gemini-3-pro',
    unverified: true,
  },
];

/** Claude Code's declared accounts section, over a roster worth looking at. */
function accountsSection(kind: string): ReactNode {
  return kind === 'claude-accounts' ? <ClaudeAccountsSection /> : null;
}

/** OpenCode's declared power-source section, with a source on record. */
function powerSourceSection(kind: string): ReactNode {
  return kind === 'opencode-power-source' ? (
    <PowerSourceSectionView
      type="opencode"
      provider={OPENCODE_PROVIDER}
      renderConnect={renderRuntimeConnect}
    />
  ) : null;
}

/** OpenCode's power-source section for a runtime signed in outside DorkOS. */
function unknownPowerSourceSection(kind: string): ReactNode {
  return kind === 'opencode-power-source' ? (
    <PowerSourceSectionView type="opencode" renderConnect={renderRuntimeConnect} />
  ) : null;
}

/** The connect flow an unconnected OpenCode offers. */
function openCodeConnect(): ReactNode {
  return renderRuntimeConnect({
    type: 'opencode',
    connect: { kind: 'provider-picker', label: 'Connect OpenCode' },
  });
}

/** Runtime card showcases for the dev playground. */
export function RuntimeCardShowcases() {
  return (
    <>
      <StatusBoardSection />
      <OpenedSection />
      <SomethingWrongSection />
      <PhoneSection />
    </>
  );
}

/** The collapsed trio: what the tab looks like when nobody is editing anything. */
function StatusBoardSection() {
  return (
    <PlaygroundSection
      title="Runtime cards: the status board at rest"
      description="Every runtime is a card, and the card is a status line: what a new conversation here starts with, whether this is where new conversations start at all, and whether it can start one. A runtime that is not connected says one true sentence instead of a summary of what it would do."
    >
      <ShowcaseLabel>The default runtime, an ordinary one, and one still to connect</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="space-y-3">
          <LiveRuntimeCard
            type="claude-code"
            isDefault
            sectionValues={{ 'claude-accounts': 'Acme Corp' }}
          />
          <LiveRuntimeCard type="codex" model="gpt-5-codex" effort="medium" models={[]} />
          <LiveRuntimeCard type="opencode" ready={false} connectSlot={openCodeConnect()} />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Nothing pinned anywhere: the runtime chooses, and the card says so
      </ShowcaseLabel>
      <ShowcaseDemo>
        <LiveRuntimeCard type="claude-code" model={null} effort={null} />
      </ShowcaseDemo>

      <ShowcaseLabel>Its own stop, not the shared one</ShowcaseLabel>
      <ShowcaseDemo>
        <LiveRuntimeCard type="claude-code" trustStop="autonomy" globalStop="ask" />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** The bodies: rows, and whatever sections the runtime declared. */
function OpenedSection() {
  return (
    <PlaygroundSection
      title="Runtime cards: opened"
      description="Model, effort and where it stops for you are the same three rows on every card. What follows them is not: a card carries whatever sections its runtime declared, and a runtime that declares none simply ends after the rows."
    >
      <ShowcaseLabel>Claude Code, with the accounts it can bill to</ShowcaseLabel>
      <ShowcaseDemo>
        <MockedQueryProvider config={MOCK_SERVER_CONFIG_MULTI_ACCOUNT}>
          <LiveRuntimeCard
            type="claude-code"
            isDefault
            expanded
            renderSection={accountsSection}
            sectionValues={{ 'claude-accounts': 'Acme Corp' }}
          />
        </MockedQueryProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>OpenCode, with a power source on record</ShowcaseLabel>
      <ShowcaseDemo>
        <LiveRuntimeCard
          type="opencode"
          expanded
          model={null}
          effort={null}
          renderSection={powerSourceSection}
          sectionValues={{ 'opencode-power-source': describePowerSource(OPENCODE_PROVIDER) }}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>A capped, unconfirmed catalog says so under the Model row</ShowcaseLabel>
      <ShowcaseDemo>
        <LiveRuntimeCard
          type="opencode"
          expanded
          model={null}
          effort={null}
          models={UNVERIFIED_CATALOG}
          renderSection={unknownPowerSourceSection}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>OpenCode, signed in somewhere DorkOS cannot see</ShowcaseLabel>
      <ShowcaseDemo>
        <LiveRuntimeCard
          type="opencode"
          expanded
          model={null}
          effort={null}
          renderSection={unknownPowerSourceSection}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Codex, which declares no sections at all</ShowcaseLabel>
      <ShowcaseDemo>
        <LiveRuntimeCard type="codex" expanded model="gpt-5-codex" effort="medium" models={[]} />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** The honesty states: the ones a card must not quietly round off. */
function SomethingWrongSection() {
  return (
    <PlaygroundSection
      title="Runtime cards: when something is wrong"
      description="Absences and breakages are said, not hidden. The default runtime keeps its pill even when it cannot start a conversation, because hiding either half hides the problem; a model nobody offers any more stays selectable rather than blanking the field; and a setting that does nothing where it is saved offers a way to clear it."
    >
      <ShowcaseLabel>
        A default that cannot start anything: the pill, the warning and Connect
      </ShowcaseLabel>
      <ShowcaseDemo>
        <LiveRuntimeCard type="opencode" isDefault ready={false} connectSlot={openCodeConnect()} />
      </ShowcaseDemo>

      <ShowcaseLabel>A model that is no longer offered, still the one that is set</ShowcaseLabel>
      <ShowcaseDemo>
        <LiveRuntimeCard type="claude-code" expanded model={MOCK_RETIRED_MODEL_ID} effort={null} />
      </ShowcaseDemo>

      <ShowcaseLabel>An effort saved against a model that does not take one</ShowcaseLabel>
      <ShowcaseDemo>
        <LiveRuntimeCard type="claude-code" expanded model="claude-haiku-4-5" effort="high" />
      </ShowcaseDemo>

      <ShowcaseLabel>A runtime with no effort setting at all</ShowcaseLabel>
      <ShowcaseDemo>
        <LiveRuntimeCard type="opencode" expanded model={null} effort={null} />
      </ShowcaseDemo>

      <ShowcaseLabel>A runtime with nowhere to keep a setting at all</ShowcaseLabel>
      <ShowcaseDemo>
        <LiveRuntimeCard type="codex" expanded storesDefaults={false} />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** The width the design had to survive: a phone. */
function PhoneSection() {
  return (
    <PlaygroundSection
      title="Runtime cards: on a phone"
      description="Switch the viewport to Mobile. The cards stay a single column and expand in place rather than opening a second screen; the summary drops to whatever fits without ever breaking a value — or its separator — across two lines; and the two quiet header affordances, Make default and Fix sign-in, move into the opened body, where there is room for them. The runtime's name never yields to any of it."
    >
      <ShowcaseLabel>The board, then one card opened</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="space-y-3">
          <LiveRuntimeCard
            type="claude-code"
            isDefault
            sectionValues={{ 'claude-accounts': 'Acme Corp' }}
          />
          <LiveRuntimeCard type="codex" model="gpt-5-codex" effort="medium" models={[]} />
          <LiveRuntimeCard type="opencode" ready={false} connectSlot={openCodeConnect()} />
          <LiveRuntimeCard
            type="codex"
            expanded
            model="gpt-5-codex"
            effort="medium"
            models={[]}
            reconnect={{ kind: 'login', onOpen: () => {} }}
          />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
