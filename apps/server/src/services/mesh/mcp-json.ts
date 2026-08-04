/**
 * Reading a Claude Code `.mcp.json` at a workspace root, in two shapes the rest
 * of the server needs: a light `{ name, type }` summary for the discovered
 * roster (`routes/mcp-config.ts`), and a full connection resolver that maps one
 * named entry to the neutral {@link McpServerTransport} for the managed-store
 * import (`mcp.import`, DOR-894).
 *
 * The file is a Claude-specific artifact — its per-server entry is either a
 * stdio command (`command`/`args`/`env`, no `type` or `type: "stdio"`) or a
 * remote endpoint (`type: "http" | "sse"` with `url`/`headers`). Everything here
 * is runtime-neutral: it parses JSON and maps fields, importing no runtime SDK.
 *
 * @module services/mesh/mcp-json
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { McpServerTransportSchema, type McpServerTransport } from '@dorkos/shared/mesh-schemas';

/** The `.mcp.json` file name at a workspace root. */
const MCP_JSON_FILE = '.mcp.json';

/** A discovered server reduced to what the read-only roster shows. */
export interface McpJsonServerSummary {
  /** The server name (the key under `mcpServers`). */
  name: string;
  /** Its transport kind, defaulting to `stdio` when the entry omits `type`. */
  type: 'stdio' | 'sse' | 'http';
}

/**
 * One raw `.mcp.json` server entry, parsed leniently: every field is optional so
 * a partial or unfamiliar entry never throws here — {@link resolveMcpJsonConnection}
 * decides whether the fields present form a usable connection.
 */
const McpJsonEntrySchema = z.object({
  type: z.enum(['stdio', 'http', 'sse']).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

/** The `.mcp.json` document, reduced to the `mcpServers` map this module reads. */
const McpJsonDocumentSchema = z.object({
  mcpServers: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Read and parse the `mcpServers` map from a workspace's `.mcp.json`.
 *
 * A missing file, unreadable file, or malformed JSON all resolve to an empty
 * map — a discovered roster treats "no readable config" and "config with no
 * servers" the same way. Entry VALUES are returned raw (`unknown`); callers map
 * them with {@link summarizeMcpJsonServers} or {@link resolveMcpJsonConnection}.
 *
 * @param cwd - Absolute workspace directory holding the `.mcp.json`.
 * @returns The `mcpServers` map, keyed by server name, or `{}` when unavailable.
 */
export async function readMcpJsonServers(cwd: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path.join(cwd, MCP_JSON_FILE), 'utf-8');
    const parsed = McpJsonDocumentSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return {};
    return parsed.data.mcpServers ?? {};
  } catch {
    return {};
  }
}

/**
 * Reduce a raw `mcpServers` map to the `{ name, type }` summaries the read-only
 * discovered roster shows. An entry with no `type` is reported as `stdio`, which
 * is how Claude Code treats a bare command entry.
 *
 * @param servers - The raw `mcpServers` map from {@link readMcpJsonServers}.
 * @returns One summary per declared server.
 */
export function summarizeMcpJsonServers(servers: Record<string, unknown>): McpJsonServerSummary[] {
  return Object.entries(servers).map(([name, value]) => {
    const parsed = McpJsonEntrySchema.safeParse(value);
    const type = (parsed.success ? parsed.data.type : undefined) ?? 'stdio';
    return { name, type };
  });
}

/**
 * Resolve one named `.mcp.json` server to the neutral {@link McpServerTransport},
 * or `null` when no entry matches the name or its fields do not form a valid
 * connection.
 *
 * The mapped candidate is validated through {@link McpServerTransportSchema}, so
 * the result carries the schema's defaults (`args`/`env`/`headers`) and a bad
 * URL or a stdio entry missing its command resolves to `null` rather than a
 * half-formed connection.
 *
 * @param servers - The raw `mcpServers` map from {@link readMcpJsonServers}.
 * @param name - The server name to resolve.
 * @returns The neutral connection, or `null` when unresolvable.
 */
export function resolveMcpJsonConnection(
  servers: Record<string, unknown>,
  name: string
): McpServerTransport | null {
  const raw = servers[name];
  if (raw === undefined) return null;

  const parsed = McpJsonEntrySchema.safeParse(raw);
  if (!parsed.success) return null;
  const entry = parsed.data;
  const type = entry.type ?? 'stdio';

  let candidate: unknown;
  if (type === 'stdio') {
    if (!entry.command) return null;
    candidate = { transport: 'stdio', command: entry.command, args: entry.args, env: entry.env };
  } else {
    if (!entry.url) return null;
    candidate = { transport: type, url: entry.url, headers: entry.headers };
  }

  const result = McpServerTransportSchema.safeParse(candidate);
  return result.success ? result.data : null;
}
