/**
 * DorkOS names the app behind its dialogs and ⌘K commands (DOR-4282), drawn
 * with the real `ExtensionDialogOrigin` and `PaletteResultRow` and made-up apps.
 *
 * Its own file because `CommandPaletteShowcases.tsx` is past the 500-line limit.
 *
 * @module dev/showcases/AppOriginShowcases
 */
import { CalendarDays } from 'lucide-react';
import { Command, CommandGroup, CommandList } from '@/layers/shared/ui';
import {
  PaletteResultRow,
  type RankedRow as PaletteRankedRow,
  type SearchResult,
} from '@/layers/features/command-palette';
import { ExtensionDialogOrigin } from '@/layers/widgets/app-layout';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

type RankedRow = PaletteRankedRow<SearchResult>;

/** The icon name `registerCommand` gives a command that names none. */
const APP_ICON = 'puzzle';

/** A ⌘K command row, as the palette ranks it. */
function commandRow(
  id: string,
  label: string,
  icon: string,
  appName?: string,
  shortcut?: string
): RankedRow {
  const item: SearchResult['item'] = {
    id,
    name: label,
    type: 'feature',
    usageKey: null,
    lastActivityAt: null,
    waiting: false,
    demoted: false,
    scopes: [],
    data: { id, label, icon, action: id, appName, shortcut },
  };
  return {
    key: id,
    item: { item, matches: undefined },
    score: 1,
    signals: {} as RankedRow['signals'],
    demoted: false,
  };
}

const ROWS: RankedRow[] = [
  commandRow('settings', 'Settings', 'Settings', undefined, '⌘,'),
  commandRow('planner:plan-week', 'Plan this week', APP_ICON, 'Planner'),
  // Every app command carries its app's name, whatever its label says.
  commandRow('notes:open-settings', 'Open settings', 'Settings', 'Field Notes'),
  commandRow(
    'long:sync',
    'Sync everything now',
    APP_ICON,
    'A made-up app with a very long name that runs out of room'
  ),
];

const ROW_PROPS = {
  selectedCwd: null,
  selectedValue: '',
  onFeatureAction: () => {},
  onQuickAction: () => {},
  onGoToAgentActions: () => {},
  onRoomSelect: () => {},
  onSessionSelect: () => {},
  onCommandSelect: () => {},
  onPageSelect: () => {},
};

/** The strip over an app's dialog, and the app's name after its ⌘K commands. */
export function AppOriginShowcases() {
  return (
    <PlaygroundSection
      title="App names on dialogs and commands"
      description="DorkOS draws the app's name from its own record: a strip over every app dialog, and a muted name after every app command. DorkOS's own rows carry none."
    >
      <ShowcaseLabel>Dialog strip: an app icon, no icon (puzzle piece), a long name</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-col items-center gap-3" data-testid="app-dialog-origin">
          <ExtensionDialogOrigin name="Planner" icon={CalendarDays} />
          <ExtensionDialogOrigin name="Field Notes" />
          <ExtensionDialogOrigin name="A made-up app with a very long name that runs out of room on a phone" />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>⌘K rows: DorkOS’s own command, then three app commands</ShowcaseLabel>
      <ShowcaseDemo>
        <Command className="w-[min(32rem,100%)] rounded-lg border" shouldFilter={false}>
          <CommandList>
            <CommandGroup heading="Actions">
              {ROWS.map((row) => (
                <PaletteResultRow key={row.key} row={row} {...ROW_PROPS} />
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
