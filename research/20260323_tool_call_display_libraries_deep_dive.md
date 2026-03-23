---
title: 'Tool Call Display Libraries Deep Dive: react-json-view-lite, ansi-to-react, react-diff-viewer-continued, Content-Type Detection'
date: 2026-03-23
type: external-best-practices
status: active
tags:
  [
    react-json-view-lite,
    ansi-to-react,
    react-diff-viewer-continued,
    content-type-detection,
    tool-calls,
    json-viewer,
    ansi,
    diff-viewer,
    tailwind,
    accessibility,
  ]
feature_slug: tool-call-display-overhaul
searches_performed: 14
sources_count: 22
---

# Tool Call Display Libraries: Deep Dive API Reference

## Prior Research Consulted

This report extends `research/20260323_tool_call_display_overhaul.md`, which covers the higher-level decision rationale, library comparisons, and implementation strategy. That report should be read first for context. This document provides granular API surfaces, exact version data, integration patterns, and edge cases.

---

## Research Summary

All three libraries are confirmed suitable for the tool call display overhaul. **react-json-view-lite** is at v2.5.0 (React 18+ only, ~829K weekly downloads), uses a fully CSS-class-based style API compatible with Tailwind, and has built-in ARIA tree view and keyboard navigation. **ansi-to-react** is at v6.2.6 (React 16–19 compatible, ~113K weekly downloads), supports 16/256/truecolor ANSI codes plus a `useClasses` mode for Tailwind-friendly class-based styling, and bundles TypeScript types. **react-diff-viewer-continued** is at v4.2.0 (React 15–19 compatible, last published within 24 hours of research, ~582K weekly downloads), has fully typed props, inline/split view modes, an extensive theme variables API, and should be lazy-loaded due to its @emotion dependency chain. Content-type detection for JSON vs ANSI vs plain text is well-solved by combining a fast heuristic guard (first-character check) with `JSON.parse()`, an ANSI regex from `ansi-regex`, and a performance-safe length cap.

---

## Key Findings

### 1. react-json-view-lite — Current Version & Stats

- **Current version**: 2.5.0 (last published ~6 months ago)
- **Weekly npm downloads**: ~829,010 (one source; another reports ~396,767 — both confirm solid adoption)
- **Bundle size**: ~8 KB min+gz (zero runtime dependencies)
- **React peer dependency**: React 18+ for v2.x; use 1.5.0 for React 16/17
- **TypeScript**: Bundled (no separate @types/ needed)
- **License**: MIT

### 2. ansi-to-react — Current Version & Stats

- **Current version**: 6.2.6 (last published ~10 days before research date, March 23 2026)
- **Weekly npm downloads**: ~113,533–157,971
- **Bundle size**: ~12.2 KB
- **React peer dependency**: `^16.3.2 || ^17.0.0 || ^18.0.0 || ^19.0.0` — React 19 explicitly supported
- **TypeScript**: Bundled at `lib/index.d.ts`
- **Runtime dependencies**: `anser@^2.3.2`, `escape-carriage@^1.3.1`, `linkify-it@^3.0.3`
- **License**: BSD-3-Clause (nteract organization)

### 3. react-diff-viewer-continued — Current Version & Stats

- **Current version**: 4.2.0 (last published ~1 day before research date)
- **Weekly npm downloads**: ~582,465 (from prior research)
- **Bundle size**: ~1.08 MB min (before tree-shaking; not tree-shakeable due to Emotion CSS-in-JS)
- **React peer dependency**: `^15.3.0 || ^16.0.0 || ^17.0.0 || ^18.0.0 || ^19.0.0` — React 19 explicitly supported
- **TypeScript**: Bundled at `lib/cjs/src/index.d.ts`
- **Runtime dependencies**: `@emotion/css`, `@emotion/react`, `classnames`, `diff@^8.0.3`, `js-yaml@^4.1.1`, `memoize-one@^6.0.0`
- **License**: MIT
- **Important note**: The published package on npm is the Aeolun fork. There are at least 4 active forks (amplication, Aeolun, SiebeVE, ralzinov) — the Aeolun fork at v4.2.0 is the most actively maintained as of March 2026.

---

## Detailed Analysis

### react-json-view-lite API

#### Complete Props Reference

```typescript
import { JsonView, allExpanded, collapseAllNested, defaultStyles, darkStyles } from 'react-json-view-lite';
import 'react-json-view-lite/dist/index.css';

<JsonView
  data={anyObject}                     // required — the JSON to render
  shouldExpandNode={allExpanded}       // optional — controls initial expansion
  clickToExpandNode={false}            // optional — enable click-on-label to expand
  beforeExpandChange={handler}         // optional — intercept expand/collapse
  compactTopLevel={false}              // optional — hide root-level expand button
  style={defaultStyles}                // optional — CSS class configuration
/>
```

#### shouldExpandNode Signature

```typescript
type ShouldExpandNode = (
  level: number, // 0 = root, 1 = first nested level, etc.
  value: unknown, // the object or array at this node
  field?: string // property name; undefined for array elements
) => boolean;
```

Built-in presets:

