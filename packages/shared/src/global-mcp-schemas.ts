/**
 * MCP servers a person adds once for every agent (DOR-3213): the wire shapes of
 * Connections → MCP servers.
 *
 * A global server is the same connection an agent's own managed server is
 * (`McpServerTransportSchema`), plus two things an agent's never needs: the
 * agents it is kept from (`excludedAgents`), and which of its env and header
 * names hold secrets. Secret values go in once, typed by a person, and never
 * come back out: the view carries the name and `secret: true`, with no value.
 *
 * @module shared/global-mcp-schemas
 */
import { z } from 'zod';
import { McpServerTransportSchema } from './mesh-schemas.js';

/**
 * Names that hold a secret unless a person says otherwise: any env or header
 * name containing one of these words, `Authorization` included.
 */
export const SECRET_NAME_PATTERN = /TOKEN|KEY|SECRET|PASSWORD|AUTH|COOKIE/i;

/**
 * Whether an env or header name holds a secret: it matches
 * {@link SECRET_NAME_PATTERN}, or a person marked it.
 *
 * @param name - The env or header name.
 * @param marked - Names a person marked secret.
 */
export function isSecretName(name: string, marked: readonly string[] = []): boolean {
  return SECRET_NAME_PATTERN.test(name) || marked.includes(name);
}

/** A global server's name: the same rule an agent's managed server follows. */
export const GlobalMcpServerNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, 'Use letters, numbers, dashes and underscores');

/** What a person sends to add a global server, or to replace one. */
export const GlobalMcpServerInputSchema = z.object({
  name: GlobalMcpServerNameSchema,
  connection: McpServerTransportSchema,
  /** Extra env or header names to keep secret, beyond {@link SECRET_NAME_PATTERN}. */
  secretNames: z.array(z.string().min(1)).max(64).default([]),
  /** Agent ids this server is kept from. Empty means every agent. */
  excludedAgents: z.array(z.string().min(1)).max(500).default([]),
  /** Off until a person turns it on, like an agent's own server. */
  enabled: z.boolean().default(false),
});

export type GlobalMcpServerInput = z.infer<typeof GlobalMcpServerInputSchema>;

/** The two switches a person can flip without re-entering the server. */
export const GlobalMcpServerPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    excludedAgents: z.array(z.string().min(1)).max(500).optional(),
  })
  .refine((patch) => patch.enabled !== undefined || patch.excludedAgents !== undefined, {
    message: 'Nothing to change',
  });

export type GlobalMcpServerPatch = z.infer<typeof GlobalMcpServerPatchSchema>;

/** One env var or header as a person sees it: a secret shows its name only. */
export const GlobalMcpServerFieldSchema = z.object({
  name: z.string(),
  secret: z.boolean(),
  /** Absent for a secret, always. */
  value: z.string().optional(),
});

export type GlobalMcpServerField = z.infer<typeof GlobalMcpServerFieldSchema>;

/** One global server as Connections → MCP servers lists it. */
export const GlobalMcpServerViewSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
  transport: z.enum(['stdio', 'http', 'sse']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  env: z.array(GlobalMcpServerFieldSchema),
  headers: z.array(GlobalMcpServerFieldSchema),
  excludedAgents: z.array(z.string()),
  addedAt: z.string(),
  /**
   * Runtimes that skip this server. Codex and OpenCode cannot connect an
   * SSE-only server, so their agents go without it.
   */
  skippedOn: z.array(z.enum(['codex', 'opencode'])),
});

export type GlobalMcpServerView = z.infer<typeof GlobalMcpServerViewSchema>;

/** `GET /api/mcp-servers`. */
export const GlobalMcpServerListSchema = z.object({
  servers: z.array(GlobalMcpServerViewSchema),
});

export type GlobalMcpServerList = z.infer<typeof GlobalMcpServerListSchema>;
