/**
 * Drift guard: what the claude-code system prompt TEACHES is what the model can
 * CALL (DOR-1292).
 *
 * ## The failure this exists for
 *
 * Claude Code qualifies every MCP tool as `mcp__<server>__<tool>`, so the
 * in-session `dorkos` server's `react_to_room_entry` is callable only as
 * `mcp__dorkos__react_to_room_entry`. Every block in `context-builder.ts` used to
 * name tools bare, and Haiku — which follows prose literally rather than scanning
 * its tool list — did exactly what it was told. Measured twice on
 * `claude-code-cheap`, from the agents' own JSONL:
 *
 * - `rooms-ack-only-reacts-not-replies`: called `react_to_room_entry` with the
 *   right room and entry ids on the first attempt, got `No such tool available`,
 *   tried `ToolSearch select:react_to_room_entry`, got "No matching deferred tools
 *   found", and fell back to a text post — failing an eval about NOT posting text.
 * - `marketplace-search-and-install`: `ToolSearch select:marketplace_get,
 *   marketplace_install` found nothing; a keyword search then returned
 *   `mcp__dorkos__marketplace_get`, `select:` on the full name resolved it, and the
 *   turn was already spent.
 *
 * Both tool sets were registered and exposed the whole time (78 `mcp__dorkos__*`
 * tools in the first run's transcript). Nothing was missing; the prose was wrong.
 *
 * ## What this test pins, and how it would go red
 *
 * It reads the LIVE tool server — `createDorkOsToolServer` over a real in-memory
 * MCP client — rather than any table of names, so it cannot be satisfied by a
 * fixture that agrees with itself. Then, over the claude-code-OWNED prose only:
 *
 * 1. Every `mcp__dorkos__X` written in a block is a tool the server advertises.
 *    Red when a tool is renamed or removed and the prose is not.
 * 2. No block names a tool bare. Red on the original defect, and red again the
 *    day someone adds a block and writes `post_to_room(…)` out of habit.
 * 3. The runtime-neutral blocks (`<gen_ui>`, `<dorkos_context>`, `<env>`, and the
 *    per-turn `<room_context>` / `<seed_context>` bodies) spell no prefix at all.
 *    They render on codex and opencode too, where DorkOS is reached through the
 *    external `/mcp` server under whatever name the person's harness config gave
 *    it — so claude-code's prefix is a false statement there, and the correct
 *    wording names the verb and defers to the harness.
 *
 * Checks 1 and 2 scope themselves by SUBTRACTING the shared blocks from the
 * assembled prompt, rather than by listing the claude-code blocks — so a block
 * added tomorrow is covered without anyone remembering to add it here. The
 * subtraction is asserted to have removed something, because a silently-missing
 * shared block would silently widen the scope instead of narrowing it.
 *
 * ## Shown to fail before it was trusted
 *
 * Reverting the prose to bare names (dropping the `${T}` interpolation from
 * `<room_tools>` alone) turns check 2 red with
 * `post_to_room, react_to_room_entry, read_room_history, search_room_history`.
 * Pointing check 1 at a hand-typed `mcp__dorkos__react_to_room_entries` turns it
 * red naming that string.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../../../../core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(undefined) },
}));
vi.mock('../../../relay/relay-state.js', () => ({ isRelayEnabled: vi.fn().mockReturnValue(true) }));
vi.mock('../../../tasks/task-state.js', () => ({ isTasksEnabled: vi.fn().mockReturnValue(true) }));
vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn().mockResolvedValue(null) }));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  buildSystemPromptAppend,
  _buildPeerAgentsBlock,
  _buildRelayConnectionsBlock,
} from '../context-builder.js';
import { createDorkOsToolServer } from '../../mcp-tools/index.js';
import { IN_SESSION_TOOL_PREFIX } from '../../mcp-tools/tool-names.js';
import { composeCapabilityRegistryForDocs } from '../../../../core/self-description/dorkos-registry.js';
import { GEN_UI_CONTEXT } from '../../../shared/gen-ui-context.js';
import { buildAgentContextAppend } from '../../../shared/agent-context.js';
import type { McpToolDeps } from '../../mcp-tools/types.js';
import type { AgentRegistryPort } from '@dorkos/shared/agent-runtime';
import type { RelayContextDeps } from '../context-builder.js';

const CWD = '/tmp/dor-1292-probe-cwd';

/**
 * Deps with every optional service handle present.
 *
 * Several in-session domains return no tools at all when their handle is missing
 * (bindings, adapters, traces, extensions), so a thinner fixture would compare the
 * prose against a fraction of the real surface and let a bare name through. Only
 * registration is exercised, never a handler, so opaque stubs are enough.
 */