- `allExpanded` — always returns `true` (everything expanded)
- `collapseAllNested` — returns `true` only at `level === 0` (root expanded, everything else collapsed)

Custom example — expand only the first two levels:

```typescript
const expandTwoLevels: ShouldExpandNode = (level) => level < 2;
```

#### beforeExpandChange / NodeExpandingEvent

```typescript
interface NodeExpandingEvent {
  level: number;
  value: unknown; // the object/array being toggled
  field?: string; // property name (undefined for arrays)
  newExpandValue: boolean; // true = user is expanding, false = collapsing
}

// Return false to prevent the state change
const beforeExpandChange = (event: NodeExpandingEvent): boolean => {
  if (event.level > 3) return false; // prevent expanding beyond depth 3
  return true;
};
```

#### StyleProps — Complete Key List

All values are CSS class name strings. The library applies them via `className=`. This means they are fully compatible with Tailwind CSS utility classes.

```typescript
interface StyleProps {
  // Layout
  container: string; // outermost wrapper
  basicChildStyle: string; // each property row
  childFieldsContainer: string; // children ul element (v2: needs explicit margin/padding reset)

  // Expand/collapse controls
  collapseIcon: string; // ▾ button
  expandIcon: string; // ▸ button
  collapsedContent: string; // placeholder when collapsed (default: ...)

  // Labels
  label: string; // property key name
  clickableLabel: string; // key name when clickToExpandNode=true

  // Value type classes
  nullValue: string;
  undefinedValue: string;
  numberValue: string;
  stringValue: string;
  booleanValue: string;
  otherValue: string; // catch-all for remaining types

  // Syntax
  punctuation: string; // commas, brackets, braces

  // Behavioral flags (boolean, not class names)
  noQuotesForStringValues: boolean; // omit quotes around string values
  quotesForFieldNames: boolean; // add quotes around property names
  stringifyStringValues: boolean; // pass string values through JSON.stringify
}
```

#### Built-in Theme Objects

```typescript
import { defaultStyles, darkStyles } from 'react-json-view-lite';
// Both are fully populated StyleProps objects
// defaultStyles = light background preset
// darkStyles = dark background preset
```

#### Tailwind CSS Integration Pattern

The `style` prop accepts CSS class strings, so Tailwind utilities work directly. The key constraint: the CSS import (`react-json-view-lite/dist/index.css`) sets the default icon characters via `::after` pseudo-classes. To override those icons, you need to provide your own CSS class that overrides `content`.

```tsx
import { JsonView, collapseAllNested, defaultStyles } from 'react-json-view-lite';
import 'react-json-view-lite/dist/index.css';

// Tailwind-based dark theme for DorkOS (neutral gray)
const dorkosJsonStyles: StyleProps = {
  ...defaultStyles,
  container: 'font-mono text-xs rounded bg-transparent',
  label: 'text-muted-foreground',
  clickableLabel: 'text-muted-foreground cursor-pointer hover:text-foreground',
  stringValue: 'text-green-500 dark:text-green-400',
  numberValue: 'text-blue-500 dark:text-blue-400',
  booleanValue: 'text-purple-500 dark:text-purple-400',
  nullValue: 'text-zinc-500 italic',
  undefinedValue: 'text-zinc-500 italic',
  punctuation: 'text-zinc-500',
  collapseIcon: 'cursor-pointer text-muted-foreground hover:text-foreground mr-1',
  expandIcon: 'cursor-pointer text-muted-foreground hover:text-foreground mr-1',
  collapsedContent: 'text-muted-foreground',
};

// Usage
<JsonView
  data={toolCallInput}
  shouldExpandNode={collapseAllNested} // root open, deep nodes collapsed
  style={dorkosJsonStyles}
/>;
```

**v2 migration note**: When upgrading to v2, add this to your global CSS to fix a layout regression:

```css
.child-fields-container {
  margin: 0;
  padding: 0;
}
```

#### Keyboard Navigation & Accessibility

- **Arrow keys**: Navigate between sibling nodes and into/out of nested levels
- **Space** key: No longer triggers expand/collapse in v2 (changed from v1)
- **ARIA pattern**: Implements W3C TreeView pattern — uses semantic `<ul>` elements with `role="tree"` and `role="treeitem"`
- **aria-label customization**: Via `ariaLabels` prop (not in `StyleProps` but a top-level prop):
  ```typescript
  ariaLabels={{ collapseJson: 'collapse', expandJson: 'expand' }}
  ```
- The `beforeExpandChange` callback is called on both click and keyboard events, providing a unified hook for access control

---

### ansi-to-react API

#### Complete Props Reference

```typescript
import Ansi from 'ansi-to-react';

<Ansi
  useClasses={false}      // optional — use CSS classes instead of inline styles
  linkify={true}          // optional — auto-detect and linkify URLs (uses linkify-it dep)
>
  {'\u001b[34mblue text\u001b[0m'}
</Ansi>
```

The component takes children as its primary input (the ANSI string). There are no required props beyond children.

#### useClasses Mode — Tailwind Integration Path

