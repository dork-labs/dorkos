/**
 * The pinned Fly fixtures the `fly-graphql-contract*.test.ts` suites read.
 * Not a `*.test.ts`, so vitest never collects it as a suite.
 *
 * @module commands/community-deploy/__tests__/fly-graphql-contract/fly-graphql-contract.fixtures
 */
import { readFile } from 'node:fs/promises';

/** Where the pinned, sanitized Fly answers live. */
export const fixtureDirectory = new URL('../fixtures/fly/', import.meta.url);

/** The provider binding every pinned fixture describes. */
export const expectedBinding = {
  addOnId: 'addon_fixture_01',
  addOnName: 'community-fixture-bucket',
  organizationSlug: 'fixture-org',
  appId: 'app_fixture_01',
  appName: 'community-fixture-app',
};

/** Reads one pinned Fly fixture by file name. */
export async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(name, fixtureDirectory), 'utf8'));
}
