import { PlaygroundPageLayout } from '../PlaygroundPageLayout';
import { COMMAND_PALETTE_SECTIONS } from '../playground-registry';
import { CommandPaletteShowcases } from '../showcases/CommandPaletteShowcases';
import { AppOriginShowcases } from '../showcases/AppOriginShowcases';

/** Command palette component showcase page for the dev playground. */
export function CommandPalettePage() {
  return (
    <PlaygroundPageLayout
      title="Command Palette"
      description="Agent items, search highlighting, sub-menus, keyboard hints, and edge cases."
      sections={COMMAND_PALETTE_SECTIONS}
    >
      <CommandPaletteShowcases />
      <AppOriginShowcases />
    </PlaygroundPageLayout>
  );
}
