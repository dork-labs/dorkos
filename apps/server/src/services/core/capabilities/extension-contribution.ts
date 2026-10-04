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
  CAPABILITY_TIERS,
  EXTENSION_CAPABILITY_ID_PREFIX,
  EXTENSION_MCP_TOOL_NAME_MAX,
  EXTENSION_TOOL_NAME_PATTERN,
  EXTENSION_TOOL_TITLE_MAX,
  extensionDomainName,
  isSecretInputKey,
  type CapabilitySource,
  type CapabilityTier,
} from '@dorkos/shared/capabilities';
import { EXTENSION_ID_REGEX } from '@dorkos/shared/extension-id';
import type { PermissionAreaId } from '@dorkos/shared/permissions';

import type { CapabilityDefinition } from './capability-definition.js';
import { portableInputShape } from './portable-input-shape.js';
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
export const EXTENSION_DISPLAY_NAME_MAX = 40;

/**
 * Names an extension may not call itself, compared after lowercasing and
 * dropping everything but letters and digits: a row or card reading "From
 * DorkOS" would claim the tool is DorkOS's own.
 */
const RESERVED_DISPLAY_NAMES: ReadonlySet<string> = new Set(['dorkos', 'dorkbot']);

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

/** Either a usable value or the sentence saying why it was refused. */
type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Characters author text on a card may not contain: the straight double quote
 * and every typographic quote mark (`“ ” „ ‟ ‘ ’ ‚ ‛ « » ‹ ›`, CJK and
 * full-width quotes), C0/C1 controls (`\p{Cc}`), the line and paragraph separators, and
 * every format character (`\p{Cf}`).
 */
const CARD_TEXT_REFUSED =
  /["\p{Cc}\u00ab\u00bb\u2018-\u201f\u2039\u203a\u2028\u2029\u300c-\u300f\u301d-\u301f\uff02\uff07\p{Cf}]/u;

/**
 * Whether a display name contains a letter outside ASCII, after NFKC folds
 * compatibility forms (full-width letters, ligatures) to their plain letters.
 * Refused because a look-alike letter — a Cyrillic `о` in "DоrkOS" — would let
 * a name read as one the reserved-name check refuses.
 */
function hasNonAsciiLetter(value: string): boolean {
  return /[^\p{ASCII}]/u.test(value.normalize('NFKC').replace(/[^\p{L}]/gu, ''));
}

/** Whether a value is a non-empty string after trimming. */
function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Whether author text is safe to put on a card: a non-empty single line within
 * `max` characters, with no quote mark, no control character and no invisible
 * format character. A quote, straight or typographic, could close (or look as
 * if it closed) the card's quoted title and forge a field after it; a newline
 * or control character could fake a second line; a format character (Unicode
 * category Cf: zero-width spaces, bidi overrides and isolates, the BOM, soft
 * hyphens) can hide text or reorder what a person reads.
 */
function isCardText(value: unknown, max: number): value is string {
  return (
    isText(value) && value.length <= max && value === value.trim() && !CARD_TEXT_REFUSED.test(value)
  );
}

/**
 * Find the first JSON Schema construct an agent tool list cannot carry.
 *
 * `propertyNames` is what `z.record` (and `z.json`) render to, and a record
 * anywhere in any in-session tool's input empties the whole `dorkos` tool list
 * on the current Claude SDK (`tool-exposure.ts`). `$ref` and `patternProperties`
 * come from the same family, and an `additionalProperties` that is anything but
 * `false` is an open map (catchall, loose) the spec refuses as well (§2).
 *
 * @returns The offending keyword, or `undefined` when the schema is closed.
 */
function openSchemaKeyword(node: unknown): string | undefined {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = openSchemaKeyword(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!node || typeof node !== 'object') return undefined;
  const record = node as Record<string, unknown>;
  for (const keyword of ['propertyNames', 'patternProperties', '$ref', '$defs']) {
    if (keyword in record) return keyword;
  }
  if ('additionalProperties' in record && record.additionalProperties !== false) {
    return 'additionalProperties';
  }
  for (const value of Object.values(record)) {
    const found = openSchemaKeyword(value);
    if (found) return found;
  }
  return undefined;
}

/**
 * The first open-ended or self-referencing schema anywhere inside `schema`:
 * a `z.record` (which one tool would use to empty the whole `dorkos` tool list
 * on the current Claude SDK, `tool-exposure.ts`) or a `z.lazy`. Walks the Zod
 * tree itself rather than its JSON rendering, so a record the renderer happened
 * to spell some other way is still found.
 *
 * @returns `record` or `lazy`, or `undefined` when there is neither.
 */
function openZodNode(schema: unknown, seen = new Set<unknown>()): string | undefined {
  if (!schema || typeof schema !== 'object' || seen.has(schema)) return undefined;
  seen.add(schema);
  if (schema instanceof z.ZodRecord) return 'record';
  if (schema instanceof z.ZodLazy) return 'lazy';
  const def = (schema as { _zod?: { def?: unknown } })._zod?.def;
  const children: unknown[] = [];
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') {
      if ('_zod' in value) children.push(value);
      else if (Object.getPrototypeOf(value) === Object.prototype) {
        Object.values(value).forEach(collect);
      }
    }
  };
  if (def && typeof def === 'object') Object.values(def).forEach(collect);
  for (const child of children) {
    const found = openZodNode(child, seen);
    if (found) return found;
  }
  return undefined;
}

