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
 *
 * @module services/core/capabilities/extension-contribution
 */
import { z } from 'zod';
import {
  CAPABILITY_TIERS,
  isSecretInputKey,
  type CapabilitySource,
  type CapabilityTier,
} from '@dorkos/shared/capabilities';
import { EXTENSION_ID_REGEX } from '@dorkos/shared/extension-id';
import type { PermissionAreaId } from '@dorkos/shared/permissions';

import type { CapabilityDefinition } from './capability-definition.js';
import type { CapabilityHandlerContext } from './registry.js';

/**
 * The prefix every extension domain starts with, and that no core domain may
 * start with (`composeRegistry` throws on one).
 */
export const EXTENSION_DOMAIN_PREFIX = 'ext_';

/**
 * The permission area every extension tool sits in: one switch for all of
 * them, with per-tool overrides (DOR-2685, Decision for Dorian 2).
 */
export const EXTENSION_TOOLS_AREA: PermissionAreaId = 'extensions';

/** The shape of one tool's name inside its extension, e.g. `send_message`. */
export const EXTENSION_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * What an agent is told when it calls an extension tool that is not
 * registered right now: its extension stopped, is restarting, or never ran.
 */
export const EXTENSION_TOOL_UNAVAILABLE_MESSAGE =
  "That tool isn't available right now: its extension is stopped or restarting.";

/** The machine-readable code carried beside {@link EXTENSION_TOOL_UNAVAILABLE_MESSAGE}. */
export const EXTENSION_TOOL_UNAVAILABLE_CODE = 'EXTENSION_TOOL_UNAVAILABLE';

/**
 * The registry domain an extension's tools live under: `ext_` plus the
 * extension id with every `-` turned into `_`.
 *
 * Injective because an extension id can never contain `_`
 * (`EXTENSION_ID_REGEX`), so two different extensions can never share a domain.
 *
 * @param extensionId - A valid extension id, e.g. `mail-app`.
 * @returns The domain, e.g. `ext_mail_app`.
 */
export function extensionDomainName(extensionId: string): string {
  return EXTENSION_DOMAIN_PREFIX + extensionId.replaceAll('-', '_');
}

/**
 * Whether a capability id is in the extension namespace, registered or not.
 *
 * @param id - A capability id.
 */
export function isExtensionCapabilityId(id: string): boolean {
  return id.startsWith(EXTENSION_DOMAIN_PREFIX);
}

/** One tool an extension asks to give agents. Built by the host from its manifest. */
export interface ExtensionToolSpec {
  /** The tool's name inside its extension; matches {@link EXTENSION_TOOL_NAME_PATTERN}. */
  name: string;
  /** Human-facing title, shown on cards and the permissions page. */
  title: string;
  /** Model-facing description: what the tool does and when to reach for it. */
  description: string;
  /** Permission tier. The registry's gate enforces it like any capability's. */
  tier: CapabilityTier;
  /** The input contract. Must be a Zod object; parsed before the handler runs. */
  input: z.ZodObject;
  /** Top-level input keys the approval card may show, most consequential first. */
  approvalDisplayFields?: readonly string[];
  /**
   * Run the tool. Receives the parsed input and the handler context the gate
   * produced; returns plain JSON-serializable output.
   */
  invoke: (input: unknown, ctx: CapabilityHandlerContext) => Promise<unknown>;
}

/** Everything one extension contributes to the registry at once. */
export interface ExtensionContribution {
  /** The contributing extension's id. */
  owner: string;
  /** The extension's display name, for cards and the permissions page. */
  displayName: string;
  /** The tools it gives agents. Added all together, or not at all. */
  tools: readonly ExtensionToolSpec[];
}

/** Either a usable value or the sentence saying why it was refused. */
type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Whether a value is a non-empty string after trimming. */
function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Read one tool spec into a fresh plain object, checking every field once.
 *
 * Reading each field exactly once matters: a contribution is author-supplied,
 * and a getter that answered one way to the check and another way to the build
 * would otherwise slip past the check.
 */
