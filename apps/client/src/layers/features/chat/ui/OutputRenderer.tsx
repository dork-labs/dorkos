import { lazy, Suspense, useState } from 'react';
import { JsonView, darkStyles, collapseAllNested } from 'react-json-view-lite';
import 'react-json-view-lite/dist/index.css';
import Ansi from 'ansi-to-react';
import { classifyContent } from '@/layers/shared/lib';
import { cn } from '@/layers/shared/lib';

const DiffViewer = lazy(() => import('react-diff-viewer-continued'));

/**
 * Custom JSON tree styles tuned to the DorkOS neutral gray dark palette.
 *
 * Spreads `darkStyles` to inherit all structural class names (indentation,
 * icon sizing, boolean flags) then replaces the color-producing classes with
 * Tailwind utilities that resolve through the design-system CSS variables.
 *
 * Color mapping:
 * - Container: transparent, inherits surrounding card background
 * - Keys: `text-muted-foreground` — label tone, consistent with metadata
 * - Strings: `text-foreground` — primary content, full legibility
 * - Numbers: `text-blue-400` — distinct from text, calm accent
 * - Booleans: `text-amber-400` — warm accent, visually separate from numbers
 * - Null/undefined: `text-muted-foreground italic` — de-emphasized absent values
 * - Punctuation/brackets: `text-muted-foreground` — structure recedes behind data
 * - Expand/collapse icons: `text-muted-foreground` — affordance without distraction
 */
const dorkosJsonStyles = {
  ...darkStyles,
  container: 'bg-transparent text-xs font-mono leading-relaxed',
  label: 'text-muted-foreground font-medium mr-1',
  clickableLabel: 'text-muted-foreground font-medium mr-1 cursor-pointer',
  nullValue: 'text-muted-foreground italic',
  undefinedValue: 'text-muted-foreground italic',
  stringValue: 'text-foreground',
  booleanValue: 'text-amber-400',
  numberValue: 'text-blue-400',
  otherValue: 'text-muted-foreground',
  punctuation: 'text-muted-foreground',
  collapseIcon: 'text-muted-foreground',
  expandIcon: 'text-muted-foreground',
  collapsedContent: 'text-muted-foreground',
};

/** Maximum characters before truncation (~5KB). */
const TRUNCATE_THRESHOLD = 5120;

interface EditInput {
  old_string?: string;
  new_string?: string;
}

/**
 * Attempt to parse the Edit tool input JSON and extract old/new strings.
 * Returns null if parsing fails or required keys are absent.
 */
function parseEditInput(input: string): EditInput | null {
  try {
    const parsed: unknown = JSON.parse(input);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      ('old_string' in parsed || 'new_string' in parsed)
    ) {
      return parsed as EditInput;
    }
    return null;
  } catch {
    return null;
  }
}

interface OutputWrapperProps {
  /** Rendered output content. */
  children: React.ReactNode;
  /** Raw string for truncation logic. */
  rawContent: string;
  /** Whether this content type supports the raw/formatted toggle. */
  supportsRawToggle: boolean;
  /** Whether raw view is currently active. */
  isRaw: boolean;
  /** Called when user switches between raw and formatted. */
  onToggleRaw: () => void;
}

/**
 * Shared chrome around rendered output: truncation expand button and
 * the Raw / Formatted toggle for content types that support it.
 */
function OutputWrapper({
  children,
  rawContent,
  supportsRawToggle,
  isRaw,
  onToggleRaw,
}: OutputWrapperProps) {
  const [showFull, setShowFull] = useState(false);
  const isTruncated = rawContent.length > TRUNCATE_THRESHOLD;
  // Truncation only applies when in raw view — structured views handle their own overflow
  const displayRaw =
    isTruncated && !showFull ? rawContent.slice(0, TRUNCATE_THRESHOLD) : rawContent;

  return (
    <div className="space-y-1">
      {supportsRawToggle && (
        <div className="flex justify-end">
          <button
            onClick={onToggleRaw}
            className="text-muted-foreground hover:text-foreground text-xs underline"
          >
            {isRaw ? 'Formatted' : 'Raw'}
          </button>
        </div>
      )}

      {isRaw ? (
        <>
          <pre className="max-h-64 overflow-y-auto text-xs whitespace-pre-wrap">{displayRaw}</pre>
          {isTruncated && !showFull && (
            <button
              onClick={() => setShowFull(true)}
              className="text-muted-foreground hover:text-foreground text-xs underline"
            >
              Show full output ({(rawContent.length / 1024).toFixed(1)}KB)
            </button>
          )}
        </>
      ) : (
        children
      )}
    </div>
  );
}

