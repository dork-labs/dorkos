/**
 * What a running extension may add to the capability registry, and how the
 * host turns that into registry definitions (spec
 * `extension-agent-tools-and-skills` §1, DOR-2685).
 *
 * An extension never hands the registry a raw {@link CapabilityDefinition}. It
 * hands over an {@link ExtensionContribution}: its id, its display name, and a
 * list of tool specs carrying only what an author may decide (name, title,
 * description, tier, input schema, display fields, handler). The host builds
 * every definition field by field from that, so the privileged optional fields
 * a core capability may declare (`preflight`, `forwardsApproval`,
 * `inSessionCard`, `approvalSubject`, `areasForInput`, `readOnlyCarveOut`, CLI
 * and HTTP surfaces, annotation overrides, and the rest) can never ride in on
 * an extension's object, whatever extra keys it carries.
 *
 * Every extension tool lives in its own reserved namespace, `ext_<id>`, which no
 * core domain may use, so a contribution can never shadow a core capability.
 * Everything an author writes is checked here before the registry sees it:
 * text that reaches an approval card, a schema every agent tool list must be
 * able to render, and a tool name every harness can address.
 *
 * @module services/core/capabilities/extension-contribution
 */
import { z } from 'zod';
import {
  EXTENSION_CAPABILITY_ID_PREFIX,
  EXTENSION_MCP_TOOL_NAME_MAX,
  EXTENSION_TOOL_NAME_PATTERN,
  EXTENSION_TOOL_TITLE_MAX,
  extensionDomainName,
  type CapabilitySource,
  type CapabilityTier,
} from '@dorkos/shared/capabilities';
import {
  checkContributionShape,
  EXTENSION_DISPLAY_NAME_MAX,
  type Checked,
} from '@dorkos/extension-api/tool-check';
import type { PermissionAreaId } from '@dorkos/shared/permissions';

import type { CapabilityDefinition } from './capability-definition.js';
import type { CapabilityHandlerContext } from './registry.js';

/**
 * The prefix every extension domain starts with, and that no core domain may
 * start with (`composeRegistry` throws on one).
 */
export const EXTENSION_DOMAIN_PREFIX = EXTENSION_CAPABILITY_ID_PREFIX;

/**
 * The permission area every extension tool sits in: one switch for all of
 * them, with per-tool overrides (DOR-2685, Decision for Dorian 2).
 */
export const EXTENSION_TOOLS_AREA: PermissionAreaId = 'extensions';

/**
 * Re-exported from `@dorkos/shared/capabilities`, which owns them so the
 * manifest schema and this check read one definition and cannot drift.
 */
export { EXTENSION_TOOL_NAME_PATTERN, EXTENSION_MCP_TOOL_NAME_MAX, extensionDomainName };

/** The longest title, which a person reads on cards and the permissions page. */
export const EXTENSION_TITLE_MAX = EXTENSION_TOOL_TITLE_MAX;

/** The longest extension display name, shown beside every one of its tools. */
export { EXTENSION_DISPLAY_NAME_MAX };

/**
 * Whether an action is an extension's destructive tool, which asks a person on
 * every call (DOR-2685, Decision for Dorian 1): a stored Allowed never reaches
 * it and its card never offers Always allow.
 *
 * A core destructive action may be set to Allowed on its own, because its tier
 * is fixed in DorkOS's source. An extension's tier is the author's to change,
 * and a standing yes keyed by tool id would otherwise carry over to a later
 * version that raised the tool to destructive, or to a different extension
 * installed under the same id.
 *
 * @param action - The action's tier and, for an extension's tool, its source.
 */
export function isAlwaysAskingExtensionTool(action: {
  tier: CapabilityTier;
  source?: CapabilitySource;
}): boolean {
  return action.source?.kind === 'extension' && action.tier === 'destructive';
}

/**
 * What an extension's handler is told about a call: who is calling and where
 * from, never a proof object.
 *
 * Deliberately narrower than {@link CapabilityHandlerContext}. The trusted
 * marker, the server principal, the spent approval and the preflight binding
 * are proofs other DorkOS code acts on; an extension has no use for them, and
 * handing one out would let it be passed somewhere it means more.
 */
export interface ExtensionToolContext {
  /** The calling agent, when the call carries an agent identity. */
  readonly agent?: { readonly path: string; readonly name: string };
  /** The session the call was made from, when the surface has one. */
  readonly sessionId?: string;
  /** That session's working directory, when the surface has one. */
  readonly cwd?: string;
  /** Aborted when this call should stop. */
  readonly signal?: AbortSignal;
}

