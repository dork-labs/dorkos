/**
 * The seam every DorkOS write that may change an agent's runtime, model or
 * effort passes through, so the observer of outside changes never mistakes
 * DorkOS's own write for one (DOR-2337).
 *
 * The writes live in two places that are built long before the task store the
 * observer needs (`updateAgentManifest`, and the mesh route's
 * `meshCore.update`), so the observer is installed here at boot rather than
 * threaded through both. Until it is installed, and in every test that does not
 * install one, a write simply runs.
 *
 * @module services/core/agent-observation/agent-execution-writes
 */
import { requestNamesExecutionField } from '../operator/agent-execution.js';

/** Runs one write around the observer's bookkeeping. */
export type AgentExecutionWriteBracket = (
  agentPath: string,
  write: () => Promise<void>
) => Promise<void>;

let bracket: AgentExecutionWriteBracket | undefined;

/**
 * Install (or, with `undefined`, remove) the bracket DorkOS's execution writes
 * run through. Called once at boot, after the observer exists.
 *
 * @param next - The observer's `writingExecution`, bound.
 */
export function initAgentExecutionWrites(next: AgentExecutionWriteBracket | undefined): void {
  bracket = next;
}

/**
 * Run one of DorkOS's own agent writes, through the bracket when its request
 * names the runtime, model or effort. A write that names none of them leaves
 * them as the file has them, so it needs no bracket: an outside edit it carries
 * along is still there for the next check to see.
 *
 * @param body - The request the write carries out, as it arrived.
 * @param agentPath - The agent's project directory, when it is known.
 * @param write - The write itself.
 * @returns What the write returned.
 */
export async function writeAgentManifest<T>(
  body: unknown,
  agentPath: string | undefined,
  write: () => Promise<T>
): Promise<T> {
  if (!bracket || agentPath === undefined || !requestNamesExecutionField(body)) return write();
  let result: T | undefined;
  await bracket(agentPath, async () => {
    result = await write();
  });
  return result as T;
}
