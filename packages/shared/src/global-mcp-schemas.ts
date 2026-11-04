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
export const SECRET_NAME_PATTERN =
  /TOKEN|KEY|SECRET|PASS|PWD|BEARER|AUTH|COOKIE|CREDENTIAL|DATABASE_URL|DSN/i;

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

/** Programs that fetch and run the package named in their arguments. */
const PACKAGE_RUNNERS = new Set(['npx', 'bunx', 'uvx']);

/** Flags that change nothing about which package a runner runs. */
const QUIET_RUNNER_FLAGS = new Set(['-y', '--yes', '-q', '--quiet']);

/** A package spec with an exact version: `name@1.2.3`, `@scope/name@1.2.3`, `name==1.2.3`. */
const PINNED_SPEC = /(?:.@|==)\d[^/\s]*$/;

/**
 * The package a runner will run, or `undefined`. Any flag beyond the quiet ones
 * can change what really runs (`npx --package=other name`), so then it names
 * nothing rather than something that might not be true.
 *
 * @param command - The program.
 * @param args - Its arguments.
 */
export function runnerPackageSpec(command: string, args: readonly string[]): string | undefined {
  if (!PACKAGE_RUNNERS.has(command)) return undefined;
  const spec = args.find((arg) => !QUIET_RUNNER_FLAGS.has(arg));
  return spec === undefined || spec.startsWith('-') ? undefined : spec;
}

/**
 * Whether a command runs a package whose version could change later. A runner whose
 * arguments carry any other flag counts: `npx --package=other name` may not run `name`.
 *
 * @param command - The program.
 * @param args - Its arguments.
 */
export function isUnpinnedPackage(command: string, args: readonly string[]): boolean {
  if (!PACKAGE_RUNNERS.has(command)) return false;
  const spec = runnerPackageSpec(command, args);
  return spec === undefined || !PINNED_SPEC.test(spec);
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
  // Strict: a switch never changes what runs, so anything else is refused, not ignored.
  .strict()
  .refine((patch) => patch.enabled !== undefined || patch.excludedAgents !== undefined, {
    message: 'Nothing to change',
  });

export type GlobalMcpServerPatch = z.infer<typeof GlobalMcpServerPatchSchema>;

/**
 * One env var or header as a person sees it: its name, never its value. Reads
 * need no session at an open gate, so what a value holds stays out whatever its
 * name, and a later Edit starts from an empty field.
 */
export const GlobalMcpServerFieldSchema = z.object({
  name: z.string(),
  secret: z.boolean(),
});

export type GlobalMcpServerField = z.infer<typeof GlobalMcpServerFieldSchema>;

/**
 * Something on a server a person should look at: an env name that changes
 * what the program loads, or why a saved server is not started.
 */
export const GlobalMcpServerWarningSchema = z.object({
  /** The env name, or the server's name when the whole server is stopped. */
  name: z.string(),
  note: z.string(),
});

export type GlobalMcpServerWarning = z.infer<typeof GlobalMcpServerWarningSchema>;

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
  /** What to look at twice, and why a saved server is not started. */
  warnings: z.array(GlobalMcpServerWarningSchema),
});

export type GlobalMcpServerView = z.infer<typeof GlobalMcpServerViewSchema>;

/** `GET /api/mcp-servers`. */
export const GlobalMcpServerListSchema = z.object({
  servers: z.array(GlobalMcpServerViewSchema),
});

export type GlobalMcpServerList = z.infer<typeof GlobalMcpServerListSchema>;