By default, `ansi-to-react` applies inline `style` attributes (`style="color: blue"`). This conflicts with Tailwind's utility-first approach and does not respect `dark:` variants.

When `useClasses={true}`, the component applies CSS class names in the format `ansi-[color]-[fg|bg]`:

```tsx
// With useClasses=true, output looks like:
<span className="ansi-blue-fg">blue text</span>
<span className="ansi-red-bg">red background</span>
<span className="ansi-bright-green-fg">bright green</span>
```

You must then define those classes in your CSS. For DorkOS, this can be done in a single `@layer utilities` block in your Tailwind config:

```css
/* In your global CSS file */
@layer utilities {
  /* Standard 8 colors - foreground */
  .ansi-black-fg {
    color: rgb(0 0 0);
  }
  .ansi-red-fg {
    color: rgb(205 49 49);
  }
  .ansi-green-fg {
    color: rgb(13 188 121);
  }
  .ansi-yellow-fg {
    color: rgb(229 229 16);
  }
  .ansi-blue-fg {
    color: rgb(36 114 200);
  }
  .ansi-magenta-fg {
    color: rgb(188 63 188);
  }
  .ansi-cyan-fg {
    color: rgb(17 168 205);
  }
  .ansi-white-fg {
    color: rgb(229 229 229);
  }

  /* Bright variants */
  .ansi-bright-black-fg {
    color: rgb(102 102 102);
  }
  .ansi-bright-red-fg {
    color: rgb(241 76 76);
  }
  .ansi-bright-green-fg {
    color: rgb(35 209 139);
  }
  .ansi-bright-yellow-fg {
    color: rgb(245 245 67);
  }
  .ansi-bright-blue-fg {
    color: rgb(59 142 234);
  }
  .ansi-bright-magenta-fg {
    color: rgb(214 112 214);
  }
  .ansi-bright-cyan-fg {
    color: rgb(41 184 219);
  }
  .ansi-bright-white-fg {
    color: rgb(229 229 229);
  }

  /* Standard 8 colors - background */
  .ansi-black-bg {
    background-color: rgb(0 0 0);
  }
  .ansi-red-bg {
    background-color: rgb(205 49 49);
  }
  /* ... etc */

  /* Text formatting */
  .ansi-bold {
    font-weight: 700;
  }
  .ansi-italic {
    font-style: italic;
  }
  .ansi-underline {
    text-decoration: underline;
  }
  .ansi-dim {
    opacity: 0.5;
  }
}
```

The color values above match VS Code's built-in terminal theme, which is the visual standard most developers expect for terminal output.

#### ANSI Code Support

The `ansi-to-react` package delegates ANSI parsing to `anser` (its main dependency). Supported:

| Code Type                  | SGR Params                        | Notes                                    |
| -------------------------- | --------------------------------- | ---------------------------------------- |
| Standard foreground colors | `\x1b[30m`–`\x1b[37m`             | 8 standard colors                        |
| Bright foreground colors   | `\x1b[90m`–`\x1b[97m`             | 8 bright variants                        |
| Standard background colors | `\x1b[40m`–`\x1b[47m`             | 8 standard colors                        |
| Bright background colors   | `\x1b[100m`–`\x1b[107m`           | 8 bright variants                        |
| 256-color foreground       | `\x1b[38;5;{n}m`                  | Full 256-color palette                   |
| 256-color background       | `\x1b[48;5;{n}m`                  | Full 256-color palette                   |
| Truecolor (24-bit)         | `\x1b[38;2;r;g;bm`                | RGB inline styles                        |
| Bold                       | `\x1b[1m`                         | Rendered as `font-weight: bold`          |
| Italic                     | `\x1b[3m`                         | Rendered as `font-style: italic`         |
| Underline                  | `\x1b[4m`                         | Rendered as `text-decoration: underline` |
| Dim                        | `\x1b[2m`                         | Rendered as reduced opacity              |
| Reset                      | `\x1b[0m` or `\x1b[m`             | Resets all attributes                    |
| URL hyperlinks             | `\x1b]8;;URL\x07text\x1b]8;;\x07` | Via linkify-it                           |

**Not supported** (by design — not a terminal emulator):

- Cursor positioning (`\x1b[{row};{col}H`, `\x1b[A/B/C/D`)
- Screen clearing (`\x1b[2J`)
- Alternate screen buffer (`\x1b[?1049h/l`)
- Mouse tracking
- Carriage return / terminal control sequences

These omissions are appropriate for tool call output rendering — it's captured command output, not a live PTY.

#### Known Limitations

1. **Very long lines with many color changes**: Each color segment becomes a separate `<span>`. In extreme cases (e.g., a 10,000-char line with 500 color transitions), this produces excessive DOM nodes. In practice, tool call output rarely hits this limit.
2. **Carriage-return-based progress lines** (`\r` overwrite pattern): The `escape-carriage` dependency handles CR but may not perfectly reproduce the visual overwrite behavior in all cases. Pnpm install progress bars (`\r` + space overwrite) may display oddly.
3. **Inline styles in `useClasses=false` mode**: Cannot be overridden with Tailwind dark-mode variants. Prefer `useClasses={true}` for DorkOS.
4. **No React 19 explicit docs**: But peer deps explicitly include `^19.0.0`, so it is confirmed compatible.

