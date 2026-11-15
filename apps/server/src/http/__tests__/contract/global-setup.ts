/**
 * Vitest global setup for the server project: a fresh folder, for this run
 * only, where the contract harness builds the composed server the first time
 * a contract file boots one (`server-build.ts`). Nothing is built here, so a
 * run with no contract file in it pays nothing; the folder goes when the run
 * ends, so no run ever boots another run's build.
 *
 * @module http/__tests__/contract/global-setup
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Where this run's contract server build goes. */
    contractServerBuildDir: string;
  }
}

/** Make the folder and hand it to the test workers. */
export default function setup(project: TestProject): () => void {
  const dir = mkdtempSync(path.join(tmpdir(), 'dorkos-contract-build-'));
  project.provide('contractServerBuildDir', dir);
  return () => rmSync(dir, { recursive: true, force: true });
}
