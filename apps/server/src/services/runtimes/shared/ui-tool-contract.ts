/**
 * Runtime-neutral contract for the DorkOS `control_ui` tool — its description
 * and input schema, the single source of truth both runtimes register against.
 *
 * The Claude Code adapter registers this contract as an in-process MCP tool
 * ({@link ../claude-code/mcp-tools/ui-tools}, session-bound so it emits real
 * `ui_command` events); the Codex adapter registers the SAME contract on its
 * scoped external `dorkos_ui` server ({@link ../codex/codex-ui-mcp-server}, a
 * session-less stub whose effect is produced downstream in the event-mapper).
 * Keeping the description and schema here — depending only on `zod`, never on a
 * runtime SDK — guarantees byte-for-byte parity and keeps the Codex module graph
 * clear of the Claude SDK (ESLint confines `@anthropic-ai/claude-agent-sdk` to
 * `claude-code/`).
 *
 * @module services/runtimes/shared/ui-tool-contract
 */
import { z } from 'zod';

/**
 * Tool description for control_ui (shared between the Claude in-process tool and
 * the Codex scoped stub).
 *
 * The single source of truth for the tool contract: both the Claude Code adapter
 * ({@link ../claude-code/mcp-tools/ui-tools}) and the Codex runtime's scoped
 * `dorkos_ui` MCP server ({@link ../codex/codex-ui-mcp-server}) register it
 * verbatim so agents on either runtime call the exact same tool.
 */
export const CONTROL_UI_DESCRIPTION = `Control the DorkOS client UI. Actions:
- open_panel / close_panel / toggle_panel: { panel: "settings"|"tasks"|"relay"|"picker" }
- open_sidebar / close_sidebar
- switch_sidebar_tab: { tab: "overview"|"sessions"|"schedules"|"connections" }
- open_canvas: { content: <canvas>, preferredWidth?: 20-80 } — reveal the canvas pane with content
- update_canvas: { content: <canvas> } — replace the current canvas content
  <canvas> is EXACTLY ONE of these shapes (note each type's payload key differs):
    { type: "markdown", content: "<markdown text>", title?: string, sourcePath?: string }  // markdown goes in "content", NOT "markdown"/"text"
    { type: "url", url: "https://…", title?: string }
    { type: "json", data: <json value>, title?: string }
    { type: "image", src: "<https url | data: URI | local file path>", title?: string, alt?: string }  // image goes in "src"
    { type: "pdf", src: "<https url | data: URI | local file path>", title?: string }  // pdf goes in "src"
    { type: "widget", definition: <dorkos-ui widget document>, title?: string }  // render a Tier-1 generative-UI widget (see <gen_ui>) in the canvas
  When the markdown came from a file you read, pass sourcePath (the file's path) so the user can edit it in the canvas and have edits saved back to that file. Omit sourcePath for markdown you generated inline — it then renders read-only.
  For image/pdf, src may be an https URL, a data: URI, or a local file path (resolved within the session's working directory).
- open_file: { sourcePath: string } — open a file from the session's working directory in the workbench. DorkOS picks the right viewer (code editor, image, PDF, 3D model, CSV table, or rich markdown) from the file's type and opens it as a new document, so the user can read or edit it in place. Use this instead of pasting a file's contents into the chat when you want the user to look at or edit a real file.
- open_terminal: { cwd?: string } — reveal the workbench Terminal so the user has a shell in this session's worktree. Use it when you're about to suggest commands the user should run, or want them to watch a build/test as it happens. The terminal always runs in the session's own working directory; cwd is an optional hint. Terminals are web-only — in environments without one (e.g. the Obsidian plugin) this surfaces a brief notice that the terminal isn't available here instead of opening anything.
- browser_navigate: { url: string } — open a page in the workbench's embedded browser: a running local dev server (localhost), a local HTML file in the working directory, or an external URL. Use it to show the user a live preview of something you built or a page relevant to the work. Opens as a new browser document; navigating to a URL that's already open just re-focuses it.
- close_canvas
- show_toast: { message: string, level?: "success"|"error"|"info"|"warning", description?: string }
- set_theme: { theme: "light"|"dark" }
- scroll_to_message: { messageId?: string } (omit for bottom)
- switch_agent: { cwd: string }
- open_command_palette
- celebrate: { kind?: "burst"|"fireworks"|"cannons"|"emoji"|"rain"|"stars", emoji?: string } — throw confetti (default a burst from screen-center). kind picks the style: fireworks (aerial shells), cannons (side crossfire), rain (calm drizzle), stars (gold stars), or emoji (throws the "emoji" glyph, e.g. "🏆"; defaults to 🎉). Skips automatically under reduced motion.

Notes:
- Delivery: UI commands only take visible effect when an interactive client is attached to this session. In headless or scheduled runs (no client) the command is accepted and queued but has no on-screen effect. A success result means "accepted", not "displayed".
- Canvas edits: while the user is actively editing the canvas, content pushes (open_canvas / update_canvas) may be deferred so the editor's unsaved changes win (ADR-0292); a success result does not guarantee the content replaced what the user sees.`;

/**
 * Shared input schema (a {@link https://zod.dev ZodRawShape}) for the control_ui
 * tool. Registered alongside {@link CONTROL_UI_DESCRIPTION} by both the Claude
 * in-process tool and the Codex scoped `dorkos_ui` MCP server so each exposes an
 * identical tool contract without duplicating the schema.
 */
export const CONTROL_UI_INPUT = {
  action: z.string().describe('The UI action to perform'),
  panel: z.string().optional().describe('Panel ID for panel commands'),
  tab: z.string().optional().describe('Tab name for switch_sidebar_tab'),
  content: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Canvas content for open_canvas/update_canvas. One of: ' +
        '{ type:"markdown", content:"<md>", title?:string, sourcePath?:string } (markdown text goes in "content"; pass sourcePath when the markdown came from a file so the user can edit and save it back, omit for generated markdown to render read-only); ' +
        '{ type:"url", url:"https://…", title?:string }; ' +
        '{ type:"json", data:<json value>, title?:string }; ' +
        '{ type:"image", src:"<https url | data: URI | local file path>", title?:string, alt?:string } (image goes in "src"); ' +
        '{ type:"pdf", src:"<https url | data: URI | local file path>", title?:string } (pdf goes in "src"); ' +
        '{ type:"widget", definition:<dorkos-ui widget document>, title?:string } (render a Tier-1 generative-UI widget in the canvas)'
    ),
  sourcePath: z
    .string()
    .optional()
    .describe('File path (cwd-confined) to open in the workbench for open_file'),
  url: z.string().optional().describe('Page to open in the embedded browser for browser_navigate'),
  preferredWidth: z.number().optional().describe('Canvas width percentage (20-80) for open_canvas'),
  message: z.string().optional().describe('Toast message for show_toast'),
  level: z.string().optional().describe('Toast level for show_toast'),
  description: z.string().optional().describe('Toast description for show_toast'),
  theme: z.string().optional().describe('Theme for set_theme'),
  messageId: z.string().optional().describe('Message ID for scroll_to_message'),
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
