/**
 * The real extension API still matches the vendored seam contract, in both
 * directions (spec `flow-multiproject` §10.5). A type-level test: a drift is a
 * typecheck error in this file, and `expectTypeOf` reports it under vitest too.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expectTypeOf, it, expect } from 'vitest';
import type {
  DecisionActions,
  DecisionAnswer,
  DecisionAnswerResult,
  ExtensionAPI,
  ExtensionDecisionView,
  ExtensionPageOptions,
  ExtensionPageProps,
  ExtensionPointId,
  ExtensionReadableState,
  ProjectRef,
  StatusBarItemOptions,
  StatusBarSlotContext,
  TrackerItemRef,
} from '../extension-api.js';
import type { StartWorkError, StartWorkInput } from '../start-work.js';
import type {
  DataProviderContext,
  LimitedSessionInfo,
  DecisionActionEvent,
  DecisionActionResult,
  DecisionActor,
  DecisionInput,
  DecisionOffer,
  DecisionOutcome,
  DecisionWatch,
  InboxApi,
  ProjectInfo,
  ProjectSettingsReader,
  ProjectsApi,
  RaisedDecision,
  RecordedDecisionInput,
  SessionInfo,
  SessionsApi,
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
      Pick<
        DataProviderContext,
        'projects' | 'inbox' | 'requirePerson' | 'projectSettings' | 'sessions'
      >
    >().toEqualTypeOf<Contract.DataProviderContextSeams>();
    expectTypeOf<
      Pick<SessionInfo, 'trackerItems' | 'trackerItem'>
    >().toEqualTypeOf<Contract.SessionInfoSeams>();
    expectTypeOf<
      Pick<LimitedSessionInfo, 'trackerItems' | 'trackerItem'>
    >().toEqualTypeOf<Contract.SessionInfoSeams>();
  });

  it('matches the inbox and project-settings types both ways', () => {
    expectTypeOf<DecisionActions>().toEqualTypeOf<Contract.DecisionActions>();
    expectTypeOf<DecisionAnswer>().toEqualTypeOf<Contract.DecisionAnswer>();
    expectTypeOf<DecisionAnswerResult>().toEqualTypeOf<Contract.DecisionAnswerResult>();
    expectTypeOf<ExtensionDecisionView>().toEqualTypeOf<Contract.ExtensionDecisionView>();
    expectTypeOf<DecisionInput>().toEqualTypeOf<Contract.DecisionInput>();
    expectTypeOf<RaisedDecision>().toEqualTypeOf<Contract.RaisedDecision>();
    expectTypeOf<DecisionOutcome>().toEqualTypeOf<Contract.DecisionOutcome>();
    expectTypeOf<DecisionActor>().toEqualTypeOf<Contract.DecisionActor>();
    expectTypeOf<DecisionActionEvent>().toEqualTypeOf<Contract.DecisionActionEvent>();
    expectTypeOf<DecisionWatch>().toEqualTypeOf<Contract.DecisionWatch>();
    expectTypeOf<DecisionActionResult>().toEqualTypeOf<Contract.DecisionActionResult>();
    expectTypeOf<DecisionOffer>().toEqualTypeOf<Contract.DecisionOffer>();
    expectTypeOf<RecordedDecisionInput>().toEqualTypeOf<Contract.RecordedDecisionInput>();
    expectTypeOf<InboxApi>().toEqualTypeOf<Contract.InboxApi>();
    expectTypeOf<ProjectSettingsReader>().toEqualTypeOf<Contract.ProjectSettingsReader>();
  });

  it('matches starting work in a new chat both ways (§7.7)', () => {
    expectTypeOf<StartWorkInput>().toEqualTypeOf<Contract.StartWorkInput>();
    expectTypeOf<StartWorkError>().toEqualTypeOf<Contract.StartWorkError>();
    expectTypeOf<StartWorkError['code']>().toEqualTypeOf<
      'not_a_project' | 'account_not_allowed_here' | 'start_limit'
    >();
    expectTypeOf<SessionsApi>().toEqualTypeOf<Contract.SessionsApi>();
  });

  it('gives the server half no way to write per-project settings (§7.10)', () => {
    expectTypeOf<ProjectSettingsReader>().not.toHaveProperty('set');
    expectTypeOf<DataProviderContext['projectSettings']>().not.toHaveProperty('set');
  });

  it('matches the client seams (pages, status bar, tab marker, navigate) both ways', () => {
    expectTypeOf<ExtensionPointId>().toEqualTypeOf<Contract.ExtensionPointId>();
    expectTypeOf<ExtensionPageProps>().toEqualTypeOf<Contract.ExtensionPageProps>();
    expectTypeOf<ExtensionPageOptions>().toEqualTypeOf<Contract.ExtensionPageOptions>();
    expectTypeOf<StatusBarSlotContext>().toEqualTypeOf<Contract.StatusBarSlotContext>();
    expectTypeOf<StatusBarItemOptions>().toEqualTypeOf<Contract.StatusBarItemOptions>();
    expectTypeOf<
      Pick<ExtensionReadableState, 'currentProject' | 'requireLogin'>
    >().toEqualTypeOf<Contract.ExtensionReadableStateSeams>();
    expectTypeOf<
      Pick<
        ExtensionAPI,
        | 'registerPage'
        | 'registerStatusBarItem'
        | 'setTabMarker'
        | 'navigate'
        | 'isSlotAvailable'
        | 'answerDecision'
        | 'listDecisions'
        | 'projectSettings'
        | 'startWork'
      >
    >().toEqualTypeOf<Contract.ExtensionAPISeams>();
  });
});
