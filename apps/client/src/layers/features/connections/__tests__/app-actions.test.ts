import { describe, expect, it } from 'vitest';
import type { ConnectorAppAction } from '@dorkos/shared/connector-resource-schemas';
import type { ConnectorOperationClassification } from '@dorkos/shared/connector-schemas';
import {
  actionBuckets,
  actionKind,
  actionsFromCandidates,
  examplePhrase,
  offersReadWrite,
  plainActionName,
} from '../lib/app-actions';
import { revisionIdsForAccessLevel } from '../lib/reconciliation-selection';

function action(
  operationSlug: string,
  capabilityClassification: ConnectorOperationClassification,
  extra: Partial<ConnectorAppAction> = {}
): ConnectorAppAction {
  return { operationSlug, capabilityClassification, important: false, ...extra };
}

const GMAIL = [
  action('GMAIL_LIST_LABELS', 'read'),
  action('GMAIL_FETCH_EMAILS', 'read', { important: true }),
  action('GMAIL_ADD_LABEL', 'write'),
  action('GMAIL_SEND_EMAIL', 'destructive', { important: true }),
  action('GMAIL_MOVE_TO_TRASH', 'destructive'),
];

describe('actionKind', () => {
  it('counts only read as Look; every other classification is Change', () => {
    expect(actionKind('read')).toBe('look');
    expect(actionKind('write')).toBe('change');
    expect(actionKind('destructive')).toBe('change');
  });
});

describe('plainActionName', () => {
  it('puts the service’s own name in sentence case, keeping acronyms and brands', () => {
    expect(plainActionName(action('X', 'read', { displayName: 'Send Email' }), 'gmail')).toBe(
      'Send email'
    );
    expect(
      plainActionName(action('X', 'read', { displayName: 'List GitHub PR Reviews' }), 'github')
    ).toBe('List GitHub PR reviews');
  });

  it('reads the name from the action id when the service gives none', () => {
    expect(plainActionName(action('GMAIL_SEND_EMAIL', 'destructive'), 'gmail')).toBe('Send email');
  });
});

describe('actionBuckets', () => {
  it('shows only Look on "Read", and names what each other level would add', () => {
    const buckets = actionBuckets(GMAIL, 'read');
    expect(buckets.look.map((a) => a.operationSlug)).toEqual([
      'GMAIL_FETCH_EMAILS',
      'GMAIL_LIST_LABELS',
    ]);
    expect(buckets.change).toEqual([]);
    expect(buckets.addedByReadWrite.map((a) => a.operationSlug)).toEqual(['GMAIL_ADD_LABEL']);
    expect(buckets.outsideLevels.map((a) => a.operationSlug)).toEqual([
      'GMAIL_SEND_EMAIL',
      'GMAIL_MOVE_TO_TRASH',
    ]);
  });

  it('adds write actions to Change on "Read and write", never delete-class ones', () => {
    const buckets = actionBuckets(GMAIL, 'read-write');
    expect(buckets.change.map((a) => a.operationSlug)).toEqual(['GMAIL_ADD_LABEL']);
    expect(buckets.addedByReadWrite).toEqual([]);
    expect(buckets.outsideLevels).toHaveLength(2);
  });

  it('describes the app itself with no level: every change in Change, main ones first', () => {
    const buckets = actionBuckets(GMAIL, null);
    expect(buckets.change.map((a) => a.operationSlug)).toEqual([
      'GMAIL_SEND_EMAIL',
      'GMAIL_ADD_LABEL',
      'GMAIL_MOVE_TO_TRASH',
    ]);
    expect(buckets.outsideLevels).toEqual([]);
  });

  it('promises exactly what each level grants, by the same rule the presets use', () => {
    const candidates = GMAIL.map((a) => ({
      operationRevisionId: a.operationSlug,
      toolkit: 'gmail',
      operationSlug: a.operationSlug,
      toolkitVersion: '1',
      capabilityClassification: a.capabilityClassification,
      retryPolicy: 'never' as const,
      inputSchema: {},
      supported: true,
    }));
    for (const level of ['read', 'read-write'] as const) {
      const buckets = actionBuckets(GMAIL, level);
      const shown = [...buckets.look, ...buckets.change].map((a) => a.operationSlug).sort();
      expect(shown).toEqual(revisionIdsForAccessLevel(candidates, level));
    }
  });
});

describe('offersReadWrite', () => {
  it('is true only when some action is in "Read and write" but not "Read"', () => {
    expect(offersReadWrite(GMAIL)).toBe(true);
    expect(offersReadWrite(GMAIL.filter((a) => a.capabilityClassification !== 'write'))).toBe(
      false
    );
  });
});

describe('examplePhrase', () => {
  it('names two and counts the rest', () => {
    expect(examplePhrase([action('GMAIL_SEND_EMAIL', 'destructive')], 'gmail')).toBe('send email');
    expect(examplePhrase(GMAIL.slice(2), 'gmail')).toBe('add label, send email and 1 more');
  });
});

describe('actionsFromCandidates', () => {
  function candidate(
    operationSlug: string,
    capabilityClassification: ConnectorOperationClassification,
    toolkitVersion = '2',
    supported = true
  ) {
    return {
      operationRevisionId: `${operationSlug}-${toolkitVersion}`,
      toolkit: 'gmail',
      operationSlug,
      toolkitVersion,
      capabilityClassification,
      retryPolicy: 'never' as const,
      inputSchema: {},
      supported,
    };
  }

  it('keeps the candidate’s classification and borrows only names and order from the list', () => {
    const actions = actionsFromCandidates(
      [
        candidate('GMAIL_OLD_ONLY', 'read', '1'),
        candidate('GMAIL_SEND_EMAIL', 'write'),
        candidate('GMAIL_SEND_EMAIL', 'write', '1'),
        candidate('GMAIL_GONE', 'read', '1', false),
      ],
      [action('GMAIL_SEND_EMAIL', 'destructive', { displayName: 'Send Email', important: true })]
    );
    expect(actions).toEqual([
      {
        operationSlug: 'GMAIL_SEND_EMAIL',
        displayName: 'Send Email',
        capabilityClassification: 'write',
        important: true,
      },
      { operationSlug: 'GMAIL_OLD_ONLY', capabilityClassification: 'read', important: false },
    ]);
  });

  it('keeps one row per action and classification, so a reclassified action shows both ways', () => {
    const actions = actionsFromCandidates(
      [candidate('GMAIL_TRASH', 'read', '1'), candidate('GMAIL_TRASH', 'destructive', '2')],
      undefined
    );
    expect(actions.map((a) => [a.operationSlug, a.capabilityClassification])).toEqual([
      ['GMAIL_TRASH', 'read'],
      ['GMAIL_TRASH', 'destructive'],
    ]);
    expect(actionBuckets(actions, 'read').look).toHaveLength(1);
    expect(actionBuckets(actions, 'read').outsideLevels).toHaveLength(1);
  });
});
