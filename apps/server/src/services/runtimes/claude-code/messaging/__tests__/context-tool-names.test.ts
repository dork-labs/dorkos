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
 * fixture that agrees with itself. Four model-facing surfaces are covered:
 *
 * 1. **claude-code prompt blocks.** Every `mcp__dorkos__X` written in one is a tool
 *    the server advertises, and no block names a tool bare. Red on the original
 *    defect, and red again the day a new block writes `post_to_room(…)` out of habit.
 * 2. **Runtime-neutral blocks** (`<gen_ui>`, `<dorkos_context>`, `<env>`) name no
 *    DorkOS tool at all — not prefixed, since codex and opencode reach DorkOS under
 *    a different prefix, and not bare, since bare is uncallable everywhere. The one
 *    permitted form is a searchable ENDING ("its name ends in `x`"), which is true
 *    on all three runtimes and tells the model to search rather than call.
 * 3. **Tool descriptions**, read off the live server. The same strings are served
 *    verbatim to the external `/mcp` server, so a description saying "call
 *    `mcp_signin` first" is wrong on claude-code and unreliable elsewhere. Eleven
 *    descriptions were failing this when it was written.
 * 4. **`runtimes/shared/` at the source**, for the per-turn bodies (`<room_context>`,
 *    `<seed_context>`) that need a whole room fixture to render. Comments are
 *    stripped: TSDoc there legitimately names tools while explaining why the prose
 *    must not.
 * 5. **The operating skills, as RENDERED** — `skill.body` off the pack, never the
 *    file text. These ship into `.claude/skills/` for every harness, and the names
 *    are the payload of a reference doc, so each page must carry the endings note
 *    instead of losing them.
 *
 * Check 1 scopes itself by SUBTRACTING the shared blocks from the assembled prompt
 * rather than by listing the claude-code blocks, so a block added tomorrow is
 * covered without anyone remembering to add it here.
 *
 * ## Shown to fail before it was trusted
 *
 * - Bare names in `<room_tools>` alone: red, naming all four room verbs.
 * - A hand-typed `mcp__dorkos__react_to_room_entries`: red, naming that string.
 * - `<dorkos_context>`'s pre-fix bare `list_capabilities` restored: red. This one
 *   matters most — an earlier revision of this file mocked `readManifest → null`,
 *   which collapsed every shared block to `''` except `<env>`, and the reviewer
 *   proved the check was vacuous by restoring exactly this and watching it pass.
 *   `sharedBlocks()` now asserts WHICH blocks it read, by tag.
 * - A bare `post_to_room` seeded into `room-context-block.ts`: red. The source scan
 *   was prefix-only and missed it.
 * - A hand-written `'mcp__dorkos__post_to_room'` in the auto-approval allow-list:
 *   red in `tool-exposure.test.ts`, which owns that half.
 * - `${TOOL_NAME_NOTE}` deleted from `managing-agents.ts`'s BODY with the import
 *   left in place: red. The previous revision scanned the file text for the
 *   identifier, which the import alone satisfied, so a skill that shipped naming
 *   `mesh_list` bare with no note passed. Check 5 reads the rendered body instead.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// `readManifest` must return a REAL manifest, and `configManager` must answer
// `getAll` (DOR-1292 review). `buildAgentBlock` returns '' on a null manifest and
// pushes `<dorkos_context>` from INSIDE it, and the `<user_profile>` build throws
// into its own catch without `getAll` — so the earlier revision of this file
// scanned 179 characters of `<env>` and called it "the shared blocks". The
// `<dorkos_context>` block, the one this ticket rewrote, was covered by nothing:
// the reviewer restored its pre-fix bare `list_capabilities` and this file still
// passed. `sharedBlocks()` now asserts by TAG, which a length bound cannot fake.
vi.mock('../../../../core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(undefined), getAll: vi.fn().mockReturnValue({}) },
}));
vi.mock('../../../relay/relay-state.js', () => ({ isRelayEnabled: vi.fn().mockReturnValue(true) }));
vi.mock('../../../tasks/task-state.js', () => ({ isTasksEnabled: vi.fn().mockReturnValue(true) }));
vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn().mockResolvedValue({
    id: 'dor-1292',
    name: 'probe-agent',
    description: 'A probe agent',
    capabilities: [],
    runtime: 'claude-code',
    registeredAt: '2026-01-01T00:00:00.000Z',
    registeredBy: 'test',
    behavior: { responseMode: 'always' },
    personaEnabled: true,
    enabledToolGroups: {},
  }),
}));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  buildSystemPromptAppend,
  _buildPeerAgentsBlock,
  _buildRelayConnectionsBlock,
} from '../context-builder.js';
import { createDorkOsToolServer } from '../../mcp-tools/index.js';
import { ALWAYS_LOADED_TOOLS, IN_SESSION_TOOL_PREFIX } from '../../mcp-tools/tool-exposure.js';
import { composeCapabilityRegistryForDocs } from '../../../../core/self-description/dorkos-registry.js';
import { OPERATING_SKILLS_PACK, TOOL_NAME_NOTE } from '@dorkos/operating-skills';
import { GEN_UI_CONTEXT } from '../../../shared/gen-ui-context.js';
import { buildAgentContextAppend } from '../../../shared/agent-context.js';
import { NotifyBudget } from '../../../../relay/notify-budget.js';
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
    dorkHome: '/tmp/dorkos-test-home',
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
    notifyBudget: new NotifyBudget(),
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
 * Advertised tool names a runtime-neutral block presents as things to CALL.
 *
 * One form is deliberately allowed, because it is the only honest way for shared
 * prose to point at a tool at all: naming the token as a searchable ENDING
 * ("its name ends in `list_capabilities`"). Codex, OpenCode and claude-code each
 * put their own prefix in front, so the suffix is the one true thing that can be
 * said to all three — and it tells the model to search rather than to call.
 * Anything else is the DOR-1292 defect wearing different words.
 *
 * @param block - One rendered runtime-neutral block.
 * @param advertised - Every tool name the live in-session server serves.
 * @returns The offending names, empty when the block is clean.
 */
