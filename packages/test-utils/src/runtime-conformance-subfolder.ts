/**
 * RT-SES-02: a session started in a subfolder lists under the project, and a
 * lookalike sibling never does (DOR-1550).
 *
 * A person opens a project and starts an agent in `packages/api`; that session
 * is the project's session, and every runtime used to decide otherwise by
 * comparing the two directory strings for equality.
 *
 * One runtime may not run in a subfolder at all yet: computer-local maps exactly
 * one host folder into its guest (DOR-5251). It alone may claim
 * `singleFolderRuntimeReason`, which must name its follow-up ticket. The own
 * folder and sibling checks still run for it.
 *
 * @module test-utils/runtime-conformance-subfolder
 */
import { expect } from 'vitest';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';

/** The runtimes allowed to claim a single-folder reason. Remove one when it maps subfolders. */
const SINGLE_FOLDER_RUNTIMES: readonly string[] = ['computer-local'];

/**
 * Run RT-SES-02 against one runtime.
 *
 * @param runtime - A fresh runtime.
 * @param projectDir - The project folder.
 * @param seed - Starts a session in a folder and returns its id.
 * @param singleFolderReason - Why the runtime can't run in a subfolder yet, naming its ticket.
 */
export async function assertSubfolderListing(
  runtime: AgentRuntime,
  projectDir: string,
  seed: (runtime: AgentRuntime, cwd: string) => Promise<string>,
  singleFolderReason?: string
): Promise<void> {
  if (singleFolderReason !== undefined) {
    expect(
      SINGLE_FOLDER_RUNTIMES,
      'only a runtime that maps exactly one folder may skip the subfolder half'
    ).toContain(runtime.getCapabilities().type);
    expect(singleFolderReason, 'the reason must name its follow-up ticket').toMatch(/DOR-\d+/);
  }
  const subfolder = `${projectDir}/packages/api`;
  const inside = singleFolderReason === undefined ? await seed(runtime, subfolder) : undefined;
  // `<project>-2` shares a character prefix with the project and no path
  // SEGMENT: the trap a `startsWith` check falls into, and the control that
  // keeps the case above from passing by listing everything on the machine.
  // A single-folder runtime refuses the sibling outright, which is just as good.
  const sibling =
    singleFolderReason === undefined
      ? await seed(runtime, `${projectDir}-2`)
      : await seed(runtime, `${projectDir}-2`).catch(() => undefined);
  // The project's own folder, so a wiring that seeds nothing listable fails here.
  const own = await seed(runtime, projectDir);

  const listed = await runtime.listSessions(projectDir);
  const ids = listed.map((s) => s.id);
  expect(ids, 'the project’s own session must list at all').toContain(own);
  if (sibling !== undefined) {
    expect(ids, 'a sibling project’s session is not this project’s').not.toContain(sibling);
  }
  if (inside === undefined) return;
  expect(ids, 'a session started in a subfolder belongs to the project').toContain(inside);
  // Each row still says where it is really running: a listing that rewrote
  // `cwd` to the project would hide which folder an agent is in.
  expect(listed.find((s) => s.id === inside)?.cwd).toBe(subfolder);
}