interface EditDiffOutputProps {
  /** Original content (old_string from Edit tool input). */
  oldValue: string;
  /** New content (new_string from Edit tool input). */
  newValue: string;
  /** Raw fallback if diff viewer fails to render. */
  rawContent: string;
}

/**
 * Lazy-loaded unified diff view for Edit tool results using
 * react-diff-viewer-continued. Falls back to plain text while loading.
 */
function EditDiffOutput({ oldValue, newValue, rawContent }: EditDiffOutputProps) {
  return (
    <Suspense
      fallback={
        <pre className="max-h-64 overflow-y-auto text-xs whitespace-pre-wrap">{rawContent}</pre>
      }
    >
      <DiffViewer
        oldValue={oldValue}
        newValue={newValue}
        splitView={false}
        useDarkTheme
        hideLineNumbers
        showDiffOnly
        extraLinesSurroundingDiff={2}
        styles={{
          variables: {
            dark: {
              // Transparent so the diff inherits the tool call card background
              diffViewerBackground: 'transparent',
              // Added lines: subtle green tint matching Tailwind green-500/10 & green-300
              addedBackground: 'rgba(34, 197, 94, 0.1)',
              addedColor: 'rgb(134, 239, 172)',
              addedGutterBackground: 'rgba(34, 197, 94, 0.08)',
              wordAddedBackground: 'rgba(34, 197, 94, 0.2)',
              // Removed lines: subtle red tint matching Tailwind red-500/10 & red-300
              removedBackground: 'rgba(239, 68, 68, 0.1)',
              removedColor: 'rgb(252, 165, 165)',
              removedGutterBackground: 'rgba(239, 68, 68, 0.08)',
              wordRemovedBackground: 'rgba(239, 68, 68, 0.2)',
              // Neutral gutter matches DorkOS dark muted background (hsl 0 0% 9%)
              gutterBackground: 'hsl(0 0% 9%)',
              gutterBackgroundDark: 'hsl(0 0% 7%)',
              gutterColor: 'hsl(0 0% 40%)',
            },
          },
        }}
      />
    </Suspense>
  );
}

interface OutputRendererProps {
  /** Raw tool output string. */
  content: string;
  /** Name of the tool that produced this output. */
  toolName: string;
  /** JSON-encoded tool input (used by Edit tool diff rendering). */
  input?: string;
}

/**
 * Renders tool output with content-type-appropriate formatting.
 *
 * - JSON → collapsible tree (react-json-view-lite)
 * - ANSI → styled terminal output (ansi-to-react)
 * - Edit tool → unified diff (react-diff-viewer-continued, lazy-loaded)
 * - Plain text → monospace `<pre>`
 *
 * All types support 5KB truncation with a one-way expand button.
 * JSON and ANSI additionally offer a Raw / Formatted toggle.
 */
export function OutputRenderer({ content, toolName, input }: OutputRendererProps) {
  const [isRaw, setIsRaw] = useState(false);

  // Edit tool with parseable input gets special diff treatment before content classification
  if (toolName === 'Edit' && input) {
    const editInput = parseEditInput(input);
    if (editInput) {
      return (
        <EditDiffOutput
          oldValue={editInput.old_string ?? ''}
          newValue={editInput.new_string ?? ''}
          rawContent={content}
        />
      );
    }
  }

  const contentType = classifyContent(content);

  if (contentType === 'json') {
    let parsed: object | unknown[];
    try {
      // classifyContent already validated this is parseable JSON starting with { or [
      parsed = JSON.parse(content) as object | unknown[];
    } catch {
      // Defensive fallback — treat unparseable content as an empty object
      parsed = {};
    }

    return (
      <OutputWrapper
        rawContent={content}
        supportsRawToggle
        isRaw={isRaw}
        onToggleRaw={() => setIsRaw((v) => !v)}
      >
        <JsonView data={parsed} style={dorkosJsonStyles} shouldExpandNode={collapseAllNested} />
      </OutputWrapper>
    );
  }

  if (contentType === 'ansi') {
    return (
      <OutputWrapper
        rawContent={content}
        supportsRawToggle
        isRaw={isRaw}
        onToggleRaw={() => setIsRaw((v) => !v)}
      >
        <pre className={cn('max-h-64 overflow-y-auto text-xs whitespace-pre-wrap')}>
          <Ansi>{content}</Ansi>
        </pre>
      </OutputWrapper>
    );
  }

  // Plain text — no toggle, just truncation
  return (
    <OutputWrapper
      rawContent={content}
      supportsRawToggle={false}
      isRaw={true}
      onToggleRaw={() => {}}
    >
      {/* Plain text renders via the raw path inside OutputWrapper */}
      {null}
    </OutputWrapper>
  );
}
