/**
 * The tier gate on the hand-registered MCP tools (DOR-468), proven on the REAL
 * tool surface of BOTH servers.
 *
 * ## What this file is for
 *
 * The registry's conformance suite proves the gate is inside `registry.invoke`, so
 * every capability inherits it. The 47 hand-registered tools are not capabilities
 * and inherit nothing, so they need their own proof, and it has to be driven
 * through the real composition roots rather than through a fixture. That is the
 * point of `handRegisteredInSessionTools` and `createExternalMcpServer` below: a
 * domain that quietly stopped being gated would show up here, whereas a test that
 * restated the tool list would stay green.
 *
 * ## The checks, and the failure each one exists for
 *
 * - **Coverage, both directions, both servers.** Every registered tool has a tier,
 *   and every declared tier belongs to a registered tool. A tool that exists on one
 *   server only (there are seven) has exactly one entry, which is checked against
 *   the UNION of the two servers.
 * - **The retry argument.** `approvalToken` is advertised on every destructive tool
 *   on every server it appears on, and nowhere else. Miss it and the gate becomes
 *   an infinite loop: the model is told to retry with a token it has no way to
 *   send, because the MCP SDK strips an argument the schema does not declare.
 * - **The gate actually refuses.** Both destructive tools, on both servers, with
 *   and without an identity, come back `approval_required` with the handler never
 *   reached.
 * - **And then allows.** A granted token lets the same call through, and the
 *   handler never sees the token — so the approval covers exactly the arguments
 *   that run.
 * - **`observe` and `act` are untouched**, because a gate that made ordinary work
 *   prompt would be reverted within a day, and rightly.
 *
 * ## This suite was shown to fail before it was trusted
 *
 * A check nobody has broken is a check nobody has tested. Two drifts were seeded
 * into `mcp-tool-gate.ts`, run, and reverted:
 *
 * 1. `runGate` allows regardless of what the gate decided. **19 of 33 red**, on
 *    both servers, reporting `the handler ran anyway` and `the schedule was
 *    deleted before anyone approved` — read off the fake service, not off the
 *    response shape.
 * 2. `gatedInputSchema` stops adding `approvalToken`. **4 of 33 red**: the two
 *    advertisement checks, and both real-client round trips, which come back
 *    `approval_required` a SECOND time after a person granted the approval. That
 *    is the infinite loop, reproduced — and it also settles empirically that the
 *    MCP SDK silently STRIPS an unadvertised argument rather than rejecting the
 *    call, which is why the advertisement is load-bearing rather than cosmetic.
 *    (One SDK observed on both servers, not two: `createSdkMcpServer` hands back
 *    an `@modelcontextprotocol/sdk` `McpServer`, which is what the external server
 *    is too.)
 *
 * ## What this file deliberately does NOT check
 *
 * That a raw `McpServer` cannot be used as a `ToolRegistrar`. That guarantee is a
 * TYPE, and the pin for it lives in `mcp-tool-gate.ts` next to the brand instead.
 *
 * The reason has narrowed since that was written. `apps/server/tsconfig.json` used
 * to exclude `src/**\/__tests__/**` wholesale, so nothing in any test file was
 * typechecked; DOR-508 fixed that. But THIS file is one of the test files still
 * quarantined in that tsconfig's `exclude` while its own type errors are worked
 * off, so a `@ts-expect-error` written here today would still be decoration that
 * can never fail. When this file leaves quarantine, the pin can move here.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createTestDb } from '@dorkos/test-utils/db';

vi.mock('../../../env.js', () => ({ env: { DORKOS_PORT: 4242, MCP_API_KEY: undefined } }));
vi.mock('../../../lib/version.js', () => ({ SERVER_VERSION: 'test', IS_DEV_BUILD: false }));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn().mockResolvedValue(null) }));

import { createExternalMcpServer } from '../mcp-server.js';
import {
  createDorkOsToolServer,
  handRegisteredInSessionTools,
} from '../../runtimes/claude-code/mcp-tools/index.js';
import { MCP_TOOL_TIERS, gatedActionForMcpTool } from '../mcp-tool-tiers.js';
import { READ_ONLY_MCP_TOOL_NAMES } from '../external-mcp/tool-security.js';
import { SESSION_CORE_TOOL_NAMES } from '@dorkos/shared/mcp-tool-groups';
import { UI_COMMAND_REACH, UiCommandSchema } from '@dorkos/shared/schemas';
import {
  DORKOS_AGENT_TOOLS,
  IDENTITY_SCOPED_TOOLS,
} from '../../runtimes/claude-code/messaging/interactive-handlers.js';
import { IN_SESSION_TOOL_PREFIX } from '../../runtimes/claude-code/mcp-tools/tool-exposure.js';
import {
  composeCapabilityRegistryForDocs,
  composeDorkOsCapabilityRegistry,
} from '../self-description/dorkos-registry.js';
import {
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../capabilities/tier-enforcement.js';
import { ApprovalService } from '../approvals/index.js';
import { eventFanOut } from '../event-fan-out.js';
import type { AgentIdentity } from '../agent-identity/index.js';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';

/** The agent every probe calls as: unrestricted ceiling, so only the tier gates it. */
const AGENT: AgentIdentity = {
  agentPath: '/projects/prober',
  displayName: 'Prober',
  tierCeiling: 'destructive',
  createdAt: new Date().toISOString(),
};

/**
 * Records whether a destructive handler was actually reached.
 *
 * The whole claim is "the call did not happen", so it is read off the fake service
 * the handler would have called, never inferred from the shape of the response.
 */
let deletedTaskIds: string[] = [];
let unregisteredAgentIds: string[] = [];