function checkTool(raw: unknown, index: number): Checked<ExtensionToolSpec> {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: `tool ${index + 1} is not an object` };
  }
  const spec = raw as Record<string, unknown>;
  const name = spec.name;
  const title = spec.title;
  const description = spec.description;
  const tier = spec.tier;
  const input = spec.input;
  const displayFields = spec.approvalDisplayFields;
  const invoke = spec.invoke;

  if (typeof name !== 'string' || !EXTENSION_TOOL_NAME_PATTERN.test(name)) {
    return { ok: false, reason: `tool ${index + 1} has an invalid name` };
  }
  if (!isText(title)) return { ok: false, reason: `tool "${name}" has no title` };
  if (!isText(description)) return { ok: false, reason: `tool "${name}" has no description` };
  if (typeof tier !== 'string' || !(CAPABILITY_TIERS as readonly string[]).includes(tier)) {
    return { ok: false, reason: `tool "${name}" has an unknown tier` };
  }
  if (!(input instanceof z.ZodObject)) {
    return { ok: false, reason: `tool "${name}" input is not an object schema` };
  }
  if (typeof invoke !== 'function') {
    return { ok: false, reason: `tool "${name}" has no handler` };
  }

  let fields: readonly string[] | undefined;
  if (displayFields !== undefined) {
    if (!Array.isArray(displayFields)) {
      return { ok: false, reason: `tool "${name}" display fields are not a list` };
    }
    const keys = Object.keys(input.shape);
    const copy = [...(displayFields as unknown[])];
    for (const field of copy) {
      if (typeof field !== 'string' || !keys.includes(field)) {
        return { ok: false, reason: `tool "${name}" shows a field its input does not have` };
      }
      // A display field reaches the broadcast approval card and the
      // agent-readable pending list, so one named like a secret is refused
      // here exactly as conformance refuses it on a core capability.
      if (isSecretInputKey(field)) {
        return { ok: false, reason: `tool "${name}" shows a secret field on its card` };
      }
    }
    fields = Object.freeze(copy as string[]);
  }

  const handler = invoke as ExtensionToolSpec['invoke'];
  return {
    ok: true,
    value: {
      name,
      title,
      description,
      tier: tier as CapabilityTier,
      input,
      ...(fields ? { approvalDisplayFields: fields } : {}),
      invoke: (parsed, ctx) => handler(parsed, ctx),
    },
  };
}

/**
 * Check a contribution and copy it into a fresh, frozen plain value.
 *
 * Never throws: anything wrong, including a field that throws when read, comes
 * back as a refusal sentence the caller reports on the extension.
 *
 * @param contribution - What the extension asked to add.
 * @returns The checked copy, or the reason it was refused.
 */
export function checkExtensionContribution(contribution: unknown): Checked<ExtensionContribution> {
  try {
    if (!contribution || typeof contribution !== 'object') {
      return { ok: false, reason: 'the contribution is not an object' };
    }
    const raw = contribution as Record<string, unknown>;
    const owner = raw.owner;
    const displayName = raw.displayName;
    const tools = raw.tools;
    if (typeof owner !== 'string' || !EXTENSION_ID_REGEX.test(owner)) {
      return { ok: false, reason: 'the extension id is invalid' };
    }
    if (!isText(displayName)) return { ok: false, reason: `${owner} has no display name` };
    if (!Array.isArray(tools) || tools.length === 0) {
      return { ok: false, reason: `${displayName} contributes no tools` };
    }
    const checked: ExtensionToolSpec[] = [];
    const names = new Set<string>();
    for (const [index, tool] of [...(tools as unknown[])].entries()) {
      const result = checkTool(tool, index);
      if (!result.ok) return { ok: false, reason: `${displayName}: ${result.reason}` };
      if (names.has(result.value.name)) {
        return { ok: false, reason: `${displayName} declares "${result.value.name}" twice` };
      }
      names.add(result.value.name);
      checked.push(result.value);
    }
    return {
      ok: true,
      value: Object.freeze({ owner, displayName, tools: Object.freeze(checked) }),
    };
  } catch (err) {
    return {
      ok: false,
      reason: `the contribution could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
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
 * Every definition, and its surfaces, is frozen.
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
      invoke: (_deps, input, context) => tool.invoke(input, context),
    };
    return Object.freeze(definition);
  });
}
