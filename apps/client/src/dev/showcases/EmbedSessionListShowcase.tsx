/**
 * The Obsidian embed's roster, in the Dev Playground.
 *
 * Its own module for the reason `SessionSwitcherShowcases` is: `SidebarShowcases`
 * is at its 500-line ceiling, and a showcase is the cheapest thing to move out
 * of it.
 *
 * @module dev/showcases/EmbedSessionListShowcase
 */
import { useState } from 'react';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { EmbedSessionList } from '@/layers/features/session-list';
import { GROUPED_SESSIONS, MOCK_SESSIONS } from './session-list-fixtures';

/**
 * The Obsidian embed's roster, at the width its drawer actually is.
 *
 * **This showcase is the only way to see that surface without a vault.** The
 * embed runs inside Obsidian through `DirectTransport`, so no browser test and
 * no screenshot of the cockpit shows it; mounted here at `w-80` — the width of
 * the drawer in `App.tsx` — it is at least the real component at the real size,
 * in both themes.
 */
export function EmbedSessionListShowcase() {
  const [activeId, setActiveId] = useState<string | null>(MOCK_SESSIONS[0].id);

  return (
    <PlaygroundSection
      title="EmbedSessionList"
      description="The Obsidian embed's roster, in the shared sidebar row grammar (DOR-1080)."
    >
      <ShowcaseLabel>Grouped list — 320px, the embed drawer&apos;s width</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="bg-sidebar h-80 w-80 overflow-hidden rounded-lg">
          <EmbedSessionList
            activeSessionId={activeId}
            groupedSessions={GROUPED_SESSIONS}
            onSessionClick={setActiveId}
            onForkSession={() => {}}
            onRenameSession={() => {}}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Empty state</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="bg-sidebar h-40 w-80 overflow-hidden rounded-lg">
          <EmbedSessionList activeSessionId={null} groupedSessions={[]} onSessionClick={() => {}} />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
