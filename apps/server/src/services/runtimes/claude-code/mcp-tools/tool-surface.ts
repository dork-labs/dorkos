/**
 * The `dorkos` server's tool surface as one comparable digest (DOR-2685, spec
 * `extension-agent-tools-and-skills` §6).
 *
 * A warm Claude Code process lists the `dorkos` tools once, when it launches.
 * The in-process server it was handed is rebuilt for every dispatch, but the
 * launch fingerprint compares MCP servers by declared config with the live
 * `instance` dropped (`launch-fingerprint.ts`), and an `sdk` server declares
 * nothing but its name. So an extension tool arriving or leaving, or a
 * permission change hiding a tool, never reached a warm process.
 *
 * The factory therefore records, per server instance, a digest of the tool
 * list a fresh launch would see: every tool's name and its input JSON Schema,
 * sorted by name. The `toolSurface` launch pin reads it back from the instance
 * in the launch options, so nothing new is sent to the CLI.
 *
 * ## The digest must be stable, or every warm process relaunches every turn
 *
 * The server is rebuilt per dispatch, so a digest that differed between two
 * builds of an unchanged tool set would relaunch every warm process on every
 * message. Three things keep it stable: tools are sorted by name, so the
 * order domains were assembled in does not count; each schema is serialized
 * with its keys sorted (`stableStringify`); and only the schema is hashed, never
 * the handler, the description or the loading hints, none of which change what
 * a tool takes. `tool-surface.test.ts` builds the real server twice and asserts
 * equal digests.
 *
 * @module services/runtimes/claude-code/mcp-tools/tool-surface
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { stableStringify } from '@dorkos/shared/capabilities';

/** One tool as the digest sees it: what the model calls it and what it takes. */
export interface ToolSurfaceEntry {
  /** The tool name on the server, unqualified. */
  readonly name: string;
  /**
   * The advertised input: a Zod field map (`tool()` definitions) or a whole
   * object schema (the connector tools registered on the server directly).
   */
  readonly inputSchema: z.ZodRawShape | z.ZodType;
}

/**
 * The input JSON Schema a `tools/list` would carry for one tool, the way the
 * MCP SDK converts it (input side of any pipe). A schema that cannot be
 * converted gets a fixed marker rather than throwing: the digest has to be
 * computed for every launch, and an unlistable schema is itself a fact about
 * the surface that must compare equal to itself.
 */
function inputJsonSchema(input: ToolSurfaceEntry['inputSchema']): unknown {
  try {
    const schema = input instanceof z.ZodType ? input : z.object(input);
    return z.toJSONSchema(schema, { io: 'input' });
  } catch {
    return '<unlistable>';
  }
}

/**
 * Digest a tool list: sha256 over the canonical JSON of the name-sorted
 * `{ name, inputJsonSchema }` pairs.
 *
 * @param entries - Every tool the server lists, in any order
 * @returns A hex digest equal for any two lists with the same names and schemas
 */
export function toolSurfaceDigest(entries: readonly ToolSurfaceEntry[]): string {
  const surface = [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((entry) => ({ name: entry.name, inputJsonSchema: inputJsonSchema(entry.inputSchema) }));
  return createHash('sha256').update(stableStringify(surface)).digest('hex');
}

/**
 * Digests by server instance. Weak, because every launch builds a new instance
 * and the map must not keep any of them alive.
 */
const surfaces = new WeakMap<object, string>();

/**
 * Record the tool surface of one in-process server instance.
 *
 * @param instance - The `McpServer` the factory built
 * @param entries - Every tool registered on it
 * @returns The recorded digest
 */
export function recordToolSurface(instance: object, entries: readonly ToolSurfaceEntry[]): string {
  const digest = toolSurfaceDigest(entries);
  surfaces.set(instance, digest);
  return digest;
}

/**
 * The tool-surface digest recorded for a server instance, if the DorkOS
 * factory built it.
 *
 * @param instance - The `instance` of an `sdk` MCP server config
 * @returns The digest, or `undefined` for an instance no factory recorded
 */
export function dorkosToolSurfaceOf(instance: unknown): string | undefined {
  if (instance === null || typeof instance !== 'object') return undefined;
  return surfaces.get(instance);
}
