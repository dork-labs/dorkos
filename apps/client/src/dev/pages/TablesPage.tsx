import { PlaygroundPageLayout } from '../PlaygroundPageLayout';
import { TABLES_SECTIONS } from '../playground-registry';
import { TablesShowcases } from '../showcases/TablesShowcases';

/** Data tables showcase page for the dev playground. */
export function TablesPage() {
  return (
    <PlaygroundPageLayout
      title="Tables"
      description="Table primitives and data tables — sorting, selection, empty states, and domain-specific examples."
      sections={TABLES_SECTIONS}
    >
      <TablesShowcases />
    </PlaygroundPageLayout>
  );
}
