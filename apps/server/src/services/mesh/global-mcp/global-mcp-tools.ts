/**
 * What a global MCP server can do, read when a person opens its sheet
 * (DOR-4118), and which of its tools are new.
 *
 * - **Started only for a person, and only when it is on.** The check runs from
 *   the person-only `/api/mcp-servers` routes when the sheet opens, through the
 *   same probe and timeout as `mcp_test_server`. A server that is off, or that
 *   the store would not hand an agent, is never started: it answers
 *   `not-checked` (Security, Nov 12).
 * - **Untrusted text.** Tool names and descriptions come from the server. They
 *   are shown to the person as plain text and never put in an agent's context.
 *   The server also picks how many and how long, so both are capped before
 *   anything is kept or said ({@link MAX_CHECKED_TOOLS} and the two lengths).
 * - **Its own file.** First-seen times live in `{dorkHome}/mcp/global-server-tools.json`,
 *   beside the servers file and never inside it, so a check cannot move the
 *   store's fingerprint or a held change's step-up hash.
 *
 * @module services/mesh/global-mcp/global-mcp-tools
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { runProbe, type ProbedTool, type ProbeOutcome } from '../agent-mcp-probe.js';
import type { McpServerTransport } from '@dorkos/shared/mesh-schemas';

/** How long a tool the server added after its first check reads as new. */
export const NEW_TOOL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The most tools one check keeps; the rest are counted, not kept. */
export const MAX_CHECKED_TOOLS = 200;

/** A tool whose name is longer than this is counted, not kept. */
export const MAX_TOOL_NAME_LENGTH = 128;

/** A description is cut to this many characters. */
export const MAX_TOOL_DESCRIPTION_LENGTH = 500;

/** One tool as the sheet shows it. */
export interface CheckedTool extends ProbedTool {
  /** The server added it since an earlier check, within {@link NEW_TOOL_WINDOW_MS}. */
  isNew: boolean;
}

/** What opening a server's sheet found. */
export type ServerToolsCheck =
  | { status: 'not-checked' }
  | {
      status: 'ok';
      tools: CheckedTool[];
      added: string[];
      /** Tools the server listed past the caps, which were not kept. */
      omitted: number;
    }
  | { status: 'needs-sign-in' }
  | { status: 'unreachable'; error: string }
  | {
      /** It answered, but its name is one of DorkOS's own, so no agent gets these (DOR-4262). */
      status: 'reserved-name';
      tools: CheckedTool[];
      added: string[];
      omitted: number;
    };

const LedgerSchema = z.object({
  version: z.literal(1),
  servers: z.record(
    z.string(),
    z.object({
      tools: z.record(
        z.string(),
        z.object({ firstSeen: z.string(), afterFirstCheck: z.boolean() })
      ),
    })
  ),
});
type Ledger = z.infer<typeof LedgerSchema>;

/** The file a server's tools are remembered in, under the data directory. */
export function toolLedgerPath(dorkHome: string): string {
  return path.join(dorkHome, 'mcp', 'global-server-tools.json');
}

/** Remembers which tools each global server had, and when each first appeared. */
export class GlobalMcpToolLedger {
  private writes: Promise<unknown> = Promise.resolve();

  /**
   * Build a ledger over the data directory.
   *
   * @param dorkHome - The DorkOS data directory.
   * @param now - The clock; the real one by default.
   */
  constructor(
    private readonly dorkHome: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  /**
   * Record what a check found and answer the sheet's view of it. The first
   * check of a server marks nothing new; a tool seen after that is new.
   *
   * @param server - The server's name.
   * @param tools - What the probe listed.
   * @returns The tools with their new marks, and the names added since the last check.
   */
  record(
    server: string,
    tools: readonly ProbedTool[]
  ): Promise<{ tools: CheckedTool[]; added: string[] }> {
    const run = this.writes.then(async () => {
      const ledger = await this.read();
      const before = ledger.servers[server];
      const now = this.now();
      const known = { ...before?.tools };
      const added: string[] = [];
      for (const tool of tools) {
        if (known[tool.name]) continue;
        known[tool.name] = { firstSeen: now.toISOString(), afterFirstCheck: before !== undefined };
        if (before !== undefined) added.push(tool.name);
      }
      ledger.servers[server] = { tools: known };
      await this.write(ledger);
      return {
        tools: tools.map((tool) => {
          const seen = known[tool.name]!;
          const age = now.getTime() - Date.parse(seen.firstSeen);
          return { ...tool, isNew: seen.afterFirstCheck && age < NEW_TOOL_WINDOW_MS };
        }),
        added,
      };
    });
    this.writes = run.catch(() => undefined);
    return run;
  }

  /** The ledger on disk, or an empty one when it is missing or unreadable. */
  private async read(): Promise<Ledger> {
    try {
      return LedgerSchema.parse(
        JSON.parse(await fs.readFile(toolLedgerPath(this.dorkHome), 'utf8'))
      );
    } catch {
      return { version: 1, servers: {} };
    }
  }

  /** Write through a temp file, renamed into place, readable by this user only. */
  private async write(ledger: Ledger): Promise<void> {
    const file = toolLedgerPath(this.dorkHome);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(ledger, null, 2), { mode: 0o600 });
    await fs.rename(temp, file);
  }
}

/**
 * The tools a check may keep: at most {@link MAX_CHECKED_TOOLS}, none with an
 * overlong name, each description cut to {@link MAX_TOOL_DESCRIPTION_LENGTH}.
 *
 * @param tools - What the server listed.
 * @returns The kept tools, and how many were left out.
 */
export function capProbedTools(tools: readonly ProbedTool[]): {
  kept: ProbedTool[];
  omitted: number;
} {
  const named = tools.filter(
    (tool) => tool.name.length > 0 && tool.name.length <= MAX_TOOL_NAME_LENGTH
  );
  const kept = named.slice(0, MAX_CHECKED_TOOLS).map((tool) => ({
    name: tool.name,
    description:
      tool.description.length > MAX_TOOL_DESCRIPTION_LENGTH
        ? `${tool.description.slice(0, MAX_TOOL_DESCRIPTION_LENGTH - 1)}…`
        : tool.description,
  }));
  return { kept, omitted: tools.length - kept.length };
}

/**
 * Check one global server's tools for a person opening its sheet.
 *
 * @param connection - What the store would hand an agent, or `null` when the
 *   server is off or refused, which is never started.
 * @param server - The server's name.
 * @param ledger - Where first-seen times are kept.
 * @param probe - The probe; the real one, with its timeout, by default.
 */
export async function checkServerTools(
  connection: McpServerTransport | null,
  server: string,
  ledger: GlobalMcpToolLedger,
  probe: (connection: McpServerTransport) => Promise<ProbeOutcome> = (c) => runProbe(c)
): Promise<ServerToolsCheck> {
  if (connection === null) return { status: 'not-checked' };
  const outcome = await probe(connection);
  if (outcome.kind === 'unauthorized') return { status: 'needs-sign-in' };
  if (outcome.kind === 'failed') return { status: 'unreachable', error: outcome.error };
  const { kept, omitted } = capProbedTools(outcome.tools);
  return { status: 'ok', ...(await ledger.record(server, kept)), omitted };
}
