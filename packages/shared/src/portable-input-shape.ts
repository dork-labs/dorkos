/**
 * The advertised form of a capability's input field map (DOR-2053). Shared so
 * the server's MCP projection and the extension tool check (in
 * `@dorkos/extension-api`, also run by `dorkos marketplace validate`) render
 * exactly the same field map.
 *
 * @module @dorkos/shared/portable-input-shape
 */
import { z } from 'zod';

/**
 * The substituting wrapper on a field, if it has one: the schema underneath it
 * and the value it fills in for an absent key.
 *
 * `.default()` and `.prefault()` are the two wrappers that SUBSTITUTE; a
 * `.optional()` around either is transparent here, because the rebuilt field is
 * made optional again anyway. Everything else — a plain `.optional()`, a
 * required field — returns `undefined` and is advertised untouched.
 */
function substitutingDefault(
  field: z.core.$ZodType
): { inner: z.ZodType; value: unknown } | undefined {
  if (field instanceof z.ZodDefault || field instanceof z.ZodPrefault) {
    return { inner: field.unwrap() as z.ZodType, value: field.def.defaultValue };
  }
  if (field instanceof z.ZodOptional) {
    return substitutingDefault(field.unwrap() as z.core.$ZodType);
  }
  return undefined;
}

/**
 * Re-advertise every `.default(…)` field of an MCP input shape as an ordinary
 * optional one, so a no-argument call survives the trip through a FOREIGN Zod.
 *
 * Zod 4.6 split optionality into three rungs — required, `"optional"`, and a new
 * middle `"defaulted"` — and moved `.default(…)` onto the middle one
 * (`_zod.optin`, `zod/v4/core/schemas.js`). A raw field map is not a schema: the
 * consumer rebuilds it into an object of its OWN making, and that object decides
 * which keys may be absent by reading those rungs. The Claude Agent SDK inlines
 * its own copies of Zod and the MCP SDK rather than importing ours, and that copy
 * predates the middle rung: it asks `optin === "optional"`, reads `"defaulted"`,
 * and files the key as required. Calling `list_capabilities` with no arguments
 * therefore failed validation before the handler ever ran — `Invalid input:
 * expected nonoptional, received undefined` at `limit` — and so did eight more
 * tools with a defaulted field (DOR-2053).
 *
 * So the shape that crosses that boundary uses only the two rungs every Zod 4
 * agrees on. **The default itself is not dropped**: `registry.invoke` parses the
 * arguments through the capability's OWN schema, which still carries
 * `.default(…)`, so an absent key is filled exactly as before — the shape here is
 * an ADVERTISEMENT, and the registry is the validator. The `default` and
 * `description` annotations are carried onto the rebuilt field, so the JSON
 * Schema the model reads is unchanged too.
 *
 * This works because a capability's arguments are parsed TWICE. A hand-registered
 * tool is parsed once and gets whatever the SDK produced, so the same rewrite
 * there would trade a loud failure for a silent `undefined` — which is why
 * `mcp-tool-gate.ts` does not do it, and why a hand-registered tool must not
 * default an argument at all.
 *
 * `runtimes/claude-code/mcp-tools/__tests__/mcp-default-arguments.test.ts` holds
 * the drift guard for both halves — it lives there because only that directory
 * may import the Agent SDK, and the guard has to fail against the real SDK rather
 * than against a restatement of it. The invariant it pins is about RAW FIELD MAPS,
 * not about tools: no raw field map crossing to the Agent SDK may carry a field on
 * the middle rung. A capability that hands over a whole `ZodObject` instead is
 * outside it and needs nothing from this function — the object is parsed by the
 * schema's own `run`, so `optin` is never consulted. That is why the seven
 * `CONNECTOR_RUNTIME_CAPABILITY_IDS`, one of which defaults `requestedEvents`, are
 * safe while declaring `surfaces: {}` and never reaching here.
 *
 * Still required as of `@anthropic-ai/claude-agent-sdk@0.3.272` (the latest
 * release on 2026-09-15): its bundle contains no `"defaulted"` string and still
 * asks `optin === "optional"`, and a raw `.default(…)` field run through its
 * `tool()` still fails the same way. Which points at the real retirement: the
 * cause is the raw field map, so registering these capabilities with their full
 * `ZodObject` — the way `registerClaudeConnectorCapabilityTools` already does —
 * would remove the need for this function altogether.
 *
 * @param shape - The advertised field map.
 * @returns The same map, with every substituting field re-labelled optional.
 *   Returns the input untouched when there is nothing to re-label.
 */
export function portableInputShape(shape: z.ZodRawShape): z.ZodRawShape {
  let rebuilt: Record<string, z.core.$ZodType> | undefined;
  for (const [key, field] of Object.entries(shape)) {
    const substituting = substitutingDefault(field);
    if (!substituting) continue;
    rebuilt ??= { ...shape };
    const description = (field as z.ZodType).description;
    rebuilt[key] = substituting.inner.optional().meta({
      ...(description === undefined ? {} : { description }),
      default: substituting.value,
    });
  }
  return rebuilt ?? shape;
}
