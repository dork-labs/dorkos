/**
 * RT-SES-02: a session started in a subfolder lists under the project, and a
 * lookalike sibling never does (DOR-1550).
 *
 * A person opens a project and starts an agent in `packages/api`; that session
 * is the project's session, and every runtime used to decide otherwise by
 * comparing the two directory strings for equality.
 *
 * @module test-utils/runtime-conformance-subfolder
 */
import { expect } from 'vitest';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';

/**
 * Runtimes confined to one root folder, which refuse to start a session
 * outside it: computer-local reaches only folders under its anchor. Only these
 * may refuse the sibling; any other runtime must start there and leave it out.
 */
const ROOT_CONFINED_RUNTIMES: readonly string[] = ['computer-local'];

/**
 * Run RT-SES-02 against one runtime.
 *
 * @param runtime - A fresh runtime.
 * @param projectDir - The project folder.
 * @param seed - Starts a session in a folder and returns its id.
 */
export async function assertSubfolderListing(
  runtime: AgentRuntime,
  projectDir: string,
  seed: (runtime: AgentRuntime, cwd: string) => Promise<string>
): Promise<void> {
  const subfolder = `${projectDir}/packages/api`;
  const inside = await seed(runtime, subfolder);
  // `<project>-2` shares a character prefix with the project and no path
  // SEGMENT: the trap a `startsWith` check falls into, and the control that
  // keeps the case above from passing by listing everything on the machine.
  // A root-confined runtime refuses to start there at all, which is just as good.
  const confined = ROOT_CONFINED_RUNTIMES.includes(runtime.getCapabilities().type);
  const sibling = confined
    ? await seed(runtime, `${projectDir}-2`).catch(() => undefined)
    : await seed(runtime, `${projectDir}-2`);
  // The project's own folder, so a wiring that seeds nothing listable fails here.
  const own = await seed(runtime, projectDir);

  const listed = await runtime.listSessions(projectDir);
  const ids = listed.map((s) => s.id);
  expect(ids, 'the project’s own session must list at all').toContain(own);
  expect(ids, 'a session started in a subfolder belongs to the project').toContain(inside);
  if (sibling !== undefined) {
    expect(ids, 'a sibling project’s session is not this project’s').not.toContain(sibling);
  } else {
    // With no sibling to leave out, the subfolder's own list is the control:
    // the project's session started above it, so it is not the subfolder's.
    const nested = (await runtime.listSessions(subfolder)).map((s) => s.id);
    expect(nested, 'a session in a parent folder is not the subfolder’s').not.toContain(own);
  }
  // Each row still says where it is really running: a listing that rewrote
  // `cwd` to the project would hide which folder an agent is in.
  expect(listed.find((s) => s.id === inside)?.cwd).toBe(subfolder);
}