function namedAsCallable(block: string, advertised: ReadonlySet<string>): string[] {
  const offenders: string[] = [];
  for (const match of block.matchAll(/[a-z][a-z0-9_]*/g)) {
    const token = match[0];
    if (!advertised.has(token)) continue;
    // Whole-block rather than per-line: the qualifier and the token routinely
    // land on either side of a wrap, and `\s` spans the newline.
    const before = block.slice(0, match.index);
    // The backtick is REQUIRED, so the one permitted form is unambiguous: an
    // un-backticked "ends in post_to_room" reads as a name to type and would have
    // slipped through. The optional backslash matches the SOURCE form — inside a
    // template literal the delimiter is written `\``, so a raw-source scan sees
    // the escape.
    if (!/ends in\s+\\?`$/i.test(before)) offenders.push(token);
  }
  return offenders;
}

/**
 * Drop comments, so a source scan sees only what a model could ever read.
 *
 * TSDoc in these modules legitimately names tools — several comments exist
 * precisely to explain why the PROSE must not name them. Scanning raw source
 * would flag those and push the next person to weaken the check.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Every XML tag opened in a block of prompt prose, in order. */
function tagsIn(text: string): string[] {
  return [...text.matchAll(/^<([a-z_]+)>$/gm)].map((match) => match[1]!);
}

/**
 * The runtime-neutral blocks the claude-code adapter renders, and proof of which
 * ones they are.
 *
 * The tag list is the guard on this guard. Checking a character count instead is
 * what let the earlier revision scan `<env>` alone while reporting that it covered
 * the shared surface: every block it was supposed to read had silently collapsed
 * to `''` under a null-manifest mock, and 179 characters still cleared `> 100`.
 *
 * @returns The blocks, and the tags they were confirmed to contain.
 */
async function sharedBlocks(): Promise<{ blocks: string[]; tags: string[] }> {
  const agentContext = (await buildAgentContextAppend(CWD)).text;
  const blocks = [GEN_UI_CONTEXT, agentContext];
  return { blocks, tags: blocks.flatMap(tagsIn) };
}

/**
 * The claude-code-owned prose: the assembled prompt with every runtime-neutral
 * block removed, plus the two per-turn blocks this adapter renders alone.
 *
 * @returns The prose, and the shared blocks that were subtracted out of it.
 */
async function claudeCodeProse(): Promise<{ prose: string; shared: string[] }> {
  const assembled = (await buildSystemPromptAppend(CWD)).text;
  const { blocks: shared } = await sharedBlocks();
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
    // The exact surface, so a tool added or lost is a line to look at here rather
    // than a change a bound absorbs. Same number as `tool-exposure.test.ts` sees.
    expect(advertised.size).toBe(88);
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
    // above would pass while teaching nothing callable. Counted exactly, so the
    // day a block stops rendering the number moves rather than the bound holding.
    expect(prefixed.length).toBe(83);
  });

  it('names only advertised tools in the agent-session variant of the prompt too', async () => {
    // The prompt has two shapes now: a plain session, and one whose working
    // directory hosts a registered agent — which is told the six agent-to-agent
    // tools are already loaded (DOR-1337 / F8). The variant the plain scan above
    // never renders needs the same guard, or a name could rot in the half of the
    // prose only agents read.
    const advertised = await advertisedToolNames();
    const prompt = (await buildSystemPromptAppend(CWD, undefined, { agentSession: true })).text;

    const unknown = [
      ...new Set(
        identifierTokens(prompt)
          .filter((token) => token.startsWith(IN_SESSION_TOOL_PREFIX))
          .filter((token) => token !== IN_SESSION_TOOL_PREFIX)
          .map((token) => token.slice(IN_SESSION_TOOL_PREFIX.length))
          .filter((name) => !advertised.has(name))
      ),
    ].sort();
    expect(unknown).toEqual([]);

    // And it says the six are loaded, in full, so nothing spends a ToolSearch.
    for (const name of [
      'mesh_list',
      'mesh_inspect',
      'relay_send',
      'relay_send_async',
      'relay_send_and_wait',
      'relay_inbox',
    ]) {
      expect(prompt).toContain(`${IN_SESSION_TOOL_PREFIX}${name}`);
    }
  });

  it('explains the naming rule, and which tools need no lookup at all', async () => {
    // Knowing the full name is only half of it: most of the surface is deferred
    // behind tool search, and both evals showed a model reaching for ToolSearch
    // and searching the wrong string. The five always-loaded tools are the other
    // half — the prompt has to say they need no lookup, or a room turn spends one
    // anyway out of caution.
    const prompt = (await buildSystemPromptAppend(CWD)).text;
    expect(prompt).toContain('<dorkos_tools>');
    expect(prompt).toContain('already in your tool list');
    expect(prompt).toContain('deferred, not missing');
    // The worked example must name a tool that IS deferred, or it teaches a
    // lookup for something already loaded.
    expect(prompt).toContain(`ToolSearch(query="select:${IN_SESSION_TOOL_PREFIX}marketplace_get")`);
    expect(ALWAYS_LOADED_TOOLS.has('marketplace_get')).toBe(false);
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
    const { blocks: shared, tags } = await sharedBlocks();
    // WHICH blocks were read, by name. The subtraction in `claudeCodeProse`
    // removes exactly these from the claude-code scan, so a block that silently
    // stopped rendering would both escape this check and widen that one. Asserted
    // as a set, because a missing `<dorkos_context>` is the precise failure that
    // made the previous revision of this test vacuous.
    // `<agent_conventions>`, `<agent_persona>` and `<user_profile>` are absent
    // by construction, not by accident: this fixture has no convention files and
    // no stored profile. They carry no tool names — they are the person's own
    // prose — so their absence costs this check nothing, while `<dorkos_context>`
    // being present is the whole point.
    // `<session_model>` joins the set here because it renders unconditionally
    // inside `buildAgentBlock` — and it is precisely the kind of block this case
    // is for: it tells the agent to save what it learns, which is one word away
    // from naming a tool that only claude-code exposes under that spelling.
    // `<agent_memory>` is absent by construction, like the three below: this
    // fixture's directory holds no `MEMORY.md`.
    expect(tags).toEqual(['gen_ui', 'agent_identity', 'session_model', 'dorkos_context', 'env']);

    for (const block of shared) {
      expect(
        block.includes(IN_SESSION_TOOL_PREFIX),
        `a runtime-neutral block spells ${IN_SESSION_TOOL_PREFIX}, which is true on this ` +
          `runtime only:\n${block.slice(0, 400)}`
      ).toBe(false);

      const named = [...new Set(namedAsCallable(block, advertised))].sort();
      expect(
        named,
        'a runtime-neutral block names these tools as if they were callable. Bare is ' +
          'uncallable on claude-code and unreliable on the others. Either describe the verb, ' +
          'or mark the token as a searchable ending — "its name ends in `x`".'
      ).toEqual([]);
    }
  });

  it('never has one tool description name another tool as callable', async () => {
    // A tool's DESCRIPTION is the third model-facing surface, and the least
    // obvious: the same string is served verbatim to the external `/mcp` server
    // (`register-from-definitions.ts`), where the prefix is whatever a person's
    // harness config chose. So a description saying "call `mcp_signin` first" is
    // wrong on claude-code (needs the prefix) AND unreliable everywhere else —
    // the DOR-1292 defect, one layer down from the prompt blocks.
    //
    // Read off the live server, so registration and prose cannot disagree.
    const server = createDorkOsToolServer(
      createFullDeps(),
      undefined,
      undefined,
      undefined,
      composeCapabilityRegistryForDocs()
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'dor-1292-description-probe', version: '0.0.0' });
    await Promise.all([server.instance.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    await client.close();

    const advertised = new Set(tools.map((t) => t.name));
    const offenders = tools
      .map((t) => ({
        name: t.name,
        named: [...new Set(namedAsCallable(t.description ?? '', advertised))],
      }))
      .filter((entry) => entry.named.length > 0)
      .map((entry) => `${entry.name}: names ${entry.named.join(', ')}`)
      .sort();

    expect(
      offenders,
      'these tool descriptions name a tool by a string no harness guarantees. Say what the ' +
        'tool DOES ("sign in with the MCP sign-in tool"), or "this same tool" for a ' +
        'two-call protocol.'
    ).toEqual([]);
  });

  it('keeps tool names out of every runtime-neutral module, rendered or not', async () => {
    // The rendered checks above cover the two blocks claude-code assembles.
    // `<room_context>` and `<seed_context>` are per-turn bodies that need a whole
    // room fixture to render, and `runtimes/shared/` will grow more of them — so
    // the invariant is also checked where it lives, at the source. Everything
    // under that directory is written once and read by three runtimes.
    //
    // BOTH failure shapes are scanned, because the prefix half alone let a bare
    // `post_to_room` seeded into `room-context-block.ts` pass while this test
    // claimed to cover exactly that file. Comments are stripped first: TSDoc
    // legitimately names `control_ui` and `config_patch` when explaining why the
    // prose must NOT, and only the model-facing strings are in scope.
    const advertised = await advertisedToolNames();
    const dir = fileURLToPath(new URL('../../../shared/', import.meta.url));
    const modules = (await readdir(dir)).filter((name) => name.endsWith('.ts')).sort();
    // The exact module list, so a new runtime-neutral module is a line to look at
    // here rather than something a `>` bound silently absorbs.
    expect(modules).toEqual([
      'agent-context.ts',
      'asar-path.ts',
      'derive-title.ts',
      'gen-ui-context.ts',
      'mcp-content.ts',
      'resolve-binary.ts',
      'room-context-block.ts',
      'run-probe.ts',
      'seed-context-block.ts',
      'staged-context-block.ts',
      'ui-tool-contract.ts',
      'untrusted-fence.ts',
    ]);

    const offenders: string[] = [];
    for (const name of modules) {
      const source = stripComments(await readFile(join(dir, name), 'utf8'));
      if (source.includes(IN_SESSION_TOOL_PREFIX)) {
        offenders.push(`${name}: spells ${IN_SESSION_TOOL_PREFIX}`);
      }
      const named = [...new Set(namedAsCallable(source, advertised))].sort();
      if (named.length > 0) offenders.push(`${name}: names ${named.join(', ')}`);
    }
    expect(
      offenders,
      'these runtime-neutral modules name a DorkOS tool. Codex and OpenCode read them too, ' +
        "and do not use claude-code's prefix — name the verb, or mark it as an ending."
    ).toEqual([]);
  });

  it('makes every operating skill say its tool names are endings', async () => {
    // These skills are projected into `.claude/skills/` for EVERY harness, so
    // they hit the same wall as the prompt blocks — with the twist that the names
    // are the payload of a reference doc, and stripping them to verb phrases
    // would make the pages useless to search. The names stay; the page has to say
    // what they are. One shared note, so six documents cannot drift into six
    // slightly different claims.
    //
    // Read off the RENDERED pack, never the source. An earlier revision scanned
    // the file text for `TOOL_NAME_NOTE`, which the `import` line alone satisfied:
    // the reviewer deleted `${TOOL_NAME_NOTE}` from `managing-agents.ts`'s body,
    // left the import, and this passed while the projected skill named `mesh_list`
    // and `create_agent` bare with no note in sight. `skill.body` is the artifact
    // an agent actually receives, so it cannot be satisfied by an import.
    const advertised = await advertisedToolNames();
    expect(OPERATING_SKILLS_PACK.map((skill) => skill.name).sort()).toEqual([
      'answering-dorkos-questions',
      'managing-agents',
      'operating-dorkos',
      'reading-activity',
      'scheduling-tasks',
      'using-the-marketplace',
    ]);

    const offenders: string[] = [];
    for (const skill of OPERATING_SKILLS_PACK) {
      const names = [...new Set(namedAsCallable(skill.body, advertised))];
      if (names.length > 0 && !skill.body.includes(TOOL_NAME_NOTE)) {
        offenders.push(`${skill.name}: names ${names.sort().join(', ')} without the endings note`);
      }
      // The prefix itself is never right here: one of the three runtimes would be
      // reading somebody else's tool name.
      if (skill.body.includes(IN_SESSION_TOOL_PREFIX)) {
        offenders.push(`${skill.name}: spells the prefix`);
      }
    }
    expect(
      offenders,
      'these skills name DorkOS tools without telling the reader the names are endings. ' +
        'Interpolate TOOL_NAME_NOTE into the body.'
    ).toEqual([]);
  });
});
