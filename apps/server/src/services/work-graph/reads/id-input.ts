/**
 * How the work graph's reads take the chat or agent they are asked about: a
 * bare id, or its `dork:` reference (`dork:chat:<id>`, `dork:agent:<id>`),
 * read by the one parser (`@dorkos/shared/dork-ref`). Neither form can hold
 * `/` or `%`, so both are safe in a path segment. An address
 * (`dork:<space>/<handle>`) holds a `/` and is not taken here.
 *
 * @module services/work-graph/reads/id-input
 */
import { z } from 'zod';
import { DORK_SCHEME, isDorkId, parseDorkReference } from '@dorkos/shared/dork-ref';
import { CapabilityToolError } from '../../core/capabilities/index.js';

/** The longest id input taken: a `dork:agent:` prefix and a 64-character id. */
const ID_INPUT_MAX = 96;

/**
 * An input field that names a chat or an agent, by id or `dork:` reference.
 *
 * @param what - What it names, for the field's description.
 */
export function idInput(what: 'chat' | 'agent') {
  return z
    .string()
    .min(1)
    .max(ID_INPUT_MAX)
    .describe(`The ${what}'s id, or its \`dork:${what}:\` reference.`);
}

/**
 * The id an input names. A `dork:` reference of another kind, or anything
 * that is neither a bare id nor a reference, is refused `INVALID_REFERENCE`.
 *
 * @param input - The field as sent.
 * @param kind - What it must name.
 * @returns The bare id.
 */
export function idOf(input: string, kind: 'chat' | 'agent'): string {
  if (!input.startsWith(DORK_SCHEME)) {
    if (isDorkId(input)) return input;
  } else {
    const parsed = parseDorkReference(input, kind);
    if (parsed.ok) return parsed.value.id;
  }
  throw new CapabilityToolError({
    code: 'INVALID_REFERENCE',
    error: `That is not a ${kind} id or a dork:${kind}: reference.`,
  });
}
