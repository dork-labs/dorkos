/**
 * Runtime-neutral contract for the DorkOS `control_ui` tool — its description
 * and input schema, the single source of truth both runtimes register against.
 *
 * The Claude Code adapter registers this contract as an in-process MCP tool
 * ({@link ../claude-code/mcp-tools/ui-tools}, session-bound so it emits real
 * `ui_command` events); the Codex adapter registers the SAME contract on its
 * scoped external `dorkos_ui` server ({@link ../codex/codex-ui-mcp-server}, a
 * session-less stub whose effect is produced downstream in the event-mapper).
 * Keeping the description and schema here — depending only on `zod` and the
 * shared schemas, never on a runtime SDK — guarantees byte-for-byte parity and
 * keeps the Codex module graph clear of the Claude SDK (ESLint confines
 * `@anthropic-ai/claude-agent-sdk` to `claude-code/`).
 *
 * ## Why the teaching is generated
 *
 * It used to be three hand-written lists that disagreed. The tool description
 * advertised 6 canvas content types, the `<ui_tools>` system-prompt block
 * advertised 10, the input schema's `content` hint advertised 6, and
 * `UiCanvasContentSchema` accepted 14 — so `mcp_app`, `file`, `model3d`, `csv`,
 * `browser` and `diff` were reachable and taught nowhere, and `apply_layout` was
 * a whole action nothing mentioned. A list nobody has to touch when the schema
 * changes is a list that goes stale, quietly, in the one place a model reads.
 *
 * So the NAMES come from the schemas — {@link canvasContentTypes} and
 * {@link uiActionNames} walk the two discriminated unions — and only the
 * per-variant sentence is written by hand, keyed by variant name in
 * {@link CANVAS_CONTENT_CATALOG} and {@link UI_ACTION_CATALOG}. A variant added
 * to the schema with no entry in its table is a `tsc` error (the tables are
 * total `Record`s over the union's own keys) and, if the types are bypassed, a
 * throw at IMPORT time — both catalogs are rendered into the two exported
 * constants below at module scope, so the module cannot even load with a
 * variant nothing teaches. `__tests__/ui-tool-contract.test.ts` holds the line from
 * the other side: it re-derives both sets from the schemas and asserts each
 * rendered surface names exactly those, no more and no fewer.
 *
 * @module services/runtimes/shared/ui-tool-contract
 */
import { z } from 'zod';
import { UiCanvasContentSchema, UiCommandSchema } from '@dorkos/shared/schemas';
import type { UiCanvasContent, UiCommand } from '@dorkos/shared/types';

/**
 * The only thing the catalog generators need from a discriminated union: its
 * variants, each an object whose shape carries the discriminant literal.
 *
 * Structural rather than a Zod type so a test can hand in a union of its own —
 * the 15th-variant case that proves an untaught variant fails rather than
 * shipping silently.
 */
export interface DiscriminatedUnionLike {
  readonly options: readonly { readonly shape: Record<string, unknown> }[];
}

/**
 * Read each variant's discriminant literal out of a discriminated union.
 *
 * @param union - The union to walk.
 * @param discriminator - The key every variant literals (`type`, `action`).
 * @returns The literals, in the order the union declares them.
 */
function variantLiterals(union: DiscriminatedUnionLike, discriminator: string): readonly string[] {
  return union.options.map((option, index) => {
    const field = option.shape[discriminator] as { value?: unknown } | undefined;
    const literal = field?.value;
    if (typeof literal !== 'string') {
      throw new Error(
        `ui-tool-contract: union variant ${index} has no string "${discriminator}" literal, ` +
          'so there is no name to teach it under.'
      );
    }
    return literal;
  });
}

/**
 * Every canvas content type the schema accepts, read off the schema itself.
 *
 * @param schema - The union to read. Defaults to the real one; tests pass their
 *   own to prove an unknown variant is refused rather than silently skipped.
 * @returns The `type` literals, in schema order.
 */
export function canvasContentTypes(
  schema: DiscriminatedUnionLike = UiCanvasContentSchema
): readonly string[] {
  return variantLiterals(schema, 'type');
}

/**
 * Every UI action the schema accepts, read off the schema itself.
 *
 * @param schema - The union to read. Defaults to the real one.
 * @returns The `action` literals, in schema order.
 */
export function uiActionNames(schema: DiscriminatedUnionLike = UiCommandSchema): readonly string[] {
  return variantLiterals(schema, 'action');
}