/** The agent `mesh_unregister` finds, so its handler reaches the real removal. */
const TARGET_AGENT_ID = '01JXAMPLE0000000000000TEST';

/**
 * Deps with EVERY optional service handle present.
 *
 * That matters more than it looks: several in-session domains return no tools at
 * all when their handle is absent (bindings, adapters, traces, most of
 * extensions), so a thinner fixture would quietly shrink the surface under test
 * from 47 tools to 32 and take `binding_list_sessions` with it. The fixture has to
 * turn everything on, or the coverage check stops covering.
 *
 * The two destructive handlers get real behaviour, because "the call did not
 * happen" has to be read off the service they would have reached.
 */
function createDeps(): McpToolDeps {
  return {
    transcriptReader: { listSessions: vi.fn().mockResolvedValue([]) },
    defaultCwd: '/tmp/mcp-tool-gate',
    taskStore: {
      // `tasks_delete` reads the row before removing it, so a schedule that was
      // waiting on the operator can have its standing condition ended
      // (DOR-1387). Answering `undefined` is the honest fixture here: this file
      // is about the permission gate, and a schedule nobody was waiting on is
      // the case where that read changes nothing.
      getTask: () => undefined,
      deleteTask: (id: string) => {
        deletedTaskIds.push(id);
        return true;
      },
    },
    meshCore: {
      get: (agentId: string) => (agentId === TARGET_AGENT_ID ? { isSystem: false } : undefined),
      unregister: async (agentId: string) => {
        unregisteredAgentIds.push(agentId);
      },
    },
    bindingStore: {},
    bindingRouter: {},
    adapterManager: {},
    traceStore: {},
    extensionManager: {},
  } as unknown as McpToolDeps;
}

/** A registered tool as both servers expose it to this file. */
interface ProbeTool {
  name: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: unknown;
  call(args: unknown): Promise<CallToolResult>;
}

/** The in-session `dorkos` server's hand-registered tools, from the real composer. */
function inSessionTools(identity?: AgentIdentity): Map<string, ProbeTool> {
  const tools = handRegisteredInSessionTools(createDeps(), {
    ...(identity ? { resolveContext: async () => ({ identity }) } : {}),
  }) as unknown as {
    name: string;
    inputSchema: Record<string, unknown>;
    handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
  }[];
  return new Map(
    tools.map((tool) => [
      tool.name,
      {
        name: tool.name,
        inputSchema: tool.inputSchema,
        call: (args: unknown) => tool.handler(args, {}),
      },
    ])
  );
}

/**
 * The external `/mcp` server's hand-registered tools, from the real composer, with
 * the registry-generated ones removed — those are gated inside `registry.invoke`
 * and are not this file's subject.
 */
function externalTools(identity?: AgentIdentity): Map<string, ProbeTool> {
  const deps = createDeps();
  const server = createExternalMcpServer(deps, undefined, undefined, identity);
  const registered = (
    server as unknown as {
      _registeredTools: Record<
        string,
        {
          inputSchema?: { shape?: Record<string, unknown> };
          outputSchema?: unknown;
          handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
        }
      >;
    }
  )._registeredTools;
  const capabilityToolNames = new Set(
    composeDorkOsCapabilityRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
      operatorDeps: deps,
    })
      .capabilities.filter((cap) => cap.surfaces.mcp?.servers.includes('external'))
      .map((cap) => cap.surfaces.mcp!.toolName)
  );

  const tools = new Map<string, ProbeTool>();
  for (const [name, tool] of Object.entries(registered)) {
    if (capabilityToolNames.has(name)) continue;
    tools.set(name, {
      name,
      inputSchema: tool.inputSchema?.shape ?? {},
      outputSchema: tool.outputSchema,
      call: (args: unknown) => tool.handler(args, {}),
    });
  }
  return tools;
}

/** Read the plain payload back out of an MCP text result. */
function payloadOf(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0] as { text?: string };
  return JSON.parse(first.text ?? 'null') as Record<string, unknown>;
}

/** Every tool the table declares a tier for. */
const declaredNames = Object.keys(MCP_TOOL_TIERS).sort();

/**
 * The tier of ANY agent-facing tool, hand-registered or registry-generated.
 *
 * `MCP_TOOL_TIERS` covers only the hand-registered surface, which was enough
 * while the interactive auto-allow list held nothing else. The `rooms` domain put
 * capability-generated names on that list (DOR-1229), and a lookup that could not
 * see them would have reported them as naming no real tool — the pin below going
 * red for the opposite of the reason it exists. So the resolver reads the real
 * capability metadata, which is the same declaration `registry.invoke` gates on.
 *
 * The all-domains projection rather than {@link composeDorkOsCapabilityRegistry}:
 * that one includes a domain only when its live service handle is present, so a
 * tier lookup built from it would answer "no such tool" for every domain this
 * file does not happen to wire — which is exactly the false red above, moved.
 */
const capabilityTiers = new Map(
  composeCapabilityRegistryForDocs()
    .capabilities.filter((cap) => cap.surfaces.mcp !== undefined)
    .map((cap) => [cap.surfaces.mcp!.toolName, cap.tier] as const)
);

/** A tool's declared tier, or `undefined` when no surface declares one. */
function tierOf(bareName: string): string | undefined {
  return (
    (MCP_TOOL_TIERS as Record<string, { tier: string } | undefined>)[bareName]?.tier ??
    capabilityTiers.get(bareName)
  );
}

/** The tools each server really registers by hand, resolved once. */
const registeredByServer = {
  'in-session': [...inSessionTools().keys()].sort(),
  external: [...externalTools().keys()].sort(),
};

