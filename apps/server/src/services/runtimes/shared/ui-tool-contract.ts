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
- open_panel / close_panel / toggle_panel: { panel: "settings"|"tasks"|"relay"|"mesh"|"picker" }
- open_sidebar / close_sidebar
- switch_sidebar_tab: { tab: "overview"|"sessions"|"schedules"|"connections" }
- open_canvas: { content: <canvas>, preferredWidth?: 20-80 } — reveal the canvas pane with content
- update_canvas: { content: <canvas> } — replace the current canvas content
  <canvas> is EXACTLY ONE of these shapes (note each type's payload key differs):
    { type: "markdown", content: "<markdown text>", title?: string, sourcePath?: string }  // markdown goes in "content", NOT "markdown"/"text"
    { type: "url", url: "https://…", title?: string, sandbox?: string }
    { type: "json", data: <json value>, title?: string }
  When the markdown came from a file you read, pass sourcePath (the file's path) so the user can edit it in the canvas and have edits saved back to that file. Omit sourcePath for markdown you generated inline — it then renders read-only.
- close_canvas
- show_toast: { message: string, level?: "success"|"error"|"info"|"warning", description?: string }
- set_theme: { theme: "light"|"dark" }
- scroll_to_message: { messageId?: string } (omit for bottom)
- switch_agent: { cwd: string }
- open_command_palette`;

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
        '{ type:"url", url:"https://…", title?:string, sandbox?:string }; ' +
        '{ type:"json", data:<json value>, title?:string }'
    ),
  preferredWidth: z.number().optional().describe('Canvas width percentage (20-80) for open_canvas'),
  message: z.string().optional().describe('Toast message for show_toast'),
  level: z.string().optional().describe('Toast level for show_toast'),
  description: z.string().optional().describe('Toast description for show_toast'),
  theme: z.string().optional().describe('Theme for set_theme'),
  messageId: z.string().optional().describe('Message ID for scroll_to_message'),
  cwd: z.string().optional().describe('Working directory for switch_agent'),
} as const;