/** How one canvas content variant is taught. */
interface CanvasContentEntry {
  /** The object to pass, written the way an agent has to type it. */
  shape: string;
  /** One plain sentence: what it is for, plus whatever is easy to get wrong. */
  sentence: string;
}

/** How one UI action is taught. */
interface UiActionEntry {
  /** The arguments, or an empty string for an action that takes none. */
  args: string;
  /** One plain sentence: what it does for the person watching. */
  sentence: string;
}

/**
 * The hand-written half of the canvas catalog: one sentence per content type.
 *
 * Total over `UiCanvasContent['type']` on purpose — a 15th variant added to
 * `UiCanvasContentSchema` fails to compile here until somebody writes its
 * sentence, which is the whole point of the table.
 */
const CANVAS_CONTENT_CATALOG: Record<UiCanvasContent['type'], CanvasContentEntry> = {
  url: {
    shape: '{ type: "url", url: "https://…", title?: string }',
    sentence: 'A web page, shown in the embedded browser with navigation controls.',
  },
  markdown: {
    shape: '{ type: "markdown", content: "<markdown text>", title?: string, sourcePath?: string }',
    sentence:
      'Markdown you pass inline — the text goes in "content", not "markdown" or "text". Pass sourcePath when the markdown came from a file, so the person can edit it and have the edits saved back to that file; leave it out for markdown you wrote yourself, which then renders read-only.',
  },
  json: {
    shape: '{ type: "json", data: <any json value>, title?: string }',
    sentence: 'A JSON value, shown as a tree the person can expand and collapse.',
  },
  image: {
    shape:
      '{ type: "image", src: "<https url | data: URI | local file path>", title?: string, alt?: string }',
    sentence: 'A picture — the image goes in "src". Write an alt so it can be described out loud.',
  },
  pdf: {
    shape: '{ type: "pdf", src: "<https url | data: URI | local file path>", title?: string }',
    sentence: 'A PDF, with the same rules for "src" as an image.',
  },
  widget: {
    shape: '{ type: "widget", definition: <dorkos-ui widget document>, title?: string }',
    sentence:
      'A Tier-1 generative-UI widget, the same document you would put in a dorkos-ui fence (see <gen_ui>).',
  },
  mcp_app: {
    shape: '{ type: "mcp_app", serverName: string, uri: "ui://…", title?: string }',
    sentence:
      'An app one of your MCP servers publishes as a ui:// resource. DorkOS fetches it from that server and renders it in a sandboxed frame.',
  },
  file: {
    shape:
      '{ type: "file", sourcePath: string, language?: string, readOnly?: boolean, title?: string }',
    sentence:
      'A file from the working directory, loaded by DorkOS rather than pasted into the command. Markdown opens in the rich editor, everything else in the code editor. Reaching for this by hand is rarely needed — open_file picks the right viewer for you.',
  },
  model3d: {
    shape: '{ type: "model3d", src: "<https url | data: URI | local file path>", title?: string }',
    sentence:
      'A 3D model the person can spin and zoom (glTF, GLB, STL, OBJ, 3MF, PLY, FBX or DAE), with the same rules for "src" as an image.',
  },
  audio: {
    shape: '{ type: "audio", src: "<https url | data: URI | local file path>", title?: string }',
    sentence: 'A sound file with a player, with the same rules for "src" as an image.',
  },
  video: {
    shape: '{ type: "video", src: "<https url | data: URI | local file path>", title?: string }',
    sentence: 'A video with a player, with the same rules for "src" as an image.',
  },
  csv: {
    shape: '{ type: "csv", src: "<https url | data: URI | local file path>", title?: string }',
    sentence:
      'A CSV file, shown as a table the person can sort, with the same rules for "src" as an image.',
  },
  browser: {
    shape: '{ type: "browser", url: string, title?: string }',
    sentence:
      'A page in the embedded browser: an external URL, a local dev server, or a file in the working directory. browser_navigate is the easier way to open one.',
  },
  diff: {
    shape: '{ type: "diff", sourcePath: string, mediaKind?: "text"|"image", title?: string }',
    sentence:
      'A review of what you changed in a file, hunk by hunk, which the person accepts or rejects. open_diff is the easier way to open one.',
  },
};

/**
 * The hand-written half of the action catalog: one sentence per action.
 *
 * Total over `UiCommand['action']`, for the same reason
 * {@link CANVAS_CONTENT_CATALOG} is: a twenty-third action cannot be added to
 * the schema and left untaught.
 */