/** The two tools this PR puts behind a person. */
const DESTRUCTIVE = declaredNames.filter((name) => MCP_TOOL_TIERS[name].tier === 'destructive');

/** A sample call for each destructive tool: what it would do, and to what. */
const DESTRUCTIVE_INPUT: Record<string, Record<string, unknown>> = {
  tasks_delete: { id: 'schedule-to-delete' },
  mesh_unregister: { agentId: TARGET_AGENT_ID },
};

describe('hand-registered MCP tools carry a permission tier', () => {
  describe('coverage', () => {
    it('every tool both servers register declares a tier', () => {
      // The reverse of the production guarantee: the composers above would have
      // THROWN for an undeclared tool, so reaching this line already proves it.
      // Asserted anyway, because a silent try/catch upstream would hide that.
      for (const [server, names] of Object.entries(registeredByServer)) {
        const undeclared = names.filter((name) => !declaredNames.includes(name));
        expect(undeclared, `${server} registers tools with no declared tier`).toEqual([]);
      }
    });

    it('every declared tier belongs to a tool one of the servers registers', () => {
      // Keyed by tool NAME, not by server, so a tool that exists on one server only
      // needs exactly one entry — and the union is what that entry is checked
      // against. Seven tools are in-session only today.
      const everywhere = new Set([
        ...registeredByServer['in-session'],
        ...registeredByServer.external,
      ]);
      const orphans = declaredNames.filter((name) => !everywhere.has(name));
      expect(orphans, 'declared tiers for tools nothing registers').toEqual([]);
    });

    it('covers the whole hand-registered surface, and it is not empty', () => {
      // A count, so a composer that silently registered nothing cannot make every
      // other check in this file vacuously green.
      expect(registeredByServer['in-session']).toHaveLength(47);
      expect(registeredByServer.external).toHaveLength(40);
      expect(declaredNames).toHaveLength(47);
    });

    it('names exactly two tools destructive', () => {
      // Pinned by name. Promoting a third is a product decision, not a refactor,
      // and an approval card people learn to dismiss makes every card weaker.
      expect(DESTRUCTIVE).toEqual(['mesh_unregister', 'tasks_delete']);
    });
  });

  describe('the table itself', () => {
    it('gives every destructive tool the fields its approval card shows', () => {
      for (const name of DESTRUCTIVE) {
        const fields = MCP_TOOL_TIERS[name].approvalDisplayFields;
        expect(fields, `${name} would ask a person to approve an unnamed action`).toBeTruthy();
        expect(fields!.length).toBeGreaterThan(0);
        // And the named fields are arguments the tool really takes, on both
        // servers — a card that names a field the tool does not have shows nothing.
        for (const server of ['in-session', 'external'] as const) {
          const tool = (server === 'in-session' ? inSessionTools() : externalTools()).get(name);
          if (!tool) continue;
          for (const field of fields!) {
            expect(Object.keys(tool.inputSchema), `${name} on ${server}`).toContain(field);
          }
        }
      }
    });

    it('declares card fields only where a card can appear', () => {
      const strays = declaredNames.filter(
        (name) =>
          MCP_TOOL_TIERS[name].tier !== 'destructive' && MCP_TOOL_TIERS[name].approvalDisplayFields
      );
      expect(strays, 'card fields on a tier that never builds a card').toEqual([]);
    });

    it('refuses to hand out an action for a tool nobody tiered', () => {
      expect(() => gatedActionForMcpTool('a_tool_nobody_tiered')).toThrow(
        /declares no permission tier/
      );
    });

    it('keeps tool ids out of the capability id space', () => {
      // An approval binds to `${id}` + an input hash, and both spaces share that
      // one field. Capability ids always contain a dot and the COMPILER enforces
      // it (`CapabilityDefinition.id` is `` `${string}.${string}` ``). Nothing
      // types the tool half, so a tool named `tasks.delete` would be accepted and
      // could collide with a capability's binding. Asserted here instead.
      const dotted = declaredNames.filter((name) => name.includes('.'));
      expect(dotted, 'these tool names could collide with a capability id').toEqual([]);
    });

    it('never lets a tokenless tool be anything but observe', () => {
      // `READ_ONLY_MCP_TOOL_NAMES` is the carve-out that reaches the login-off
      // `/mcp` surface WITHOUT a token, and its hand-listed half is now a second
      // source of truth for "this tool only reads" alongside the tier table. All
      // 18 agree today and nothing pinned that.
      //
      // The second assertion is the one that matters: promoting a tool on that
      // list to `destructive` without also removing it from the list would make an
      // irreversible action reachable with no credential at all.
      const readOnlyHandTools = [...READ_ONLY_MCP_TOOL_NAMES].filter((name) =>
        declaredNames.includes(name)
      );
      const notObserve = readOnlyHandTools.filter(
        (name) => MCP_TOOL_TIERS[name].tier !== 'observe'
      );
      expect(
        notObserve,
        'these tools are reachable without a token but are not observe-tier'
      ).toEqual([]);
      expect(
        DESTRUCTIVE.filter((name) => READ_ONLY_MCP_TOOL_NAMES.has(name)),
        'a destructive tool is in the tokenless read-only carve-out'
      ).toEqual([]);
    });

    it('never lets a destructive tool into the always-on session set', () => {
      // `SESSION_CORE_TOOL_NAMES` is the set no toggle gates, so it applies to every
      // agent regardless of the person's toggles, and the cockpit presents it as
      // always enabled. A destructive tool landing in one of those groups is not a
      // cosmetic miscategorization: it is an irreversible action nobody can turn off.
      //
      // This assertion used to guard something sharper. Until DOR-519 the same set was
      // handed to the SDK's `allowedTools`, an approval bypass rather than an
      // availability filter, so a destructive tool in here stopped asking for approval
      // for every agent, permanently. Nothing feeds `allowedTools` now, so the stakes
      // are lower, but the pin stays: this is still the set a person cannot opt out of.
      //
      // Pinned by NAME rather than left to the count assertions in
      // `tool-filter.test.ts`, which caught this only incidentally and said nothing
      // about why it matters. Review demonstrated the gap: moving `tasks_delete`
      // from `tasks` to `core` passed `tsc` (the type-level guards compare key
      // SETS, and the keys do not change) and passed the whole targeted suite
      // against a stale `dist`, which is why `vitest.config.ts` now aliases this
      // module to source.
      expect(
        DESTRUCTIVE.filter((name) => (SESSION_CORE_TOOL_NAMES as readonly string[]).includes(name)),
        'a destructive tool is always-on and therefore cannot be turned off'
      ).toEqual([]);
    });

    it('keeps the interactive auto-allow list real and never destructive', () => {
      // `DORKOS_AGENT_TOOLS` is the fourth hand-written subset of the tool surface
      // and the one with the least ceremony in front of it: `canUseTool` allows
      // everything in it outright, with no prompt, in every interactive session.
      // DOR-499 left it hand-written on purpose (see its TSDoc), so this is the
      // safe-direction pin that replaces derivation.
      const bare = [...DORKOS_AGENT_TOOLS].map((name) => name.slice(IN_SESSION_TOOL_PREFIX.length));

      // A renamed tool leaves a dead entry behind, which silently starts prompting
      // for something meant to be frictionless. Safe, but nobody would notice.
      expect(
        bare.filter((name) => tierOf(name) === undefined),
        'these auto-allow entries name no real tool, so they do nothing'
      ).toEqual([]);

      // The direction that actually costs something.
      expect(
        bare.filter((name) => tierOf(name) === 'destructive'),
        'a destructive tool is auto-allowed with no prompt in interactive sessions'
      ).toEqual([]);
    });

    /**
     * The two checks above are what shipped DOR-625, and it is worth being exact
     * about how they passed a hole this size.
     *
     * `control_ui` IS in `MCP_TOOL_TIERS` and it is tier `act`, so both assertions
     * were true and green. Neither one asks the question that mattered: an `act`
     * tool sitting on a NO-PROMPT list is a tool that mutates and never asks, and
     * "not destructive" is a very long way from "safe to auto-allow".
     *
     * The obvious repair — require every auto-allowed tool to be `observe` — is
     * the wrong one, and worth writing down so it is not proposed again. Four
     * members are deliberately `act`: `relay_inbox` deletes the mail it acks,
     * `relay_register_endpoint` and `mesh_register` create things, and `control_ui`
     * drives the cockpit. That is the whole point of the list (see its TSDoc), so
     * the rule would have to be suppressed on its first run, and a suppressed rule
     * is not a rule.
     *
     * So the shape here is the one this repo already uses for the same problem
     * (`capabilities/__tests__/gate-bypass-scan.ts`): not "no `act` tools", but
     * **every `act` tool named, one line each, saying why it may skip the prompt**.
     * A tool cannot join the no-prompt path as a side effect of a tier choice — a
     * human has to write the sentence.
     *
     * **`observe` is not automatically exempt either (DOR-1229).** The rule used
     * to be "mutating tools need a sentence" on the unstated premise that every
     * `observe` entry reads local machine state — true of `mesh_list`,
     * `mesh_status`, `get_agent`, `get_ui_state`. The rooms reads broke it: they
     * return OTHER PEOPLE'S MESSAGES, which is not machine state and is not
     * harmless to hand over without asking. So the requirement is the union: every
     * `act` entry, plus every entry whose auto-allow is only sound under an
     * identity ({@link IDENTITY_SCOPED_TOOLS}), whatever its tier.
     */
    it('makes every mutating or identity-scoped auto-allow entry say out loud why it may skip the prompt', () => {
      /**
       * Each auto-allowed tool that mutates or reads third-party content, and the
       * argument for it. Adding one to `DORKOS_AGENT_TOOLS` fails this until it is
       * written up.
       */
      const AUTO_ALLOW_ACT_REASONS: Record<string, string> = {
        post_to_room:
          "ONLY under a resolved agent identity (IDENTITY_SCOPED_TOOLS): with one, this is an agent speaking in a room it is a member of, which is what its room turn already does with no card at all — the turn's own answer is posted for it, so the tool is the same act through a different door and a card bounds nothing it does not already permit. Membership is resolved first, posting is channels and threads only, and what bounds it is mechanism rather than prompt — the cascade guard and the two-ceiling turn budget. WITHOUT an identity the caller resolves to the person who owns the install, so it would post as a human at cascade depth zero and trigger every agent in the channel; the gate raises the ordinary card there.",
        react_to_room_entry:
          'ONLY under a resolved agent identity: one emoji on one message in a room that agent belongs to. It writes no entry, takes no turn, sends no notice and does not move the room in the activity order, and `ReactionBudget` caps it at 20 per agent per room per rolling hour, recovered from the reaction rows so a restart cannot clear it. Without an identity it would react as the owner, and asks instead.',
        read_room_history:
          'ONLY under a resolved agent identity, and it is on this list DESPITE being `observe`, because what it returns is other people conversation rather than machine state. With an identity the bound is real: membership is resolved first, "not a member" is answered exactly as "no such room", and nothing below the agent `joinedSeq` is ever returned. Without one the caller is the install owner, who sees EVERY room on the machine including their own DMs with agents — so that case asks.',
        search_room_history:
          'ONLY under a resolved agent identity, same reasoning as `read_room_history` and the same membership bound — this is the verb that caused DOR-1229, where a room turn asked for it and nobody was there to answer. Without an identity it would search every room the owner can see, and asks instead.',
        list_member_rooms:
          'ONLY under a resolved agent identity (DOR-1532), and it is the room verb with NO ARGUMENT at all — which is exactly why the qualifier carries the whole weight here. With an identity it lists that agent\'s own `room_members` rows and nothing else: not every room on the machine, not rooms it was taken out of, and not archived ones. It writes nothing, triggers no turn and returns no message body — names, kinds, join dates and last activity for places the operator already seated it. Without an identity the caller resolves to the install owner, whose `seesEveryRoom` makes "the rooms you are in" mean every room on the machine including their own DMs with agents, enumerated in one call from an ordinary coding session; the gate raises the ordinary card there. And it must not raise one WITH an identity for the room verbs\' reason: the turn that needs a room id is a room turn, where nobody is positioned to answer, and this is the tool that turns "search_member_rooms found it in some other room" into a room the agent can actually read back.',
        search_member_rooms:
          "ONLY under a resolved agent identity (DOR-1532). It is `search_room_history` with the caller's WHOLE membership as its scope, so it is the widest read in the domain and creates none of that width: the scope is exactly what message-search §7's access table already grants an agent — its member rooms, each floored at its OWN `joinedSeq`, per room and never one global floor, because one floor either leaks what was said before it arrived in a room it joined late or hides what is its own in a room it joined early. A non-member room answers identically to a room id that does not exist, and session transcripts are unreachable: the scope names the rooms source container by container and the query carries `source_id` beside `origin_key`, so a session whose opaque id collides with a room's is still a different container. Without an identity the caller is the install owner, and one no-argument call would search their entire room history; the gate asks there. WITH one it must not ask, and this is the verb that proves it: `<session_model>` tells every agent to reach for it when a room turn asks about something said elsewhere, and DOR-1229 measured what a card in a room turn costs — eleven minutes to answer one question, then an auto-deny.",
        get_room:
          "ONLY under a resolved agent identity (DOR-1610), and on this list DESPITE being `observe` for `read_room_history`'s reason turned one notch: what it returns is not machine state but WHO — a room's topic and its whole roster, every member with a handle and a human-or-agent kind. With an identity the bound is exactly the membership the roster panel and the agent's own room context block already show it: `requireMemberRoom` resolves the caller's own row before anything, and a room it is not in answers identically to a room that does not exist, so a room id is not a capability. Without one the caller resolves to the install owner, and one call reads out any room the OPERATOR belongs to and everyone in it — their private DMs with other agents included. Not every room on the machine, and the difference is worth stating rather than overclaiming: `requireMemberRoom` wants an explicit member row even from the owner, so `seesEveryRoom` never comes into it. The operator's own rooms, read by an ordinary coding session nobody asked, is argument enough. It must not ask WITH an identity for the domain's standing reason: the turn that needs to know who is listening BEFORE it speaks is a room turn, where nobody is positioned to answer a card.",
        find_room:
          'ONLY under a resolved agent identity (DOR-1610), and it is the second room verb that needs NO ROOM ID — which is where its whole weight sits. With an identity the candidate set IS that agent\'s own `room_members` rows, so a room it is not in is not findable rather than found and then hidden; the filters only ever narrow that set, never widen it, and matches are capped at ten. Without an identity the caller is the install owner, and one call naming a person\'s handle would answer which of the operator\'s rooms hold them — their DMs with other agents included — from any ordinary coding session; the gate raises the ordinary card there. It must not ask WITH one because this is the tool that turns a name a person actually typed ("post it in #mio", "my DM with @kai") into the id every other room verb requires, and a card raised to resolve a name is a card raised in the middle of the turn that needed the answer.',
        create_room:
          "ONLY under a resolved agent identity AND the `roomsManage` grant (DOR-1611), which is the bound no other entry in this table has: a person switched this on, for this agent, in its own Tools settings, and `registry.invoke` re-reads it off the manifest on every call. A card would ask her a question she has already answered, in the one place built for asking it. What it can build is bounded by the room rules rather than by anyone watching: the caller is always in the room it opens, a DM that already exists is RETURNED rather than duplicated, and `requireSeedingAllowed` refuses any roster holding two agents without her. Without an identity the grant refuses the call anyway; the gate still asks rather than inferring harmlessness from another layer's refusal.",
        add_room_members:
          'ONLY under a resolved agent identity AND the `roomsManage` grant (DOR-1611). It edits the roster of a room the agent is ALREADY IN — `requireVisibleRoom` runs first and a room it is not in answers exactly as a room that does not exist — and it cannot produce the one shape that matters: `requireOwnerWitnessesAgents` refuses any result holding two agents without the person. It must not raise a card because bringing a colleague in happens DURING a room turn, where DOR-1229 measured eleven minutes to answer one question and then an auto-deny.',
        remove_room_members:
          'ONLY under a resolved agent identity AND the `roomsManage` grant (DOR-1611), and it is the sharpest of the five, so its bound is the sharpest too: **an agent may never take the PERSON out of a room, in any roster shape** — a refusal that exists only for this caller and sits ahead of the three-way rule, which is weaker. Beyond that it is a roster edit in a room the agent belongs to, non-atomic and legible: each member comes back applied or refused with the reason, so a partial application is never something the model has to infer.',
        update_room:
          'ONLY under a resolved agent identity AND the `roomsManage` grant (DOR-1611). Two fields, title and topic, on a room the agent is in — `archived`, `deliverNotices` and every turn-limit field are absent from its input schema, so they cannot be sent at all, and the home channel takes a topic from an agent but refuses a rename (`requireSystemRoomWritable`). Nothing it can change spends anything or reaches off this machine.',
        leave_room:
          'ONLY under a resolved agent identity AND the `roomsManage` grant (DOR-1611). The narrowest of the five: the agent takes ITSELF out, of a channel, and of nothing else — a direct message is refused because it cannot be re-entered, and the home channel is refused outright. It is also the one whose card would be strangest to raise, since the answer to "may this agent stop being in this channel" is one the person can undo by adding it back.',
        relay_notify_user:
          'ONLY under a resolved agent identity (DOR-1265). A note lands only inside a scope the OPERATOR configured: their own DorkOS DM, or a binding they switched "Agent can start conversations" on for — `canInitiate` is per binding and defaults FALSE. Do not read that as "only the operator": the binding may name a group or somebody else\'s chat, and one with an empty chat filter (the cockpit default) covers every chat that has messaged that adapter, claimed or not — which `initiate-consent.ts` states as the scope the person chose by leaving the filter empty. The `channel` argument only selects among those bindings; it cannot create one, widen one, or get past `canInitiate`. So the card this used to raise asked "may it use a channel you already switched on, this once" — answerable in a session somebody is watching, unanswerable in a room turn: measured 2026-08-16, the turn parked on `awaiting_approval` and delivered nothing. What the auto-allow gives up is that per-call card, never the setup consent; what bounds frequency instead is `NotifyBudget`, ten notes per agent per rolling hour, charged only for a delivery that was attempted and (on the DM path) only for one that landed. Without an identity the handler answers NOT_AN_AGENT anyway; the gate still asks rather than inferring harmlessness from another layer\'s refusal.',
        relay_send:
          'agent-to-agent messaging, which is the feature. The server injects the sender identity rather than trusting the model, so a message cannot be forged as another agent. Who may message whom is authorized in relay/access-rules.json — but note that `AccessControl.checkAccess` DEFAULT-ALLOWS when no rule matches and the shipped default ships no rules, so out of the box that control authorizes everything. It bounds who a message claims to be from, not who may be reached.',
        mesh_discover:
          'scans for agent directories under the roots it is given. It does NOT merely report: `discover()` emits `auto-import` events and upserts what it finds into the local registry, and `includeRegistered` only controls whether those are reported back. Bounded to registry rows describing directories already on this machine, and it arms no execution.',
        relay_inbox:
          'polled continuously; a card per poll trains people to dismiss cards. The server injects the caller identity and an ack can only ever destroy the caller OWN mail.',
        relay_register_endpoint:
          'creates the caller own mailbox and nothing else; the endpoint tools refuse any inbox the caller does not own.',
        mesh_register:
          'registers the calling agent in the local mesh; discovery data, no effect off this machine.',
        memory_write:
          "ONLY under a resolved agent identity (DOR-632), and the argument is its own rather than the room verbs' — a tier is not an auto-allow. Three things together: it is JAILED to the caller's own file, because there is no path parameter, no agent parameter and nothing else to name — the target is `<agentPath>/.dork/MEMORY.md` for the identity this session presented, so an agent cannot reach another agent's memory even by trying, and the card would be asking about a scope of exactly one file the operator already owns. It has NO EXECUTION SEMANTICS: nothing runs, sends, spends or leaves the machine, and the worst outcome is a wrong line in a small markdown file the operator can open, edit, or have the agent `remove` from inside. And its BLAST RADIUS is bounded by mechanism rather than by anyone watching: the file is capped at 8,000 characters and a write past it is refused rather than trimmed, everything in it is injected fenced and framed as data, and every note carries a handler-written provenance suffix, so a poisoned entry names the room that poisoned it. The reason it must not raise a card is the room verbs' reason: the turn that most needs to save something is a room turn, where nobody is positioned to answer, and an agent that parked on a card to write a note would have learned the thing and then failed to keep it. WITHOUT an identity the handler answers `no-agent` and writes nothing anywhere; the gate still asks rather than inferring harmlessness from another layer's refusal.",
        control_ui:
          'drives the cockpit the person is already looking at — but ONLY for the actions classified `client-only`. The one that leaves the browser is gated per call; see the next test.',
      };

      const bare = [...DORKOS_AGENT_TOOLS].map((name) => name.slice(IN_SESSION_TOOL_PREFIX.length));
      const identityScoped = new Set(
        [...IDENTITY_SCOPED_TOOLS].map((name) => name.slice(IN_SESSION_TOOL_PREFIX.length))
      );
      const needsAReason = bare
        .filter((name) => tierOf(name) === 'act' || identityScoped.has(name))
        .sort();

      expect(
        needsAReason,
        'an auto-allowed tool MUTATES or reads third-party content and is not justified ' +
          'above. Nothing reaches the no-prompt path by inheriting a tier: write the ' +
          'sentence, or take it off the list.'
      ).toEqual(Object.keys(AUTO_ALLOW_ACT_REASONS).sort());
    });

    /**
     * `control_ui` is the only MULTIPLEXER on the auto-allow list: one tool name,
     * 22 different effects chosen by an argument. Every check in this file above
     * this line reasons about tool NAMES, which is precisely the resolution at
     * which a multiplexer is invisible — `apply_layout` reaches
     * `POST /api/shapes/:name/apply` and arms cron schedules, and it shared a
     * verdict with `celebrate`.
     *
     * ## What this pins, and what it cannot see
     *
     * It pins that the classification is TOTAL: every branch of the command union
     * carries a verdict, so a twenty-third action cannot arrive unclassified. That
     * is also enforced by `tsc` (`UI_COMMAND_REACH` is a `Record` over
     * `UiCommand['action']`), and asserted again here because THIS file is
     * quarantined from `apps/server/tsconfig.json`, so a type-level guard written
     * in it could never fail.
     *
     * It does NOT verify the verdicts. Deciding that `open_file` only reads and
     * `apply_layout` does not is a judgment about client code in another package,
     * and no assertion in the server test suite can follow `control_ui` →
     * `ui-action-dispatcher` → `Transport` → route. What checks that half is
     * `apps/client/src/layers/shared/lib/__tests__/ui-action-dispatcher.test.ts`,
     * which drives the real dispatcher and fails if a `client-only` command
     * reaches a transport call. Two guards, because neither package can see the
     * other's end.
     *
     * It also does not cover Codex, which reaches the same classification by a
     * different route. That runtime registers the same `control_ui` contract on
     * its scoped `dorkos_ui` server and has no `canUseTool` of its own — its
     * approvals are the Codex SDK's, which in exec mode cannot ask at all. So it
     * cannot raise a card and instead REFUSES every `reaches-the-machine` action
     * outright (DOR-639), in the scoped MCP handler and again in its event-mapper;
     * `services/runtimes/codex/__tests__/` owns those checks. OpenCode needs
     * neither gate: `control_ui` is in-session-only and its only DorkOS tool
     * surface is the external `/mcp` server, which excludes it — see
     * `external-mcp/__tests__/surface-parity.test.ts`.
     */
    it('classifies every branch of the control_ui multiplexer', () => {
      const options = (
        UiCommandSchema as unknown as {
          options: { shape: { action: { value: string } } }[];
        }
      ).options;
      const actions = options.map((option) => option.shape.action.value).sort();

      expect(actions.length, 'the union stopped introspecting; this check went vacuous').toBe(22);
      expect(
        Object.keys(UI_COMMAND_REACH).sort(),
        'a control_ui action carries no reach verdict, so the no-prompt gate has no rule for it'
      ).toEqual(actions);

      // Pinned by NAME, not by count. Promoting an action to `client-only` is a
      // decision about what an agent may do to somebody's machine unasked, and it
      // should read as one in the diff.
      const reaching = actions.filter(
        (action) => UI_COMMAND_REACH[action as keyof typeof UI_COMMAND_REACH] !== 'client-only'
      );
      expect(reaching, 'the set of UI commands that leave the browser changed').toEqual([
        'apply_layout',
      ]);
    });

    it('keeps every structured-output tool at observe', () => {
      // A tool with an `outputSchema` must return `structuredContent` on any
      // non-error result, and a refusal carries none. `observe` never produces a
      // refusal, so this holds today — pinned here so a later tier change on one of
      // these tools breaks loudly instead of at an operator's first approval.
      for (const tool of externalTools().values()) {
        if (!tool.outputSchema) continue;
        expect(MCP_TOOL_TIERS[tool.name].tier, `${tool.name} declares an outputSchema`).toBe(
          'observe'
        );
      }
    });
  });

  describe('the retry argument is advertised', () => {
    for (const server of ['in-session', 'external'] as const) {
      it(`${server}: destructive tools take approvalToken, and nothing else does`, () => {
        const tools = server === 'in-session' ? inSessionTools() : externalTools();
        for (const tool of tools.values()) {
          const advertises = Object.keys(tool.inputSchema).includes('approvalToken');
          const shouldAdvertise = MCP_TOOL_TIERS[tool.name].tier === 'destructive';
          expect(
            advertises,
            shouldAdvertise
              ? `${tool.name} is destructive but does not advertise approvalToken, so a retry ` +
                  `has nowhere to put the approval and the gate loops forever`
              : `${tool.name} is not destructive but advertises approvalToken`
          ).toBe(shouldAdvertise);
        }
      });
    }
  });

  describe('the gate runs', () => {
    let approvals: ApprovalService;

    beforeEach(() => {
      deletedTaskIds = [];
      unregisteredAgentIds = [];
      approvals = new ApprovalService(createTestDb());
      vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
      initCapabilityTierGate({ approvals });
    });

    afterEach(() => {
      resetCapabilityTierGate();
      vi.restoreAllMocks();
    });

    /** What the destructive handler would have touched, if it ran. */
    const sideEffects = (): string[] => [...deletedTaskIds, ...unregisteredAgentIds];

    for (const server of ['in-session', 'external'] as const) {
      const toolsFor = (identity?: AgentIdentity) =>
        server === 'in-session' ? inSessionTools(identity) : externalTools(identity);

      for (const name of ['tasks_delete', 'mesh_unregister']) {
        // Identified, and then with no identity at all — the shape of the bypass an
        // agent with shell access reaches for: drop the token, keep the effect. The
        // gate keys on the TIER, so both must refuse.
        for (const [who, identity] of [
          ['identified', AGENT],
          ['anonymous', undefined],
        ] as const) {
          it(`${server} ${name} (${who}): refuses, and nothing ran`, async () => {
            const result = await toolsFor(identity).get(name)!.call(DESTRUCTIVE_INPUT[name]);

            expect(sideEffects(), 'the handler ran anyway').toEqual([]);
            expect(result.isError).toBeUndefined();
            const payload = payloadOf(result);
            expect(payload.status).toBe('approval_required');
            expect(payload.approvalToken).toBeTruthy();
            expect(payload.capabilityId).toBe(name);
            expect(payload.retry).toMatchObject({
              channel: 'mcp-argument',
              field: 'approvalToken',
            });
          });
        }

        it(`${server} ${name}: runs once a person approves, and hides the token`, async () => {
          const tools = toolsFor(AGENT);
          const asked = payloadOf(await tools.get(name)!.call(DESTRUCTIVE_INPUT[name]));
          expect(sideEffects()).toEqual([]);

          approvals.grant(asked.approvalId as string);
          const result = await tools.get(name)!.call({
            ...DESTRUCTIVE_INPUT[name],
            approvalToken: asked.approvalToken as string,
          });

          // The handler ran, with the arguments the approval was bound to.
          expect(sideEffects()).toEqual([Object.values(DESTRUCTIVE_INPUT[name])[0]]);
          expect(payloadOf(result).status).not.toBe('approval_required');
        });

        it(`${server} ${name}: refuses an agent whose ceiling forbids the tier`, async () => {
          const result = await toolsFor({ ...AGENT, tierCeiling: 'act' })
            .get(name)!
            .call(DESTRUCTIVE_INPUT[name]);
          expect(sideEffects()).toEqual([]);
          expect(payloadOf(result).status).toBe('denied');
          expect(payloadOf(result).approvable).toBe(false);
        });
      }

      // DOR-1570: "an approval card is waiting for them" used to be the whole
      // instruction, and a model reading it would dutifully stop — leaving a
      // person who had been told nothing to find the card themselves. The
      // asymmetry below is the load-bearing half: `control_ui` needs an
      // attached interactive session and is not registered on `/mcp`, so
      // naming it on the external server would be an instruction that can only
      // fail. Driven through the real composition roots, so the flag really is
      // set per server rather than merely accepted by the gate.
      it(`${server}: tells the agent to surface the approval to the operator`, async () => {
        const payload = payloadOf(
          await toolsFor(AGENT).get('tasks_delete')!.call(DESTRUCTIVE_INPUT.tasks_delete)
        );
        const instructions = String((payload.retry as { instructions: string }).instructions);

        expect(instructions).toContain('waiting on their approval');
        expect(instructions).toContain('do not just stop');
        // The retry contract itself is untouched.
        expect(instructions).toContain('approvalToken');

        if (server === 'in-session') {
          expect(instructions).toContain('control_ui');
          expect(instructions).toContain("panel: 'tasks'");
        } else {
          expect(instructions).not.toContain('control_ui');
        }
      });

      it(`${server}: an observe call is not touched`, async () => {
        // `ping` answers `{ status: 'pong' }`, so this asserts the VALUE rather
        // than the absence of the key — a gate result would say
        // `approval_required` or `denied` in the same field.
        expect(payloadOf(await toolsFor(AGENT).get('ping')!.call({})).status).toBe('pong');
      });

      it(`${server}: an act call is not touched`, async () => {
        // `tasks_list` reads; `mesh_deny` changes something. Use the act one, so
        // this says what it means: `act` passes without asking.
        const result = await toolsFor(AGENT)
          .get('mesh_deny')!
          .call({ path: '/tmp/somewhere', reason: 'test' });
        expect(payloadOf(result).status).not.toBe('approval_required');
      });
    }

    it('fails closed when the gate was never wired to an approval service', async () => {
      resetCapabilityTierGate();
      const result = await inSessionTools(AGENT).get('tasks_delete')!.call({ id: 'x' });
      expect(deletedTaskIds).toEqual([]);
      expect(payloadOf(result)).toMatchObject({
        status: 'denied',
        reason: 'enforcement_unavailable',
      });
    });

    /**
     * The same round trip over a REAL MCP client, on both servers.
     *
     * Everything above calls the registered handler directly, which proves the
     * wiring but skips the one step that can silently eat the retry: each SDK
     * validates a tool call against the ADVERTISED input schema before the handler
     * runs, and drops what the schema does not declare. So a `tasks_delete` that
     * did not advertise `approvalToken` would pass every check above and still
     * loop forever in production, because the token would never survive the wire.
     *
     * These two go through `client.callTool`, so the token makes the trip a model
     * would actually make it on.
     */
    describe('the retry survives a real client round trip', () => {
      const servers = {
        'in-session': () => createDorkOsToolServer(createDeps()).instance,
        external: () => createExternalMcpServer(createDeps()),
      };

      for (const [name, build] of Object.entries(servers)) {
        it(`${name}: ask, approve, retry, and the schedule is deleted`, async () => {
          const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
          const client = new Client({ name: 'gate-probe', version: '0.0.0' });
          await Promise.all([build().connect(serverTransport), client.connect(clientTransport)]);

          const callDelete = async (args: Record<string, unknown>) =>
            payloadOf(
              (await client.callTool({ name: 'tasks_delete', arguments: args })) as CallToolResult
            );

          const asked = await callDelete({ id: 'schedule-to-delete' });
          expect(deletedTaskIds, 'the schedule was deleted before anyone approved').toEqual([]);
          expect(asked.status).toBe('approval_required');

          approvals.grant(asked.approvalId as string);
          const done = await callDelete({
            id: 'schedule-to-delete',
            approvalToken: asked.approvalToken as string,
          });

          // If the token had not been advertised, this would be a SECOND
          // `approval_required` — the infinite loop, caught.
          expect(done.status, 'the approval token did not survive the client call').not.toBe(
            'approval_required'
          );
          expect(deletedTaskIds).toEqual(['schedule-to-delete']);
          await client.close();
        });
      }
    });
  });
});