---

### react-diff-viewer-continued API

#### Complete Props Reference (v4.2.0)

```typescript
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';

<ReactDiffViewer
  // Core content
  oldValue={string | object}          // required — previous content
  newValue={string | object}          // required — new content

  // View mode
  splitView={true}                    // false = inline/unified mode
  compareMethod={DiffMethod.CHARS}    // diff algorithm

  // Display options
  hideLineNumbers={false}
  disableWordDiff={false}
  showDiffOnly={true}                 // only changed lines + context
  extraLinesSurroundingDiff={3}       // context lines around changes

  // Theming
  useDarkTheme={false}
  styles={customStylesObject}         // deep partial override

  // Column headers
  leftTitle="Before"                  // used in split view and as only title in inline
  rightTitle="After"                  // split view only; ignored in inline mode

  // Summary
  hideSummary={false}
  summary="3 changes"                 // string or ReactElement

  // Syntax highlighting
  renderContent={(content) => <span>{content}</span>}

  // Line interaction
  onLineNumberClick={(id, event) => {}}
  highlightLines={['L-1', 'R-3']}    // L- prefix = left, R- = right

  // Performance
  infiniteLoading={{ pageSize: 200, containerHeight: 600 }}
  loadingElement={() => <div>Loading...</div>}
  linesOffset={0}                     // starting line number

  // CSP
  nonce="random-nonce-string"
/>
```

#### DiffMethod Enum — All Values

```typescript
enum DiffMethod {
  CHARS = 'diffChars', // character-level (default)
  WORDS = 'diffWords', // word-level
  WORDS_WITH_SPACE = 'diffWordsWithSpace', // words including whitespace
  LINES = 'diffLines', // line-level
  TRIMMED_LINES = 'diffTrimmedLines', // line-level with trimming
  SENTENCES = 'diffSentences', // sentence-level
  CSS = 'diffCss', // CSS-aware diffing
  JSON = 'diffJson', // up to 100x faster for JSON objects
  YAML = 'diffYaml', // optimized for YAML strings
}
```

For the `Edit` tool call use case, use `DiffMethod.CHARS` (default) to highlight the exact characters that changed within a line — this is what git diff and GitHub PR reviews show and is most familiar to developers.

#### Styles Prop — Complete Theme Variables

```typescript
interface StyleVariables {
  // Backgrounds
  diffViewerBackground: string;
  addedBackground: string;      // light default: '#e6ffed'
  removedBackground: string;    // light default: '#ffeef0'
  wordAddedBackground: string;  // light default: '#acf2bd'
  wordRemovedBackground: string; // light default: '#fdb8c0'
  highlightBackground: string;  // light default: '#fffbdd'
  codeFoldBackground: string;

  // Text colors
  diffViewerColor: string;
  addedColor: string;
  removedColor: string;

  // Gutter (line number column)
  gutterBackground: string;
  gutterBackgroundDark: string;
  highlightGutterBackground: string;
  addedGutterBackground: string;
  removedGutterBackground: string;
  gutterColor: string;
  addedGutterColor: string;
  removedGutterColor: string;

  // Title row
  diffViewerTitleBackground: string;
  diffViewerTitleColor: string;
  diffViewerTitleBorderColor: string;

  // Misc
  codeFoldContentColor: string;
  emptyLineBackground: string;
}

// Dark theme defaults
const darkThemeVariables: StyleVariables = {
  diffViewerBackground: '#2e303c',
  addedBackground: '#044B53',
  removedBackground: '#632F34',
  wordAddedBackground: '#055d67',
  wordRemovedBackground: '#7d383f',
  // ...
};

// Usage
<ReactDiffViewer
  styles={{
    variables: {
      dark: {
        diffViewerBackground: 'transparent',
        addedBackground: 'rgba(40, 200, 80, 0.1)',
        removedBackground: 'rgba(255, 80, 80, 0.1)',
        wordAddedBackground: 'rgba(40, 200, 80, 0.2)',
        wordRemovedBackground: 'rgba(255, 80, 80, 0.2)',
      },
      light: {
        diffViewerBackground: 'transparent',
        addedBackground: '#f0fff4',
        removedBackground: '#fff5f5',
      },
    },
  }}
  useDarkTheme={resolvedTheme === 'dark'}
/>
```

The `styles` prop also accepts element-level style overrides, but the variables system is the primary theming mechanism for DorkOS usage.

#### Inline (Unified) Mode vs Split Mode

```tsx
// INLINE MODE (recommended for chat UI)
<ReactDiffViewer
  splitView={false}           // the key prop
  leftTitle="Changes"         // only leftTitle is used in inline mode
  hideLineNumbers={true}      // saves horizontal space in narrow cards
  oldValue={toolCall.input.old_string}
  newValue={toolCall.input.new_string}
  compareMethod={DiffMethod.CHARS}
/>

// SPLIT MODE (not recommended for chat UI)
<ReactDiffViewer
  splitView={true}            // default
  leftTitle="Before"
  rightTitle="After"
  // ...
/>
```