function createFullDeps(): McpToolDeps {
  const stub = {} as never;
  return {
    transcriptReader: {
      listSessions: vi.fn().mockResolvedValue([]),
    } as unknown as McpToolDeps['transcriptReader'],
    defaultCwd: CWD,
    taskStore: stub,
    relayCore: stub,
    adapterManager: stub,
    traceStore: stub,
    bindingStore: stub,
    bindingRouter: stub,
    meshCore: stub,
    extensionManager: stub,
    runtimeRegistry: stub,
    activityService: stub,
  };
}

/**
 * Every tool the live in-session server advertises, by its bare registered name.
 *
 * `composeCapabilityRegistryForDocs` is the right registry here: it admits every
 * capability domain unconditionally (rooms included), where the boot composer
 * gates each on live service handles that this test has no business standing up.
 */
async function advertisedToolNames(): Promise<Set<string>> {
  const server = createDorkOsToolServer(
    createFullDeps(),
    undefined,
    undefined,
    undefined,
    composeCapabilityRegistryForDocs()
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'dor-1292-probe', version: '0.0.0' });
  await Promise.all([server.instance.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return new Set(tools.map((tool) => tool.name));
}

/** Bare-name fixtures for the two per-turn dynamic blocks. */
function dynamicBlockFixtures(): { mesh: AgentRegistryPort; relay: RelayContextDeps } {
  return {
    mesh: {
      listWithPaths: () => [{ id: 'a1', name: 'api-bot', projectPath: '/projects/api' }],
    } as unknown as AgentRegistryPort,
    relay: {
      agentId: 'agent-1',
      bindingStore: { getAll: () => [{ id: 'b1', adapterId: 'telegram-x', agentId: 'agent-1' }] },
      bindingRouter: { getSessionsByBinding: () => [] },
      adapterManager: { listAdapters: () => [] },
    } as unknown as RelayContextDeps,
  };
}

/**
 * The claude-code-owned prose: the assembled prompt with every runtime-neutral
 * block removed, plus the two per-turn blocks this adapter renders alone.
 *
 * @returns The prose, and the shared blocks that were subtracted out of it.
 */
async function claudeCodeProse(): Promise<{ prose: string; shared: string[] }> {
  const assembled = await buildSystemPromptAppend(CWD);
  const shared = [GEN_UI_CONTEXT, await buildAgentContextAppend(CWD)];
  let prose = assembled;
  for (const block of shared) prose = prose.split(block).join('');

  const { mesh, relay } = dynamicBlockFixtures();
  prose += `\n${await _buildPeerAgentsBlock(mesh)}`;
  prose += `\n${_buildRelayConnectionsBlock(relay)}`;
  return { prose, shared };
}

/**
 * Split text into the identifier-shaped tokens a model would copy, keeping the
 * `mcp__dorkos__` prefix attached where it is present.
 *
 * Whole-token matching is what makes the check exact: a substring search for
 * `relay_send` would be satisfied by `mcp__dorkos__relay_send_and_wait` and miss a
 * bare `relay_send_and_wait` entirely.
 */
function identifierTokens(text: string): string[] {
  return text.match(/[a-z][a-z0-9_]*/g) ?? [];
}

describe('the claude-code prompt names tools the way the runtime exposes them', () => {
  it('names every DorkOS tool it teaches in full, never bare', async () => {
    const advertised = await advertisedToolNames();
    // A fixture that stopped building the server would otherwise let everything
    // through by having nothing to compare against.
    expect(advertised.size).toBeGreaterThan(50);
    expect(advertised.has('react_to_room_entry')).toBe(true);

    const { prose } = await claudeCodeProse();
    const bare = [
      ...new Set(identifierTokens(prose).filter((token) => advertised.has(token))),
    ].sort();

    expect(
      bare,
      'these tool names are written bare in a claude-code prompt block. Claude Code exposes ' +
        `them as ${IN_SESSION_TOOL_PREFIX}<name>, so a model that copies the prose gets ` +
        '"No such tool available" — the DOR-1292 defect. Interpolate the prefix.'
    ).toEqual([]);
  });

  it('writes no prefixed name that the in-session server does not advertise', async () => {
    const advertised = await advertisedToolNames();
    const { prose } = await claudeCodeProse();

    const prefixed = identifierTokens(prose).filter((token) =>
      token.startsWith(IN_SESSION_TOOL_PREFIX)
    );
    // The prefix appears once on its own, in `<dorkos_tools>`, where the rule
    // itself is stated rather than a tool named. Everything else must resolve.
    const unknown = [
      ...new Set(
        prefixed
          .filter((token) => token !== IN_SESSION_TOOL_PREFIX)
          .map((token) => token.slice(IN_SESSION_TOOL_PREFIX.length))
          .filter((name) => !advertised.has(name))
      ),
    ].sort();

    expect(
      unknown,
      'the prompt teaches these tools, and the in-session server does not have them. ' +
        'A rename or a removal left the prose behind.'
    ).toEqual([]);
    // The reverse guard on the guard: if nothing were prefixed at all, the check
    // above would pass while teaching nothing callable.
    expect(prefixed.length).toBeGreaterThan(40);
  });

  it('explains the naming rule and how to load a deferred tool', async () => {
    // The tools are DEFERRED — a `type: 'sdk'` MCP server has no `alwaysLoad`
    // escape — so knowing the full name is only half of it. Both evals showed a
    // model reaching for ToolSearch and searching the wrong string.
    const prompt = await buildSystemPromptAppend(CWD);
    expect(prompt).toContain('<dorkos_tools>');
    expect(prompt).toContain(`ToolSearch(query="select:${IN_SESSION_TOOL_PREFIX}post_to_room")`);
    expect(prompt).toContain('deferred, not missing');
  });

  it('names no in-session tool at all in the runtime-neutral blocks it renders', async () => {
    // Both halves matter, and for the same reason. Codex and OpenCode render
    // these blocks too and reach DorkOS through the external `/mcp` server under
    // whatever name the person's harness config gave it — so claude-code's prefix
    // is a false statement there, and a BARE name is uncallable on all three. The
    // only wording that holds everywhere names the verb and defers to the harness.
    //
    // Checked here as well as in the source scan below because the subtraction in
    // `claudeCodeProse` removes these blocks before the bare-name scan runs: a
    // bare name inside a shared block would otherwise fall through both checks,
    // which is exactly the hole this case closes.
    const advertised = await advertisedToolNames();
    const { shared } = await claudeCodeProse();
    // The subtraction is only meaningful if these blocks are real text; an empty
    // one would quietly widen the other checks' scope to prose this adapter does
    // not own.
    for (const block of shared) expect(block.length).toBeGreaterThan(100);

    for (const block of shared) {
      expect(
        block.includes(IN_SESSION_TOOL_PREFIX),
        `a runtime-neutral block spells ${IN_SESSION_TOOL_PREFIX}, which is true on this ` +
          `runtime only:\n${block.slice(0, 400)}`
      ).toBe(false);

      const named = [
        ...new Set(identifierTokens(block).filter((token) => advertised.has(token))),
      ].sort();
      expect(
        named,
        'a runtime-neutral block names these tools bare. Bare is uncallable on claude-code ' +
          'and unreliable on the others; describe the verb instead.'
      ).toEqual([]);
    }
  });

  it('keeps it out of every runtime-neutral module, rendered or not', async () => {
    // The blocks above are the ones claude-code assembles. `<room_context>` and
    // `<seed_context>` are per-turn bodies that need a whole room fixture to
    // render, and `runtimes/shared/` will grow more of them — so the invariant is
    // checked where it actually lives, at the source. Everything under that
    // directory is written once and read by three runtimes; a concrete prefix in
    // any of it is a claim about somebody else's harness.
    const dir = fileURLToPath(new URL('../../../shared/', import.meta.url));
    const modules = (await readdir(dir)).filter((name) => name.endsWith('.ts'));
    expect(modules.length).toBeGreaterThan(5);

    const offenders: string[] = [];
    for (const name of modules) {
      const source = await readFile(join(dir, name), 'utf8');
      if (source.includes(IN_SESSION_TOOL_PREFIX)) offenders.push(name);
    }
    expect(
      offenders,
      `these runtime-neutral modules spell ${IN_SESSION_TOOL_PREFIX}. Name the verb and ` +
        "defer to the harness instead — codex and opencode do not use claude-code's prefix."
    ).toEqual([]);
  });
});
