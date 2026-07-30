import { PlaygroundPageLayout } from '../PlaygroundPageLayout';
import { ENTRY_ACTIONS_SECTIONS } from '../playground-registry';
import { EntryActionsShowcases } from '../showcases/EntryActionsShowcases';

/** Message action-surface showcase page for the dev playground. */
export function EntryActionsPage() {
  return (
    <PlaygroundPageLayout
      title="Entry Actions"
      description="The action surface every room message carries — the hover toolbar, its sticky rail, and how the pill holds its buttons across action counts, group positions, and both themes."
      sections={ENTRY_ACTIONS_SECTIONS}
    >
      <EntryActionsShowcases />
    </PlaygroundPageLayout>
  );
}