In inline mode, removed lines appear with a red `-` prefix and added lines with a green `+` prefix, stacked vertically — identical to `git diff --unified` output. This is the correct choice for the narrow confines of a tool call card.

#### renderContent — Syntax Highlighting Integration

```typescript
// Type signature
renderContent: (content: string) => JSX.Element;

// Example with Shiki (async — must pre-initialize)
const DiffWithHighlighting = ({ oldValue, newValue }: { oldValue: string; newValue: string }) => {
  const { resolvedTheme } = useTheme();

  return (
    <ReactDiffViewer
      oldValue={oldValue}
      newValue={newValue}
      splitView={false}
      useDarkTheme={resolvedTheme === 'dark'}
      renderContent={(content) => (
        <code
          dangerouslySetInnerHTML={{
            __html: shikiHighlighter?.codeToHtml(content, {
              lang: 'typescript',
              theme: 'github-dark',
            }) ?? content,
          }}
        />
      )}
    />
  );
};
```

For the Edit tool in DorkOS's context, the file extension is available from `toolCall.input.file_path`, making language detection accurate.

#### Lazy Loading (Required for Bundle Size)

Because `react-diff-viewer-continued` uses `@emotion/css` and `@emotion/react`, the full bundle cannot be tree-shaken at the component level. The only effective mitigation is React.lazy:

```typescript
// DiffViewer.tsx — wrapper component for lazy loading
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';

interface DiffViewerProps {
  oldValue: string;
  newValue: string;
  useDarkTheme: boolean;
}

export default function DiffViewer({ oldValue, newValue, useDarkTheme }: DiffViewerProps) {
  return (
    <ReactDiffViewer
      oldValue={oldValue}
      newValue={newValue}
      splitView={false}
      hideLineNumbers={true}
      useDarkTheme={useDarkTheme}
      compareMethod={DiffMethod.CHARS}
      styles={{
        variables: {
          dark: {
            diffViewerBackground: 'transparent',
            addedBackground: 'rgba(40, 200, 80, 0.08)',
            removedBackground: 'rgba(255, 80, 80, 0.08)',
            wordAddedBackground: 'rgba(40, 200, 80, 0.15)',
            wordRemovedBackground: 'rgba(255, 80, 80, 0.15)',
          },
          light: {
            diffViewerBackground: 'transparent',
            addedBackground: '#f0fff4',
            removedBackground: '#fff5f5',
            wordAddedBackground: '#c6f6d5',
            wordRemovedBackground: '#fed7d7',
          },
        },
      }}
    />
  );
}

// In the parent ToolCallCard:
const LazyDiffViewer = lazy(() => import('./DiffViewer'));

// Usage with Suspense fallback
{toolCall.name === 'Edit' && toolCall.isExpanded && (
  <Suspense
    fallback={
      <pre className="font-mono text-xs text-muted-foreground whitespace-pre-wrap">
        {toolCall.input.old_string}
      </pre>
    }
  >
    <LazyDiffViewer
      oldValue={toolCall.input.old_string ?? ''}
      newValue={toolCall.input.new_string ?? ''}
      useDarkTheme={resolvedTheme === 'dark'}
    />
  </Suspense>
)}
```

The Suspense fallback shows the `old_string` as plain text — meaningful content while the diff library loads, not a spinner.

---

### Content-Type Detection Patterns

#### The Detection Challenge

Tool call output strings need to be classified into one of three rendering paths:

1. **ANSI terminal output** → render with `ansi-to-react`
2. **JSON** → render with `react-json-view-lite`
3. **Plain text** → render with `TruncatedOutput` (existing component)

A fourth category — file content with syntax highlighting — is detected not from the content string but from the tool name (`Read`, `Write`) and the `file_path` input parameter.

#### Authoritative ANSI Detection

The Chalk ecosystem's `ansi-regex` package is the reference implementation for ANSI escape code detection, tested against 200+ codes across VT52, ANSI-compatible, VT100, urxvt, and other terminal standards. However, adding a dependency just for detection is unnecessary. The core pattern is:

```typescript
// The pattern used by ansi-regex (simplified for detection use):
const ANSI_ESCAPE_RE =
  /[\u001b\u009b][\[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/;

// For a fast "has ANSI" check (not stripping):
function hasAnsiEscapes(str: string): boolean {
  // Quick pre-check: the ESC character must be present
  if (!str.includes('\u001b') && !str.includes('\u009b')) return false;
  return ANSI_ESCAPE_RE.test(str);
}
```

The two-stage approach (string include check + regex) is important for performance: `String.prototype.includes` is an order of magnitude faster than a regex scan on long strings with no ANSI codes.

**Edge cases the simple `\x1b\[` pattern misses:**

- **OSC sequences**: `\u001b]8;;URL\u0007` (terminal hyperlinks — NOT `\u001b[`)
- **C1 control codes**: `\u009b` as a single-byte CSI equivalent
- **Old-style codes without `[`**: `\u001b(B` (charset designation), `\u001bM` (scroll up)
- **Non-standard manufacturer codes**: Codes that don't end with `m` (e.g., window title sequences `\u001b]0;title\u0007`)

