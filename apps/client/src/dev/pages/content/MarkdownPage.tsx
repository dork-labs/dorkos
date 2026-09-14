import { PlaygroundPageLayout } from '../../PlaygroundPageLayout';
import { MARKDOWN_SECTIONS } from '../../playground-registry';
import { MarkdownShowcases } from '../../showcases/MarkdownShowcases';

/** The canvas editor under the same theme and styles as the running app. */
export function MarkdownPage() {
  return (
    <PlaygroundPageLayout
      title="Markdown"
      description="The real canvas editor. Switch the app theme to check every surface, or edit a document and inspect its markdown."
      sections={MARKDOWN_SECTIONS}
    >
      <MarkdownShowcases />
    </PlaygroundPageLayout>
  );
}
