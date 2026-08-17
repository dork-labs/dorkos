/**
 * How the in-session server's tools are LOADED, read off the live server
 * (DOR-1292).
 *
 * Tool search is on in this SDK, so an MCP server's tools are deferred by
 * default: absent from the turn-1 prompt, reachable only after `ToolSearch`. The
 * SDK offers `alwaysLoad` (server-wide on `createSdkMcpServer`, per-tool on
 * `tool()`'s fifth argument) and `searchHint`, both surfaced as `_meta` keys —
 * verified against the real factory and an in-memory MCP client rather than read
 * off the type declarations.
 *
 * DorkOS uses both unevenly on purpose, and this file is where that decision is
 * pinned rather than merely commented:
 *
 * - exactly five tools always-load, because a room turn cannot afford a lookup
 *   before it can react and `list_capabilities` is how everything else is found;
 * - every advertised tool carries a hint, so the deferred remainder is findable
 *   by intent instead of by guessing a name;
 * - nothing else always-loads, because eighty-odd schemas on every turn's prompt
 *   is a worse trade than one search.
 *
 * The counts and the always-load set are asserted exactly, against the real
 * server, so growth in the tool surface is visible here rather than absorbed by a
 * `>` bound that can never fail.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

vi.mock('../../../../../env.js', () => ({
  env: { DORKOS_PORT: 4242, MCP_API_KEY: undefined },
}));
vi.mock('../../../../../lib/version.js', () => ({ SERVER_VERSION: 'test', IS_DEV_BUILD: false }));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn().mockResolvedValue(null) }));

import { createDorkOsToolServer } from '../index.js';
import {
  ALWAYS_LOADED_TOOLS,
  IN_SESSION_TOOL_PREFIX,
  inSessionToolName,
  searchHintFrom,
} from '../tool-exposure.js';
import { composeCapabilityRegistryForDocs } from '../../../../core/self-description/dorkos-registry.js';
import type { McpToolDeps } from '../types.js';

/** The SDK's private spelling of the two loading controls. */
const ALWAYS_LOAD_META = 'anthropic/alwaysLoad';
const SEARCH_HINT_META = 'anthropic/searchHint';

