/**
 * The real extension API still matches the vendored seam contract, in both
 * directions (spec `flow-multiproject` §10.5). A type-level test: a drift is a
 * typecheck error in this file, and `expectTypeOf` reports it under vitest too.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expectTypeOf, it, expect } from 'vitest';
import type { ProjectRef, TrackerItemRef } from '../extension-api.js';
import type {
  DataProviderContext,
  LimitedSessionInfo,
  ProjectInfo,
  ProjectsApi,
  SessionInfo,
} from '../server-extension-api.js';
import type * as Contract from '../__fixtures__/seam-contract/seams.contract.js';

describe('extension seam contract', () => {
  it('is versioned', () => {
    const version = readFileSync(
      path.join(import.meta.dirname, '../__fixtures__/seam-contract/CONTRACT_VERSION'),
      'utf8'
    ).trim();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('matches the project and tracker-item types both ways', () => {
    expectTypeOf<ProjectRef>().toEqualTypeOf<Contract.ProjectRef>();
    expectTypeOf<TrackerItemRef>().toEqualTypeOf<Contract.TrackerItemRef>();
    expectTypeOf<ProjectInfo>().toEqualTypeOf<Contract.ProjectInfo>();
    expectTypeOf<ProjectsApi>().toEqualTypeOf<Contract.ProjectsApi>();
  });

  it('matches the context and session members it covers both ways', () => {
    expectTypeOf<
      Pick<DataProviderContext, 'projects'>
    >().toEqualTypeOf<Contract.DataProviderContextSeams>();
    expectTypeOf<
      Pick<SessionInfo, 'trackerItems' | 'trackerItem'>
    >().toEqualTypeOf<Contract.SessionInfoSeams>();
    expectTypeOf<
      Pick<LimitedSessionInfo, 'trackerItems' | 'trackerItem'>
    >().toEqualTypeOf<Contract.SessionInfoSeams>();
  });
});