const UI_ACTION_CATALOG: Record<UiCommand['action'], UiActionEntry> = {
  open_panel: {
    args: '{ panel: "settings"|"tasks"|"relay"|"picker" }',
    sentence: 'Open one of the named panels.',
  },
  close_panel: {
    args: '{ panel: "settings"|"tasks"|"relay"|"picker" }',
    sentence: 'Close one of the named panels.',
  },
  toggle_panel: {
    args: '{ panel: "settings"|"tasks"|"relay"|"picker" }',
    sentence: 'Open that panel if it is closed, close it if it is open.',
  },
  open_sidebar: { args: '', sentence: 'Show the sidebar.' },
  close_sidebar: { args: '', sentence: 'Hide the sidebar.' },
  switch_sidebar_tab: {
    args: '{ tab: "overview"|"sessions"|"schedules"|"connections" }',
    sentence:
      'Select a sidebar tab. The sidebar tab strip exists ONLY in the embedded DorkOS app (the Obsidian plugin); the web app shows a standing agent roster with no tab strip, so this does nothing there — the same as open_terminal off the web.',
  },
  open_canvas: {
    args: '{ content?: <canvas>, preferredWidth?: 20-80 }',
    sentence:
      'Put something on the canvas and reveal the pane. Leave content out to reveal the pane without changing what is on it.',
  },
  update_canvas: {
    args: '{ content: <canvas>, documentId?: string }',
    sentence:
      'Replace what a canvas document is showing. In a session, omitting documentId acts on ' +
      'the active document; in a ROOM there is no shared active document, so omitting it means ' +
      '"the last document YOU opened there" and passing one acts on somebody else’s.',
  },
  close_canvas: {
    args: '{ documentId?: string }',
    sentence: 'Close a canvas document. Same targeting rule as update_canvas.',
  },
  open_pip: {
    args: '{ title?: string }',
    sentence:
      "Pop this session's NEWEST inline dorkos-ui widget into the floating picture-in-picture panel (a bottom sheet on phones). The panel FOLLOWS the live widget fence, so you MUST first send the widget as an inline ```dorkos-ui fence in a message, THEN call this. Sending that fence again updates the panel in place. Use this — NOT open_canvas — when somebody asks for PIP, a floating panel, a pop-out or picture-in-picture: those words mean the floating panel, and open_canvas opens the side canvas instead, which is the wrong surface.",
  },
  close_pip: { args: '', sentence: 'Close the floating picture-in-picture panel.' },
  open_file: {
    args: '{ sourcePath: string }',
    sentence:
      'Open a file from the working directory in the workbench. DorkOS picks the right viewer from the file type — code editor, image, PDF, 3D model, sound player, video player, CSV table, or rich markdown — and opens it as a new document the person can read or edit in place. Use this instead of pasting a file into the chat when you want somebody to look at the real thing.',
  },
  open_diff: {
    args: '{ sourcePath: string }',
    sentence:
      'Open a review of what YOU changed in a file: its current contents against how it looked before your first edit this session, hunk by hunk, accepted or rejected by the person. DorkOS opens this by itself when you edit a file, so call it only to bring a change back up on purpose. Opening the same file again refreshes the review in place.',
  },
  open_terminal: {
    args: '{ cwd?: string }',
    sentence:
      "Reveal the workbench Terminal so the person has a shell in this session's worktree. Use it when you are about to suggest commands to run, or want somebody to watch a build or a test as it happens. The terminal always runs in the session's own working directory; cwd is only a hint. Terminals are web-only — where there is none (the Obsidian plugin) this shows a brief notice instead of opening anything.",
  },
  browser_navigate: {
    args: '{ url: string }',
    sentence:
      "Open a page in the workbench's embedded browser: a local dev server, a local HTML file in the working directory, or an external URL. Use it to show a live preview of something you built. It opens as a new browser document; a URL that is already open is just brought back to the front.",
  },
  show_toast: {
    args: '{ message: string, level?: "success"|"error"|"info"|"warning", description?: string }',
    sentence: 'Show a short notice in the corner of the screen.',
  },
  set_theme: {
    args: '{ theme: "light"|"dark" }',
    sentence: 'Switch the app between its light and dark looks.',
  },
  scroll_to_message: {
    args: '{ messageId?: string }',
    sentence: 'Scroll the conversation to a message. Leave the id out to scroll to the bottom.',
  },
  switch_agent: {
    args: '{ cwd: string }',
    sentence:
      'Point the app at another working directory and load that agent. Nothing is written; the person watches it happen.',
  },
  apply_layout: {
    args: '{ shape: string }',
    sentence:
      'Apply an installed Shape — a saved arrangement of the app, with the schedules and extensions that go with it. This one leaves the screen: it writes skill files, creates and deletes scheduled tasks, turns extensions on and off, and rewrites settings, so DorkOS asks the person first even when prompts are otherwise off. Name a Shape that is already installed; DorkOS resolves the rest.',
  },
  open_command_palette: {
    args: '',
    sentence: 'Open the command palette.',
  },
  celebrate: {
    args: '{ kind?: "burst"|"fireworks"|"cannons"|"emoji"|"rain"|"stars", emoji?: string }',
    sentence:
      'Throw confetti — a burst from the middle of the screen by default. kind picks the style: fireworks (aerial shells), cannons (side crossfire), rain (a calm drizzle), stars (gold stars), or emoji (throws the glyph in "emoji", e.g. "🏆"; 🎉 when you leave it out). It skips itself for anybody who has asked for less motion.',
  },
};