/** Deps with every optional service handle present, so the whole surface builds. */
function createFullDeps(): McpToolDeps {
  const stub = {} as never;
  return {
    transcriptReader: {
      listSessions: vi.fn().mockResolvedValue([]),
    } as unknown as McpToolDeps['transcriptReader'],
    defaultCwd: '/tmp/dor-1292-exposure',
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

interface AdvertisedTool {
  name: string;
  _meta?: Record<string, unknown>;
}

/** Every tool the live in-session server advertises, with its `_meta`. */
async function advertisedTools(): Promise<AdvertisedTool[]> {
  const server = createDorkOsToolServer(
    createFullDeps(),
    undefined,
    undefined,
    undefined,
    composeCapabilityRegistryForDocs()
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'dor-1292-exposure-probe', version: '0.0.0' });
  await Promise.all([server.instance.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools as AdvertisedTool[];
}

describe('in-session tool exposure', () => {
  it('always-loads exactly the five a turn cannot search for first', async () => {
    const tools = await advertisedTools();
    const eager = tools
      .filter((t) => t._meta?.[ALWAYS_LOAD_META] === true)
      .map((t) => t.name)
      .sort();

    expect(eager).toEqual(
      [
        'list_capabilities',
        'post_to_room',
        'react_to_room_entry',
        'read_room_history',
        'search_room_history',
      ].sort()
    );
    // The declared set and the served surface are the same set, in both
    // directions — a name declared here but never registered would otherwise sit
    // in the constant forever, doing nothing and looking load-bearing.
    expect(eager).toEqual([...ALWAYS_LOADED_TOOLS].sort());
  });

  it('leaves the rest deferred rather than flooding the prompt', async () => {
    const tools = await advertisedTools();
    const deferred = tools.filter((t) => t._meta?.[ALWAYS_LOAD_META] !== true);
    // The exact surface, so a tool added tomorrow shows up here as a number to
    // look at rather than silently passing a `>` bound.
    expect(tools).toHaveLength(83);
    expect(deferred).toHaveLength(78);
  });

  it('gives every advertised tool something to be found by', async () => {
    const tools = await advertisedTools();
    const unhinted = tools
      .filter((t) => typeof t._meta?.[SEARCH_HINT_META] !== 'string')
      .map((t) => t.name)
      .sort();
    expect(
      unhinted,
      'these tools carry no searchHint, so they can only be found by guessing their name'
    ).toEqual([]);
  });

  it('hints the room verbs with their curated capability titles', async () => {
    // The registry path hints from `capability.title`, the hand-registered path
    // from the description's first sentence. Both are pinned, because a hint
    // derived from the wrong field reads as noise and nothing else would notice.
    const byName = new Map((await advertisedTools()).map((t) => [t.name, t]));
    expect(byName.get('react_to_room_entry')?._meta?.[SEARCH_HINT_META]).toBe('React to a message');
    expect(byName.get('post_to_room')?._meta?.[SEARCH_HINT_META]).toBe('Post to a room');
    // Hand-registered: `relay_send`'s description opens with what it does.
    expect(typeof byName.get('relay_send')?._meta?.[SEARCH_HINT_META]).toBe('string');
  });
});

describe('the auto-approval allow-lists are spelled the way the SDK sends names', () => {
  it('qualifies every entry with the in-session prefix', async () => {
    // These sets are compared against the tool name Claude Code hands
    // `canUseTool`, which is `mcp__<server>__<tool>`. They used to type that
    // prefix out by hand, so renaming the MCP server would have emptied both
    // sets — silently, and fail-CLOSED: every DorkOS tool would start raising an
    // approval card, the four room verbs included, whose whole point is not to
    // raise one where nobody is watching to answer it.
    const { DORKOS_AGENT_TOOLS, IDENTITY_SCOPED_TOOLS } =
      await import('../../messaging/interactive-handlers.js');
    const unqualified = [...DORKOS_AGENT_TOOLS, ...IDENTITY_SCOPED_TOOLS].filter(
      (name) => !name.startsWith(IN_SESSION_TOOL_PREFIX)
    );
    expect(unqualified).toEqual([]);
    expect(DORKOS_AGENT_TOOLS.has(inSessionToolName('react_to_room_entry'))).toBe(true);
    // And the bare name is NOT a member, which is the half that would let an
    // unqualified spelling look like it worked.
    expect(DORKOS_AGENT_TOOLS.has('react_to_room_entry')).toBe(false);
  });

  it('covers every always-loaded room verb, so a room turn raises no card', async () => {
    // The two decisions have to agree: a tool put in the turn-1 prompt because a
    // room turn cannot afford a lookup must also skip the card that same turn.
    const { DORKOS_AGENT_TOOLS } = await import('../../messaging/interactive-handlers.js');
    const roomVerbs = [...ALWAYS_LOADED_TOOLS].filter((name) => name !== 'list_capabilities');
    for (const verb of roomVerbs) {
      expect(DORKOS_AGENT_TOOLS.has(inSessionToolName(verb)), `${verb} would raise a card`).toBe(
        true
      );
    }
  });
});

describe('searchHintFrom', () => {
  it('keeps the opening sentence and drops the elaboration', () => {
    expect(searchHintFrom('Post to a room. Not for direct messages.')).toBe('Post to a room');
    expect(searchHintFrom('React to a message — the quiet way to say seen')).toBe(
      'React to a message'
    );
  });

  it('does not split on an abbreviation or a decimal', () => {
    expect(searchHintFrom('Put one emoji on one message, e.g. 👍 on a post')).toBe(
      'Put one emoji on one message, e.g. 👍 on a post'
    );
  });

  it('truncates a description that is really a paragraph', () => {
    const hint = searchHintFrom(`${'x'.repeat(400)} and more`);
    expect(hint).toHaveLength(120);
    expect(hint?.endsWith('…')).toBe(true);
  });

  it('has nothing to say about an empty description', () => {
    expect(searchHintFrom('   ')).toBeUndefined();
  });
});
