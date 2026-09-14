import { lazy, Suspense, useState } from 'react';
import { CanvasMarkdownContent } from '@/layers/features/canvas/ui/CanvasMarkdownContent';
import { Button } from '@/layers/shared/ui';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import {
  MARKDOWN_READING_SAMPLE,
  MARKDOWN_IMAGE_SAMPLE,
  MARKDOWN_NARROW_SAMPLE,
  MARKDOWN_FRONTMATTER_SAMPLE,
} from '../mock-samples/markdown';

// Match production: the heavy editor and its CSS arrive only when needed.
const BlintzCanvas = lazy(() =>
  import('@/layers/features/canvas/ui/BlintzCanvas').then((module) => ({
    default: module.BlintzCanvas,
  }))
);

function EditableDocument() {
  const [value, setValue] = useState(
    '## Make it your own\n\nSelect a few words to format them, or type / on a new line.\n\n- Keep a thought\n- Add another\n\n' +
      MARKDOWN_IMAGE_SAMPLE
  );
  const [editable, setEditable] = useState(true);
  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setEditable((current) => !current)}>
          {editable ? 'Read document' : 'Edit document'}
        </Button>
        <span className="text-muted-foreground text-xs">
          Switch modes without losing your draft.
        </span>
      </div>
      <div data-testid="markdown-editing-surface" className="bg-background min-w-0 rounded-lg">
        <BlintzCanvas value={value} editable={editable} onChange={setValue} />
      </div>
      <details className="mt-3">
        <summary className="text-muted-foreground cursor-pointer text-sm">Markdown source</summary>
        <pre
          data-testid="markdown-source"
          className="bg-muted mt-2 overflow-auto rounded-lg p-4 font-mono text-xs whitespace-pre-wrap"
        >
          {value}
        </pre>
      </details>
    </>
  );
}

/** Real editor fixtures for visual review and browser regression checks. */
export function MarkdownShowcases() {
  return (
    <Suspense fallback={<p className="text-muted-foreground text-sm">Loading editor…</p>}>
      <PlaygroundSection
        title="Markdown reading"
        description="Headings, marks, nested lists, tasks, quotes, code, tables, and math. The app theme controls every color."
      >
        <ShowcaseDemo responsive>
          <div data-testid="markdown-reading-surface" className="bg-background min-w-0 rounded-lg">
            <BlintzCanvas value={MARKDOWN_READING_SAMPLE} editable={false} />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>
      <PlaygroundSection
        title="Markdown canvas"
        description="The complete generated-document view used by a session, with its real canvas spacing and scrolling."
      >
        <ShowcaseDemo>
          <div
            data-testid="markdown-canvas-surface"
            className="bg-background h-[480px] min-w-0 overflow-auto rounded-lg"
          >
            <CanvasMarkdownContent
              documentId="playground-markdown-generated"
              content={{ type: 'markdown', content: MARKDOWN_READING_SAMPLE }}
              onContentChange={() => {}}
            />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>
      <PlaygroundSection
        title="Markdown editing"
        description="A live draft with formatting controls and the markdown it produces."
      >
        <ShowcaseDemo>
          <EditableDocument />
        </ShowcaseDemo>
      </PlaygroundSection>
      <PlaygroundSection
        title="Markdown narrow panel"
        description="Wrapped text and independently scrolling code and tables at phone width."
      >
        <ShowcaseDemo>
          <div
            data-testid="markdown-narrow-surface"
            className="bg-background w-full max-w-[360px] min-w-0 rounded-lg"
          >
            <BlintzCanvas value={MARKDOWN_NARROW_SAMPLE} editable={false} />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>
      <PlaygroundSection
        title="Markdown frontmatter"
        description="Document metadata stays separate from the body."
      >
        <ShowcaseDemo>
          <BlintzCanvas value={MARKDOWN_FRONTMATTER_SAMPLE} editable={false} />
        </ShowcaseDemo>
      </PlaygroundSection>
      <PlaygroundSection
        title="Markdown empty document"
        description="A quiet starting point that responds to typing and slash commands."
      >
        <ShowcaseDemo>
          <BlintzCanvas value="" editable />
        </ShowcaseDemo>
      </PlaygroundSection>
    </Suspense>
  );
}