/** One tool an extension asks to give agents. Built by the host from its manifest. */
export interface ExtensionToolSpec {
  /** The tool's name inside its extension; matches {@link EXTENSION_TOOL_NAME_PATTERN}. */
  name: string;
  /** Human-facing title: one line, at most {@link EXTENSION_TITLE_MAX} characters, no `"`. */
  title: string;
  /** Model-facing description: what the tool does and when to reach for it. */
  description: string;
  /** Permission tier. The registry's gate enforces it like any capability's. */
  tier: CapabilityTier;
  /**
   * The input contract. Must be a Zod object that renders as JSON Schema with
   * no open-ended maps (no `z.record`, `z.json`, catchall or loose object).
   */
  input: z.ZodObject;
  /**
   * Top-level input keys the approval card may show, most consequential first.
   * Required on `act` and `destructive` tools; non-empty on a destructive one,
   * and on an `act` one whose input has any field.
   */
  approvalDisplayFields?: readonly string[];
  /**
   * Run the tool. Receives the parsed input and a narrowed view of the call;
   * returns plain JSON-serializable output.
   */
  invoke: (input: unknown, ctx: ExtensionToolContext) => Promise<unknown>;
}

/** Everything one extension contributes to the registry at once. */
export interface ExtensionContribution {
  /** The contributing extension's id. */
  owner: string;
  /** The extension's display name: one line, at most {@link EXTENSION_DISPLAY_NAME_MAX} characters. */
  displayName: string;
  /** The tools it gives agents. Added all together, or not at all. */
  tools: readonly ExtensionToolSpec[];
}

/**
 * Check a contribution and copy it into a fresh, frozen plain value.
 *
 * The rules live in `@dorkos/extension-api/tool-check`
 * ({@link checkContributionShape}), which discovery and `dorkos marketplace
 * validate` run too; this adds the one thing only the server has, each tool's
 * handler, read once right after its input schema passes.
 *
 * Never throws: anything wrong, including a field that throws when read, comes
 * back as a refusal sentence the caller reports on the extension.
 *
 * @param contribution - What the extension asked to add.
 * @returns The checked copy, or the reason it was refused.
 */
export function checkExtensionContribution(contribution: unknown): Checked<ExtensionContribution> {
  const checked = checkContributionShape(contribution, (spec, name) => {
    const invoke = spec.invoke;
    return typeof invoke === 'function'
      ? { ok: true, value: invoke as ExtensionToolSpec['invoke'] }
      : { ok: false, reason: `tool "${name}" has no handler` };
  });
  if (!checked.ok) return checked;
  const tools: ExtensionToolSpec[] = checked.value.tools.map(({ extra: handler, ...fields }) => ({
    ...fields,
    invoke: (parsed, ctx) => handler(parsed, ctx),
  }));
  return {
    ok: true,
    value: Object.freeze({
      owner: checked.value.owner,
      displayName: checked.value.displayName,
      tools: Object.freeze(tools),
    }),
  };
}

/**
 * Narrow the registry's handler context to what an extension is told.
 *
 * A fresh frozen object built field by field, so nothing else the registry
 * puts on the context (proofs, tokens, the hand-tool reach) can reach the
 * extension, today or after the context grows.
 *
 * @param context - The handler context the gate produced.
 */
export function narrowExtensionContext(context: CapabilityHandlerContext): ExtensionToolContext {
  return Object.freeze({
    ...(context.identity
      ? {
          agent: Object.freeze({
            path: context.identity.agentPath,
            name: context.identity.displayName,
          }),
        }
      : {}),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.cwd ? { cwd: context.cwd } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
  });
}

/**
 * Build the registry definitions for one checked contribution.
 *
 * Each definition is assembled field by field — never spread from the spec —
 * so only the fields named here can exist on it: id `<domain>.<name>`, MCP tool
 * name `<domain>__<name>` on the in-session server only, `output: z.unknown()`,
 * the given area, and `source` naming the extension. No preflight,
 * forwardsApproval, inSessionCard, approvalSubject, areasForInput,
 * readOnlyCarveOut, CLI or HTTP surface, or annotation override is ever set.
 * Every definition, and its surfaces, is frozen, and the handler receives only
 * the narrowed {@link ExtensionToolContext}.
 *
 * @param contribution - A contribution already checked by {@link checkExtensionContribution}.
 * @param area - The permission area every tool sits in.
 * @returns One frozen definition per tool, in declaration order.
 */
export function buildExtensionDefinitions(
  contribution: ExtensionContribution,
  area: PermissionAreaId
): CapabilityDefinition[] {
  const domain = extensionDomainName(contribution.owner);
  const source: CapabilitySource = Object.freeze({
    kind: 'extension',
    id: contribution.owner,
    name: contribution.displayName,
  });
  return contribution.tools.map((tool) => {
    const id = `${domain}.${tool.name}` as const;
    const definition: CapabilityDefinition = {
      id,
      title: tool.title,
      description: tool.description,
      tier: tool.tier,
      area,
      input: tool.input,
      output: z.unknown(),
      surfaces: Object.freeze({
        mcp: Object.freeze({ toolName: `${domain}__${tool.name}`, servers: ['in-session'] }),
      }) as CapabilityDefinition['surfaces'],
      ...(tool.approvalDisplayFields ? { approvalDisplayFields: tool.approvalDisplayFields } : {}),
      source,
      invoke: (_deps, input, context) => tool.invoke(input, narrowExtensionContext(context)),
    };
    return Object.freeze(definition);
  });
}
