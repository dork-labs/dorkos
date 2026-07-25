/**
 * The runtime-neutral half of the system-prompt append: who the agent is, what
 * it must not do, what DorkOS is, and where it runs.
 *
 * These blocks describe DorkOS and the agent, not any one backend's tool
 * vocabulary, so every runtime gets the same text. They used to live inside the
 * Claude adapter's `context-builder.ts`, which had exactly one caller, so a
 * Codex or OpenCode agent ran with no identity, no persona, no safety
 * boundaries, and no pointer to its own capabilities. This module is the shared
 * seam that closes that gap (spec `agents-as-operators` §Overview: agents are
 * aware of everything about the system).
 *
 * It lives in `runtimes/shared/` (above the adapters), so it imports no runtime
 * SDK (Hard Rule #2) and each adapter delivers the text through whichever channel
 * its backend actually has: Claude Code's cacheable `systemPrompt.append`,
 * Codex's prompt prefix, OpenCode's `synthetic` text part.
 *
 * Runtime-SPECIFIC tool documentation (`<relay_tools>`, `<mesh_tools>`,
 * `<ui_tools>`, …) deliberately stays in the Claude adapter: those blocks teach
 * in-session MCP tools that only the Claude runtime is given. Codex and OpenCode
 * agents reach the same capabilities through the `dorkos` CLI, which the
 * `<dorkos_context>` block below points them at.
 *
 * @module services/runtimes/shared/agent-context
 */
