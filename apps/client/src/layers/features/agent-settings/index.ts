/**
 * Agent settings feature — dialog for configuring agent identity, persona, and capabilities.
 *
 * @module features/agent-settings
 */
// Tab components — exported for reuse in sibling feature UI: the profile
// composes these as pages (Connections, Tools & MCP).
export { IdentityTab } from './ui/IdentityTab';
export { IntegrationsTab } from './ui/IntegrationsTab';
export { ToolsTab } from './ui/ToolsTab';
// The convention-file editor on its own: the profile gives SOUL.md and NOPE.md
// a full page each, so it composes the editor without the personality tab
// around it.
export { ConventionFileEditor } from './ui/ConventionFileEditor';

// The MCP server card's presentational parts, so the Dev Playground can show
// every state it can reach without standing up a server for each one.
export { McpServerCard } from './ui/McpServerCard';
export { McpServerCardDetails } from './ui/McpServerCardDetails';
export type { McpToolSummary } from './ui/McpServerCardDetails';
export { McpSigninPanel } from './ui/McpSigninPanel';
export type { McpCardStatus } from './lib/mcp-server-state';