/** How a catalog is rendered into one of the surfaces that teaches it. */
export interface UiCatalogOptions {
  /**
   * Written in front of every line — the indent, and the bullet if there is
   * one. Defaults to two spaces.
   */
  indent?: string;
  /**
   * Append each entry's hand-written sentence. On for the tool description,
   * where there is room to explain; off for the `<ui_tools>` system-prompt
   * block, which rides the cached prefix and only has to name the surface.
   */
  sentences?: boolean;
  /**
   * Which variants to render. Defaults to whatever the schema declares, which
   * is the point of the generator — pass a list only to prove the untaught case
   * fails.
   */
  names?: readonly string[];
}

/**
 * Render the canvas content catalog: one line per content type the schema
 * accepts.
 *
 * @param options - Indent, whether to include sentences, and which variants.
 * @returns The rendered lines, newline-joined.
 * @throws When a variant has no entry in {@link CANVAS_CONTENT_CATALOG}. The
 *   real call sites are module-scope, so that is a load failure, not a runtime one.
 */
export function buildCanvasContentCatalog(options: UiCatalogOptions = {}): string {
  const { indent = '  ', sentences = true, names = canvasContentTypes() } = options;
  return names
    .map((name) => {
      const entry = CANVAS_CONTENT_CATALOG[name as UiCanvasContent['type']];
      if (!entry) {
        throw new Error(
          `ui-tool-contract: canvas content type "${name}" has no sentence. Add one to ` +
            'CANVAS_CONTENT_CATALOG — a content type the schema accepts and nothing teaches ' +
            'is a content type no agent will ever use.'
        );
      }
      return sentences
        ? `${indent}${entry.shape}  // ${entry.sentence}`
        : `${indent}${entry.shape}`;
    })
    .join('\n');
}

/**
 * Render the action catalog: one line per action the schema accepts.
 *
 * @param options - Indent, whether to include sentences, and which actions.
 * @returns The rendered lines, newline-joined.
 * @throws When an action has no entry in {@link UI_ACTION_CATALOG}. The real
 *   call sites are module-scope, so that is a load failure, not a runtime one.
 */
export function buildUiActionCatalog(options: UiCatalogOptions = {}): string {
  const { indent = '  ', sentences = true, names = uiActionNames() } = options;
  return names
    .map((name) => {
      const entry = UI_ACTION_CATALOG[name as UiCommand['action']];
      if (!entry) {
        throw new Error(
          `ui-tool-contract: UI action "${name}" has no sentence. Add one to UI_ACTION_CATALOG — ` +
            'an action the schema accepts and nothing teaches is an action no agent will ever call.'
        );
      }
      const args = entry.args ? `: ${entry.args}` : '';
      return sentences ? `${indent}${name}${args} — ${entry.sentence}` : `${indent}${name}${args}`;
    })
    .join('\n');
}

/**
 * Tool description for control_ui (shared between the Claude in-process tool and
 * the Codex scoped stub).
 *
 * The single source of truth for the tool contract: both the Claude Code adapter
 * ({@link ../claude-code/mcp-tools/ui-tools}) and the Codex runtime's scoped
 * `dorkos_ui` MCP server ({@link ../codex/codex-ui-mcp-server}) register it
 * verbatim so agents on either runtime call the exact same tool. Composed from
 * {@link buildUiActionCatalog} and {@link buildCanvasContentCatalog} so it names
 * every action and every content type the schema accepts — see the module note.
 */