import os from 'node:os';
import { readManifest } from '@dorkos/shared/manifest';
import {
  extractCustomProse,
  buildSoulContent,
  TRAIT_SECTION_START,
} from '@dorkos/shared/convention-files';
import { readConventionFile } from '@dorkos/shared/convention-files-io';
import { renderTraits, DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import { env } from '../../../env.js';
import { SERVER_VERSION } from '../../../lib/version.js';

/**
 * Build the `<dorkos_context>` block: what DorkOS is, and the two commands that
 * answer "what can I do here?" on any runtime.
 *
 * The `dorkos capabilities` pointer leads because it is the one actuation path
 * every runtime has. `list_capabilities` is named second, as the in-session
 * equivalent for a runtime that was given MCP tools.
 *
 * The Tasks/Relay/Mesh caveat is not padding. This block is injected on EVERY
 * turn of EVERY runtime, ahead of any skill that may or may not be loaded, so it
 * is the most-read agent-facing text in the product. Naming three subsystems on
 * one line and then saying `dorkos capabilities` lists "every capability" on the
 * next completes exactly the false inference this program exists to stop: none of
 * the three is reachable by `dorkos call`. Keep the two facts adjacent.
 */
function buildDorkosContextBlock(): string {
  return `<dorkos_context>
DorkOS is the operating system for autonomous AI agents.
Subsystems: Console (chat), Tasks (scheduling), Relay (messaging), Mesh (discovery).
Run \`dorkos capabilities\` to list the capabilities you can invoke by id, then
\`dorkos call <capability-id> [--input '<json>']\` to run one. If you have DorkOS MCP
tools in this session, \`list_capabilities\` returns the same catalog.
Tasks, Relay, and Mesh are NOT in that catalog and \`dorkos call\` cannot reach them:
they are MCP tools (\`tasks_*\`, \`relay_*\`, \`mesh_*\`) when your session has them, and
otherwise only \`dorkos task list|create|trigger|runs\` and \`dorkos agent list|show\`
exist. Relay and Mesh have no CLI path at all.
Documentation: https://dorkos.ai/llms.txt
Full docs: https://dorkos.ai/docs
</dorkos_context>`;
}

/**
 * Build the `<env>` block with system and DorkOS metadata.
 *
 * All values here are stable for the lifetime of the server process. Dynamic
 * values (date, git status, UI state) are intentionally excluded to maximize
 * prompt-cache hit rates on runtimes that have a cacheable system prompt.
 *
 * @param cwd - Working directory for the session.
 */
async function buildEnvBlock(cwd: string): Promise<string> {
  const lines = [
    `Working directory: ${cwd}`,
    `Product: DorkOS`,
    `Version: ${SERVER_VERSION}`,
    `Port: ${env.DORKOS_PORT}`,
    `Platform: ${os.platform()}`,
    `OS Version: ${os.release()}`,
    `Node.js: ${process.version}`,
    `Hostname: ${os.hostname()}`,
  ];

  return `<env>\n${lines.join('\n')}\n</env>`;
}

/**
 * Build agent identity, persona, and safety boundary blocks from `.dork/`
 * convention files.
 *
 * Reads `agent.json` for identity data and trait values, `SOUL.md` for
 * personality, and `NOPE.md` for safety boundaries. Falls back to the legacy
 * `persona` field when no SOUL.md exists (pre-migration agents).
 *
 * Injection order: identity -> persona (SOUL.md) -> safety boundaries (NOPE.md)
 * -> DorkOS knowledge.
 *
 * @param cwd - Working directory to check for agent manifest and convention files.
 * @returns XML block string, or empty string if no manifest.
 */
async function buildAgentBlock(cwd: string): Promise<string> {
  const manifest = await readManifest(cwd);
  if (!manifest) return '';

  // Zod v4 + openapi extension drops persona fields from inferred type
  const { persona, personaEnabled, traits, conventions } = manifest as {
    persona?: string;
    personaEnabled?: boolean;
    traits?: Record<string, number>;
    conventions?: { soul?: boolean; nope?: boolean; dorkosKnowledge?: boolean };
  };

  // --- Identity block ---
  const identityLines = [
    `Name: ${manifest.name}`,
    `ID: ${manifest.id}`,
    manifest.description && `Description: ${manifest.description}`,
    manifest.capabilities.length > 0 && `Capabilities: ${manifest.capabilities.join(', ')}`,
  ].filter(Boolean);

  const blocks = [`<agent_identity>\n${identityLines.join('\n')}\n</agent_identity>`];

  // --- Persona block (SOUL.md or legacy persona) ---
  const soulEnabled = conventions?.soul !== false;

  if (soulEnabled) {
    let soulContent = await readConventionFile(cwd, 'SOUL.md');

    if (soulContent) {
      // If SOUL.md has a trait section, regenerate it with current trait values
      if (soulContent.includes(TRAIT_SECTION_START)) {
        const customProse = extractCustomProse(soulContent);
        const traitBlock = renderTraits({ ...DEFAULT_TRAITS, ...traits });
        soulContent = buildSoulContent(traitBlock, customProse);
      }
      blocks.push(`<agent_persona>\n${soulContent}\n</agent_persona>`);
    } else if (personaEnabled !== false && persona) {
      // Legacy fallback: use persona field
      blocks.push(`<agent_persona>\n${persona}\n</agent_persona>`);
    }
  }

  // --- Safety boundaries block (NOPE.md) ---
  const nopeEnabled = conventions?.nope !== false;

  if (nopeEnabled) {
    const nopeContent = await readConventionFile(cwd, 'NOPE.md');
    if (nopeContent) {
      blocks.push(`<agent_safety_boundaries>\n${nopeContent}\n</agent_safety_boundaries>`);
    }
  }

  // --- DorkOS knowledge block (default ON) ---
  if (conventions?.dorkosKnowledge !== false) {
    blocks.push(buildDorkosContextBlock());
  }

  return blocks.join('\n\n');
}

/**
 * Build the runtime-neutral context append for one session: the agent's identity,
 * persona, and safety boundaries, the `<dorkos_context>` orientation block, and
 * the `<env>` metadata block, joined with blank lines.
 *
 * Every block is best-effort. A failed manifest read or an unreadable SOUL.md
 * drops that block rather than failing the turn, so a session always runs.
 *
 * Callers with a cacheable system prompt should place this AFTER their static
 * tool documentation: identity changes when the agent is edited, tool docs never
 * change, and the cacheable prefix should be the part that never moves.
 *
 * @param cwd - The session's working directory. Agent identity, persona, and
 *   safety boundaries are read from its `.dork/` convention files; an empty
 *   string comes back for a directory that hosts no agent manifest.
 * @returns The joined blocks, or `''` when nothing could be built.
 */
export async function buildAgentContextAppend(cwd: string): Promise<string> {
  const results = await Promise.allSettled([buildAgentBlock(cwd), buildEnvBlock(cwd)]);
  return results
    .filter((r) => r.status === 'fulfilled' && r.value)
    .map((r) => (r as PromiseFulfilledResult<string>).value)
    .join('\n\n');
}

/** @internal Exported for testing only. */
export {
  buildAgentBlock as _buildAgentBlock,
  buildEnvBlock as _buildEnvBlock,
  buildDorkosContextBlock as _buildDorkosContextBlock,
};