For DorkOS's tool output use case, the simple `\x1b[` detection is sufficient because bash/command output almost exclusively uses SGR codes (SGR = `\x1b[...m`). The more comprehensive pattern should be used if OSC hyperlinks or custom terminal codes might appear.

#### JSON Detection — Reliable Approach

The naive approach (`content.startsWith('{') && JSON.parse(content)`) works for well-formed JSON but has several pitfalls:

```typescript
// PITFALL 1: Legitimate strings that start with {
// "{ this is a prose sentence about configuration }" — not JSON
// Solution: require the trailing char to match

// PITFALL 2: JSON.parse on giant strings is slow
// A 500KB JSON string takes ~20ms to parse
// Solution: cap detection attempts at a size threshold

// PITFALL 3: JSON fragments / truncated JSON
// "{ \"key\": \"val..." — would have been JSON if not truncated
// Solution: accept failure gracefully; fall back to plain text

// PITFALL 4: Large numbers lose precision
// { "id": 9007199254740993 } — parsed incorrectly by JSON.parse
// Solution: for display-only purposes, this doesn't matter

// ROBUST JSON DETECTION
function detectJSON(content: string): boolean {
  const trimmed = content.trim();

  // Must start AND end with matching delimiters
  const isObject = trimmed.startsWith('{') && trimmed.endsWith('}');
  const isArray = trimmed.startsWith('[') && trimmed.endsWith(']');
  if (!isObject && !isArray) return false;

  // Performance guard: don't attempt to parse very large strings
  // (render as plain text instead — the user can still read it)
  if (trimmed.length > 100_000) return false;

  try {
    const parsed = JSON.parse(trimmed);
    // Additional guard: primitive JSON values ("true", "42", '"hello"') start/end
    // check above already excludes these since they don't start with { or [
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}
```

The key improvements over the naive approach:

1. **Require both start AND end delimiter match** — filters out prose that starts with `{` but has no closing `}`
2. **100KB size cap** — prevents parsing pathologically large strings during every render
3. **Post-parse type check** — `JSON.parse("null")` returns `null` (an object start/end check guards this, but the explicit check is defensive)

#### Handling Streaming / Partial JSON

During active streaming, tool inputs may be partially received. A partially-streamed JSON object like `{"key": "value", "other"` will fail `JSON.parse()` and correctly fall through to plain text rendering. This is the correct behavior — do not attempt to repair partial JSON for display purposes.

#### Complete Content Classifier

```typescript
type ContentType = 'ansi' | 'json' | 'plain';

function classifyContent(content: string): ContentType {
  // ANSI check first — terminal output is the most distinctive
  // Quick pre-check before regex for performance
  if (content.includes('\u001b') || content.includes('\u009b')) {
    const ANSI_RE = /[\u001b\u009b][\[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/;
    if (ANSI_RE.test(content)) return 'ansi';
  }

  // JSON check
  if (detectJSON(content)) return 'json';

  // Everything else
  return 'plain';
}

// detectJSON as defined above
function detectJSON(content: string): boolean {
  const trimmed = content.trim();
  const isObject = trimmed.startsWith('{') && trimmed.endsWith('}');
  const isArray = trimmed.startsWith('[') && trimmed.endsWith(']');
  if (!isObject && !isArray) return false;
  if (trimmed.length > 100_000) return false;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}
```

#### Edge Cases Table

| Input                           | Naïve Detection              | Correct Classification | Reason                                                         |
| ------------------------------- | ---------------------------- | ---------------------- | -------------------------------------------------------------- |
| `{ "key": "value" }`            | JSON                         | JSON                   | Normal case                                                    |
| `{ prose starting with brace }` | JSON (false positive)        | plain                  | Ends with `}` but not JSON                                     |
| `[1, 2, 3]`                     | JSON                         | JSON                   | Array at root                                                  |
| `\x1b[32mgreen\x1b[0m`          | plain                        | ansi                   | ESC char present                                               |
| `{"key": "val...` (truncated)   | throws                       | plain                  | JSON.parse throws → fallback                                   |
| `null`                          | JSON (null.startsWith fails) | plain                  | Correctly excluded by start/end check                          |
| `"hello"` (JSON string)         | plain                        | plain                  | Does not start with `{` or `[` — correct, render as plain text |
| `{ key: unquoted }`             | throws                       | plain                  | Invalid JSON → fallback                                        |
| `[...]` (10MB array)            | slow                         | plain                  | Size cap → skip parse                                          |
| `\u009b[0m` (C1 CSI)            | plain                        | ansi                   | C1 escape code detected                                        |

---

## Integration Blueprint for DorkOS ToolCallCard

### Installation

```bash
pnpm add react-json-view-lite ansi-to-react react-diff-viewer-continued
```

### File Structure

