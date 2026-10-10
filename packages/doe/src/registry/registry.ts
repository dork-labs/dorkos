import { createHash } from 'node:crypto';
import type {
  JsonValue,
  ToolDescriptor,
  ToolRegistry,
  ToolContext,
  ToolResult,
} from '../contracts.js';
import { Bm25Ranker } from './bm25.js';
/** Default maximum bytes for initially declared names, descriptions and schemas. */
export const INITIAL_SCHEMA_BUDGET_BYTES = 32768;
const MAX_MATCHES = 8;
function bounded(value: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new Error(`Limit must be between 1 and ${max}`);
}
function bytes(tools: readonly ToolDescriptor[]): number {
  return Buffer.byteLength(
    JSON.stringify(tools.map(({ name, description, schema }) => ({ name, description, schema })))
  );
}
/** Stable MCP qualification uses a source-identity hash, independent of connection order. */
export function mcpAlias(server: string, name: string): string {
  if (!server || !name) throw new Error('MCP server and tool names must be nonempty');
  const hash = createHash('sha256')
    .update(JSON.stringify([server, name]))
    .digest('hex')
    .slice(0, 20);
  const stem = `mcp_${server}_${name}`.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 43);
  return `${stem}_${hash}`;
}
/** Metadata-only inventory entry; schemas and callbacks never enter discovery output. */
export interface ToolMetadata {
  name: string;
  description: string;
  searchHint?: string;
  loaded: boolean;
}
/** Host-extensible deferred registry; search becomes visible through selected() before the next request. */
export class DeferredToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, ToolDescriptor>();
  private readonly active = new Set<string>();
  /** Explicit budgets cap loaded tools and schemas across repeated searches. */
  constructor(
    private readonly limits: {
      initialSchemaBytes?: number;
      selectedSchemaBytes?: number;
      selectedTools?: number;
    } = {}
  ) {
    bounded(limits.initialSchemaBytes ?? INITIAL_SCHEMA_BUDGET_BYTES, 1048576);
    bounded(limits.selectedSchemaBytes ?? 262144, 16777216);
    bounded(limits.selectedTools ?? 64, 1024);
  }
  /** Validate and register a host capability without executing it. */
  register(tool: ToolDescriptor): void {
    if (
      typeof tool.name !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(tool.name) ||
      ['constructor', 'prototype', '__proto__'].includes(tool.name)
    )
      throw new Error('Unsafe tool name');
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    if (
      typeof tool.description !== 'string' ||
      tool.description.length > 8192 ||
      typeof tool.execute !== 'function' ||
      !tool.schema ||
      typeof tool.schema !== 'object' ||
      Array.isArray(tool.schema) ||
      (tool.searchHint !== undefined &&
        (typeof tool.searchHint !== 'string' || tool.searchHint.length > 8192))
    )
      throw new Error('Invalid tool descriptor');
    const schema = JSON.parse(JSON.stringify(tool.schema)) as ToolDescriptor['schema'];
    const frozen = { ...tool, schema };
    if (tool.initialLoad) {
      const next = [...this.selected(), frozen];
      const initial = [...this.tools.values()].filter((t) => t.initialLoad);
      if (
        bytes([...initial, frozen]) >
          (this.limits.initialSchemaBytes ?? INITIAL_SCHEMA_BUDGET_BYTES) ||
        bytes(next) > (this.limits.selectedSchemaBytes ?? 262144) ||
        next.length > (this.limits.selectedTools ?? 64)
      )
        throw new Error('Initial or selected schema budget exceeded');
      this.active.add(tool.name);
    }
    this.tools.set(tool.name, frozen);
  }
  /** Return detached schemas for the next model request; previous request snapshots remain unchanged. */
  selected(): readonly ToolDescriptor[] {
    return [...this.active].map((name) => {
      const t = this.tools.get(name)!;
      return { ...t, schema: structuredClone(t.schema) };
    });
  }
  /** Search all metadata; each successful search replaces deferred selections for the next request. */
  search(query: string, limit = MAX_MATCHES): readonly ToolDescriptor[] {
    bounded(limit, MAX_MATCHES);
    if (typeof query !== 'string' || !query.trim() || query.length > 2048)
      throw new Error('Invalid search query');
    const docs = [...this.tools.values()].map((t) => ({
      name: t.name,
      text: `${t.name} ${t.description} ${t.searchHint ?? ''}`,
    }));
    const ranked = new Bm25Ranker().rank(query, docs, limit);
    const next = [...this.tools.values()].filter((t) => t.initialLoad);
    const matches: ToolDescriptor[] = [];
    for (const { name } of ranked) {
      const tool = this.tools.get(name)!;
      if (!tool.initialLoad) {
        if (
          next.length >= (this.limits.selectedTools ?? 64) ||
          bytes([...next, tool]) > (this.limits.selectedSchemaBytes ?? 262144)
        )
          continue;
        next.push(tool);
      }
      matches.push({ ...tool, schema: structuredClone(tool.schema) });
    }
    if (ranked.length && !matches.length)
      throw new Error('Matching tools exceed the selected schema or tool budget');
    this.active.clear();
    for (const tool of next) this.active.add(tool.name);
    return matches;
  }
  /** Bounded pages contain metadata only; offsets refer to deterministic registration order. */
  inventory(options: { offset?: number; limit?: number } = {}): {
    items: readonly ToolMetadata[];
    nextOffset?: number;
  } {
    const offset = options.offset ?? 0,
      limit = options.limit ?? 20;
    bounded(limit, 100);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid offset');
    const all = [...this.tools.values()],
      page = all.slice(offset, offset + limit);
    const items = page.map((t) => ({
      name: t.name,
      description: t.description.slice(0, 512),
      ...(t.searchHint ? { searchHint: t.searchHint.slice(0, 512) } : {}),
      loaded: this.active.has(t.name),
    }));
    return { items, ...(offset + limit < all.length ? { nextOffset: offset + limit } : {}) };
  }
  /** Execute only previously loaded tools. The host facade owns approvals. */
  async execute(name: string, args: JsonValue, context: ToolContext): Promise<ToolResult> {
    const t = this.tools.get(name);
    if (!t) throw new Error(`Unknown tool: ${name}`);
    if (!this.active.has(name)) throw new Error(`Tool not loaded: ${name}`);
    context.signal.throwIfAborted();
    return t.execute(args, context);
  }
}
/** Fixed-schema discovery tool; registration count never changes its prompt or parameters. */
export function createToolSearch(registry: ToolRegistry): ToolDescriptor {
  return {
    name: 'tool_search',
    description: 'Find and load tools for the next request.',
    initialLoad: true,
    schema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 8 } },
      required: ['query'],
      additionalProperties: false,
    },
    execute: async (args) => {
      if (
        !args ||
        typeof args !== 'object' ||
        Array.isArray(args) ||
        typeof args.query !== 'string' ||
        (args.limit !== undefined && typeof args.limit !== 'number')
      )
        throw new Error('Invalid tool search arguments');
      const matches = registry.search(args.query, args.limit as number | undefined);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              matches.map((t) => ({ name: t.name, description: t.description.slice(0, 512) }))
            ),
          },
        ],
        structuredContent: { loaded: matches.map((t) => t.name) },
      };
    },
  };
}
/** Compose supplied business built-ins with tool search; host descriptors retain their load flags. */
export function createDefaultToolRegistry(
  initialTools: readonly ToolDescriptor[],
  hostTools: readonly ToolDescriptor[] = []
): DeferredToolRegistry {
  const registry = new DeferredToolRegistry();
  registry.register(createToolSearch(registry));
  const permitted = new Set(['read', 'write', 'web_fetch', 'load_skill', 'builder']);
  for (const tool of initialTools) {
    if (!permitted.has(tool.name)) throw new Error('Invalid business built-in');
    registry.register({ ...tool, initialLoad: true });
  }
  for (const tool of hostTools) registry.register(tool);
  return registry;
}