/**
 * Check that an input schema renders as closed JSON Schema, and that the exact
 * field map an agent tool list advertises renders too.
 *
 * Rendering here, once, is what keeps one tool from breaking everyone else's:
 * the catalog renders every capability's schema on every read, and an
 * unrepresentable type (`z.date()`, a `.transform()`) throws there. The second
 * rendering is of the field map the MCP projection hands a tool list
 * ({@link portableInputShape}), so a schema accepted here is one the in-session
 * server can list.
 *
 * The one implementation for every caller: the registry runs it at contribute
 * time, and discovery runs it (through {@link checkExtensionContribution}) on
 * every tool an `extension.json` declares, so a manifest that loads names no
 * tool `contribute` would refuse.
 */
function checkSchema(name: string, input: z.ZodObject): string | undefined {
  let rendered: unknown;
  try {
    rendered = z.toJSONSchema(input);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return `tool "${name}" input cannot be written as JSON Schema: ${why}`;
  }
  const keyword = openSchemaKeyword(rendered);
  if (keyword) return `tool "${name}" input uses ${keyword}, which agent tool lists cannot carry`;
  const node = openZodNode(input);
  if (node)
    return `tool "${name}" input uses a ${node} schema, which agent tool lists cannot carry`;
  try {
    z.toJSONSchema(z.object(portableInputShape(input.shape)));
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return `tool "${name}" input can't be listed: ${why}`;
  }
  return undefined;
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
  if (!isCardText(title, EXTENSION_TITLE_MAX)) {
    return {
      ok: false,
      reason: `tool "${name}" title must be one line of at most ${EXTENSION_TITLE_MAX} characters, with no quotes`,
    };
  }
  if (!isText(description)) return { ok: false, reason: `tool "${name}" has no description` };
  if (typeof tier !== 'string' || !(CAPABILITY_TIERS as readonly string[]).includes(tier)) {
    return { ok: false, reason: `tool "${name}" has an unknown tier` };
  }
  if (!(input instanceof z.ZodObject)) {
    return { ok: false, reason: `tool "${name}" input is not an object schema` };
  }
  const schemaProblem = checkSchema(name, input);
  if (schemaProblem) return { ok: false, reason: schemaProblem };
  if (typeof invoke !== 'function') {
    return { ok: false, reason: `tool "${name}" has no handler` };
  }

  const keys = Object.keys(input.shape);
  let fields: readonly string[] | undefined;
  if (displayFields !== undefined) {
    if (!Array.isArray(displayFields)) {
      return { ok: false, reason: `tool "${name}" display fields are not a list` };
    }
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
  // The same rule capability conformance holds core actions to: anything that
  // can raise a card says what the card shows, and a destructive card always
  // shows something. Only an `act` tool that takes no arguments may show none.
  if (tier !== 'observe') {
    if (!fields) {
      return { ok: false, reason: `tool "${name}" must say which fields its approval card shows` };
    }
    if (fields.length === 0 && (tier === 'destructive' || keys.length > 0)) {
      return { ok: false, reason: `tool "${name}" approval card would show none of its fields` };
    }
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
    // `--` or a trailing `-` would put `__` in, or `_` at the end of, the
    // domain, and the MCP name `ext_<id>__<tool>` could then be read two ways.
    if (
      typeof owner !== 'string' ||
      !EXTENSION_ID_REGEX.test(owner) ||
      owner.includes('--') ||
      owner.endsWith('-')
    ) {
      return { ok: false, reason: 'the extension id is invalid' };
    }
    if (!isCardText(displayName, EXTENSION_DISPLAY_NAME_MAX)) {
      return {
        ok: false,
        reason: `${owner} display name must be one line of at most ${EXTENSION_DISPLAY_NAME_MAX} characters, with no quotes`,
      };
    }
    if (hasNonAsciiLetter(displayName)) {
      return { ok: false, reason: `${owner} display name must use plain letters A to Z` };
    }
    if (
      RESERVED_DISPLAY_NAMES.has(
        displayName
          .normalize('NFKC')
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '')
      )
    ) {
      return { ok: false, reason: `${owner} may not call itself ${displayName}` };
    }
    if (!Array.isArray(tools) || tools.length === 0) {
      return { ok: false, reason: `${displayName} contributes no tools` };
    }
    const domain = extensionDomainName(owner);
    const checked: ExtensionToolSpec[] = [];
    const names = new Set<string>();
    for (const [index, tool] of [...(tools as unknown[])].entries()) {
      const result = checkTool(tool, index);
      if (!result.ok) return { ok: false, reason: `${displayName}: ${result.reason}` };
      if (names.has(result.value.name)) {
        return { ok: false, reason: `${displayName} declares "${result.value.name}" twice` };
      }
      const toolName = `${domain}__${result.value.name}`;
      if (toolName.length > EXTENSION_MCP_TOOL_NAME_MAX) {
        return {
          ok: false,
          reason: `${displayName}: tool "${result.value.name}" makes the name ${toolName}, longer than ${EXTENSION_MCP_TOOL_NAME_MAX} characters`,
        };
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