```
apps/client/src/layers/features/session/
├── components/
│   ├── ToolCallCard.tsx              # existing component — modified
│   ├── ToolCallOutput/
│   │   ├── index.ts                  # barrel
│   │   ├── AnsiOutput.tsx            # new — wraps ansi-to-react
│   │   ├── JsonOutput.tsx            # new — wraps react-json-view-lite
│   │   ├── DiffOutput.tsx            # new — lazy wrapper for react-diff-viewer-continued
│   │   └── PlainOutput.tsx           # existing TruncatedOutput rename/wrap
│   └── lib/
│       ├── classify-content.ts       # new — detectJSON + classifyContent
│       └── json-styles.ts            # new — dorkosJsonStyles constant
```

### AnsiOutput Component

```tsx
// AnsiOutput.tsx
import Ansi from 'ansi-to-react';

interface AnsiOutputProps {
  content: string;
}

export function AnsiOutput({ content }: AnsiOutputProps) {
  return (
    <div className="overflow-x-auto rounded bg-zinc-950 p-2">
      <pre className="m-0 font-mono text-xs">
        <Ansi useClasses>{content}</Ansi>
      </pre>
    </div>
  );
}
```

### JsonOutput Component

```tsx
// JsonOutput.tsx
import {
  JsonView,
  collapseAllNested,
  defaultStyles,
  darkStyles,
  type StyleProps,
} from 'react-json-view-lite';
import 'react-json-view-lite/dist/index.css';
import { useTheme } from 'next-themes';

interface JsonOutputProps {
  data: unknown;
  defaultExpanded?: boolean;
}

const lightJsonStyles: StyleProps = {
  ...defaultStyles,
  container: 'font-mono text-xs bg-transparent p-0',
  label: 'text-muted-foreground',
  clickableLabel: 'text-muted-foreground cursor-pointer hover:text-foreground transition-colors',
  stringValue: 'text-green-600',
  numberValue: 'text-blue-600',
  booleanValue: 'text-purple-600',
  nullValue: 'text-zinc-500 italic',
  undefinedValue: 'text-zinc-500 italic',
  punctuation: 'text-zinc-400',
  collapseIcon: 'cursor-pointer text-muted-foreground hover:text-foreground mr-1 select-none',
  expandIcon: 'cursor-pointer text-muted-foreground hover:text-foreground mr-1 select-none',
  collapsedContent: 'text-muted-foreground',
};

const darkJsonStyles: StyleProps = {
  ...darkStyles,
  container: 'font-mono text-xs bg-transparent p-0',
  label: 'text-muted-foreground',
  clickableLabel: 'text-muted-foreground cursor-pointer hover:text-foreground transition-colors',
  stringValue: 'text-green-400',
  numberValue: 'text-blue-400',
  booleanValue: 'text-purple-400',
  nullValue: 'text-zinc-500 italic',
  undefinedValue: 'text-zinc-500 italic',
  punctuation: 'text-zinc-600',
  collapseIcon: 'cursor-pointer text-muted-foreground hover:text-foreground mr-1 select-none',
  expandIcon: 'cursor-pointer text-muted-foreground hover:text-foreground mr-1 select-none',
  collapsedContent: 'text-muted-foreground',
};

export function JsonOutput({ data, defaultExpanded = false }: JsonOutputProps) {
  const { resolvedTheme } = useTheme();
  const styles = resolvedTheme === 'dark' ? darkJsonStyles : lightJsonStyles;

  return (
    <JsonView
      data={data}
      shouldExpandNode={defaultExpanded ? allExpanded : collapseAllNested}
      style={styles}
      clickToExpandNode
    />
  );
}
```

### Content Classifier

```typescript
// classify-content.ts
export type ContentType = 'ansi' | 'json' | 'plain';

const ANSI_RE = /[\u001b\u009b][\[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/;

function detectJSON(content: string): false | object {
  const trimmed = content.trim();
  const isObject = trimmed.startsWith('{') && trimmed.endsWith('}');
  const isArray = trimmed.startsWith('[') && trimmed.endsWith(']');
  if (!isObject && !isArray) return false;
  if (trimmed.length > 100_000) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null) return parsed as object;
    return false;
  } catch {
    return false;
  }
}

export function classifyContent(content: string): ContentType {
  if (content.includes('\u001b') || content.includes('\u009b')) {
    if (ANSI_RE.test(content)) return 'ansi';
  }
  if (detectJSON(content)) return 'json';
  return 'plain';
}

export function parseJSONContent(content: string): object | null {
  const result = detectJSON(content);
  return result === false ? null : result;
}
```

---

## Libraries Summary Table

| Library                       | Version | Weekly DLs | Min+gz   | React 19       | TS Bundled | Zero Deps     |
| ----------------------------- | ------- | ---------- | -------- | -------------- | ---------- | ------------- |
| `react-json-view-lite`        | 2.5.0   | ~829K      | ~8 KB    | No (18+ only)  | Yes        | Yes           |
| `ansi-to-react`               | 6.2.6   | ~113K      | ~12.2 KB | Yes (explicit) | Yes        | No (3 deps)   |
| `react-diff-viewer-continued` | 4.2.0   | ~582K      | ~1.08 MB | Yes (explicit) | Yes        | No (Emotion+) |