export const CONTROL_UI_DESCRIPTION = `Control the DorkOS client UI. Actions:
${buildUiActionCatalog({ indent: '- ' })}

The <canvas> that open_canvas and update_canvas take is EXACTLY ONE of these shapes. Each one's payload key differs, so read the shape before you fill it in:
${buildCanvasContentCatalog({ indent: '  ' })}

Notes:
- Delivery: UI commands only take visible effect when an interactive client is attached to this session. In headless or scheduled runs (no client) the command is accepted and queued but has no on-screen effect. A success result means "accepted", not "displayed".
- Canvas edits: while somebody is editing a canvas document, your pushes to it (open_canvas / update_canvas) are held rather than applied, and they are shown a banner offering your version or theirs (ADR-0292). A success result means the command was accepted, not that it replaced what they see.`;

/**
 * Shared input schema (a {@link https://zod.dev ZodRawShape}) for the control_ui
 * tool. Registered alongside {@link CONTROL_UI_DESCRIPTION} by both the Claude
 * in-process tool and the Codex scoped `dorkos_ui` MCP server so each exposes an
 * identical tool contract without duplicating the schema.
 *
 * **It is the whole advertised surface, not a hint.** The SDK builds the tool's
 * JSON Schema from exactly these keys and validates a call against it, so a
 * field that is missing HERE is a field the MCP layer strips before any handler
 * runs — the argument arrives, the tool succeeds, and the value is simply gone.
 * Adding a member to `UiCommandSchema` therefore means adding it here too, or
 * the union grows a field nothing can ever send.
 *
 * The `content` hint is generated from the same catalog the description is, so
 * the two can never name different sets of content types — they did, at 6 and 6
 * against a schema of 14, until the catalog replaced both lists.
 */
export const CONTROL_UI_INPUT = {
  action: z.string().describe('The UI action to perform'),
  panel: z.string().optional().describe('Panel ID for panel commands'),
  tab: z
    .string()
    .optional()
    .describe('Tab name for switch_sidebar_tab (embedded app only; no-op in the web app)'),
  // Not `z.record()`: a record anywhere in an in-session tool's schema crashes the
  // whole `tools/list` answer on claude-agent-sdk 0.3.257+ with zod 4.5.3+, and the
  // model is handed no DorkOS tools at all. `catchall` accepts the same values.
  // The full story is in `claude-code/mcp-tools/tool-exposure.ts`.
  content: z
    .object({})
    .catchall(z.unknown())
    .optional()
    .describe(
      'Canvas content for open_canvas/update_canvas. EXACTLY ONE of:\n' +
        buildCanvasContentCatalog({ indent: '  ', sentences: false })
    ),
  documentId: z
    .string()
    .optional()
    .describe(
      'Which canvas document update_canvas / close_canvas should act on. In a one-on-one ' +
        'session, omit it to act on the active document (today’s behaviour). In a ROOM there is ' +
        'no shared active document, so omitting it means "the last document YOU opened in this ' +
        'room" — pass one to act on a document somebody else put there. Every verb that opens ' +
        'something gives you back the id to pass.'
    ),
  sourcePath: z
    .string()
    .optional()
    .describe('File path (cwd-confined) to open in the workbench for open_file / open_diff'),
  url: z.string().optional().describe('Page to open in the embedded browser for browser_navigate'),
  preferredWidth: z.number().optional().describe('Canvas width percentage (20-80) for open_canvas'),
  message: z.string().optional().describe('Toast message for show_toast'),
  level: z.string().optional().describe('Toast level for show_toast'),
  description: z.string().optional().describe('Toast description for show_toast'),
  theme: z.string().optional().describe('Theme for set_theme'),
  messageId: z.string().optional().describe('Message ID for scroll_to_message'),
  title: z.string().optional().describe('Optional panel title for open_pip'),
  shape: z.string().optional().describe('Installed Shape name to apply for apply_layout'),
  cwd: z
    .string()
    .optional()
    .describe('Working directory for switch_agent, or optional cwd hint for open_terminal'),
  kind: z
    .string()
    .optional()
    .describe(
      'Celebration style for celebrate: burst|fireworks|cannons|emoji|rain|stars (default burst)'
    ),
  emoji: z.string().optional().describe('Glyph thrown by the celebrate "emoji" kind (default 🎉)'),
} as const;