**React 19 note for react-json-view-lite**: The peer dependency says `^18.0.0`. In practice, React 19 is backward-compatible and the library should work — but it is not explicitly declared. Verify with `pnpm typecheck` after installation.

---

## Research Gaps and Limitations

- **react-json-view-lite exact bundle size**: Bundlephobia returned 403. The ~8 KB figure is from prior research and the library's self-description; it should be verified at bundlephobia.com before publishing in external docs.
- **react-diff-viewer-continued exact gzip size**: Bundlephobia similarly blocked. The ~1.08 MB figure is from prior research; actual gzip for v4.2.0 may differ slightly.
- **ansi-to-react useClasses class names for bold/underline**: The README shows the class format for colors (`ansi-blue-fg`) but does not explicitly list class names for formatting codes (bold, underline, dim). Testing with `useClasses={true}` is needed to confirm the actual class names emitted.
- **react-json-view-lite v2 + Tailwind CSS purging**: Tailwind's content scanning must include the library's source or the custom class names defined in the style prop. Since the class strings are defined in your own source files (not inside the library), Tailwind's standard content scan (`./src/**/*.{ts,tsx}`) will pick them up correctly — but this is worth confirming in the build output.
- **react-diff-viewer-continued dark mode blending**: The `diffViewerBackground: 'transparent'` override is untested against DorkOS's neutral gray design system. The Emotion-based inline styles may produce z-index or specificity conflicts with shadcn/ui's CSS variables. Integration testing required.

---

## Contradictions and Disputes

- **react-json-view-lite weekly downloads**: One source reports 829,010, another 396,767. Both are as-of March 2026 from different aggregators. Either figure confirms healthy adoption — this is not a concern.
- **react-diff-viewer-continued fork to use**: The npm package `react-diff-viewer-continued` points to the Aeolun fork (v4.2.0). The amplication fork also appears in search results but has a different release cadence. The Aeolun fork is the one to use — it is the canonical npm package and has the most recent release (published within 24 hours of research).
- **react-json-view-lite React 19 support**: The lib says `^18.0.0`. React 19 is source-compatible with React 18 for components not using removed APIs. Unless the library uses a deprecated API (`propTypes`, `defaultProps` on function components, string refs, legacy context), it will work. No evidence suggests it uses any of these.

---

## Search Methodology

- Searches performed: 14 WebSearch + 8 WebFetch calls
- Most productive: GitHub README fetches for direct API extraction
- Prior research extended: `research/20260323_tool_call_display_overhaul.md`
- Sources: npm search results, GitHub READMEs, bundlephobia (blocked), package.json files

---

## Sources and Evidence

- [react-json-view-lite — GitHub README](https://github.com/AnyRoad/react-json-view-lite/blob/release/README.md) — Complete API reference, StyleProps, shouldExpandNode
- [react-json-view-lite — npm](https://www.npmjs.com/package/react-json-view-lite) — v2.5.0, ~829K weekly downloads
- [react-json-view-lite — npmtrends](https://npmtrends.com/react-json-view-lite) — Download trend data
- [react-json-view-lite — Bundlephobia](https://bundlephobia.com/package/react-json-view-lite) — Bundle size reference
- [ansi-to-react — GitHub README](https://github.com/nteract/ansi-to-react/blob/master/README.md) — Props, useClasses mode, CSS class format
- [ansi-to-react — package.json](https://github.com/nteract/ansi-to-react/blob/master/package.json) — v6.0.10 source; peer deps, TypeScript
- [ansi-to-react — npm](https://www.npmjs.com/package/ansi-to-react) — v6.2.6, 12.2 KB bundle, ~113K downloads
- [ansi-to-react — Socket.dev](https://socket.dev/npm/package/ansi-to-react) — Security and maintenance analysis
- [react-diff-viewer-continued — Aeolun GitHub](https://github.com/Aeolun/react-diff-viewer-continued) — Active fork, README
- [react-diff-viewer-continued — package.json](https://github.com/Aeolun/react-diff-viewer-continued/blob/main/package.json) — v4.2.0, peer deps, TypeScript bundled
- [react-diff-viewer-continued — npm](https://www.npmjs.com/package/react-diff-viewer-continued?activeTab=versions) — Latest version, weekly downloads
- [react-diff-viewer-continued v3.4.0 — Bundlephobia](https://bundlephobia.com/package/react-diff-viewer-continued) — Bundle size reference
- [ansi-regex — GitHub, Chalk](https://github.com/chalk/ansi-regex) — Reference ANSI regex pattern, OSC sequences, VT100 edge cases
- [has-ansi — GitHub, Chalk](https://github.com/chalk/has-ansi) — ANSI detection utility
- [text-type-detection — GitHub, profullstack](https://github.com/profullstack/text-type-detection) — Multi-heuristic text type detection library
- [untruncate-json — GitHub, dphilipson](https://github.com/dphilipson/untruncate-json) — Handling partial JSON strings
- [React Diff Viewer — original](https://praneshravi.in/react-diff-viewer/) — Original library docs (for reference)
