/** Security's deep-read invariants for Composio access levels (DOR-4194). */
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { accessLevelRevisionIds } from '../../connector-schemas.js';
import * as policy from '../action-classes.js';

describe('Composio access-level security policy', () => {
  it.each(
    [
      [],
      ['futureEffectHint'],
      ['createHint', 'futureEffectHint'],
      ['readOnlyHint', 'futureEffectHint'],
    ].map((tags) => ({ tags }))
  )('keeps an unknown safety verdict out of both access levels ($tags)', ({ tags }) => {
    // Synthetic future action: a name alone never supplies a missing verdict.
    const uncertain = {
      operationRevisionId: 'revision-unknown',
      operationSlug: 'FUTUREAPP_CREATE_ITEM',
      toolkit: 'futureapp',
      supported: true,
      capabilityClassification: policy.classifyComposioAction('FUTUREAPP_CREATE_ITEM', tags),
    };
    const read = {
      ...uncertain,
      operationRevisionId: 'revision-read',
      operationSlug: 'FUTUREAPP_READ_ITEM',
      capabilityClassification: policy.classifyComposioAction('FUTUREAPP_READ_ITEM', [
        'readOnlyHint',
      ]),
    };
    expect(uncertain.capabilityClassification).toBe('destructive');
    for (const level of ['read', 'read-write'] as const) {
      expect(accessLevelRevisionIds([uncertain, read], level)).toEqual(['revision-read']);
    }
  });

  it.each([
    // Made-up Linear actions: a later catalog entry on a pinned app.
    ['LINEAR_CREATE_WEBHOOK_SUBSCRIPTION', 'reach'],
    ['LINEAR_INVITE_WORKSPACE_MEMBER', 'reach'],
    ['LINEAR_CREATE_API_TOKEN', 'reach'],
    ['LINEAR_PURCHASE_SEATS', 'money'],
    ['LINEAR_PURGE_ARCHIVED_ISSUES', 'irreversible'],
    ['LINEAR_DELETE_CYCLE', 'delete'],
  ])('keeps a new Linear action named for %s (%s) out of Read and write', (slug) => {
    expect(policy.classifyComposioAction(slug, ['openWorldHint', 'createHint'])).toBe(
      'destructive'
    );
  });

  it('gives a new, plainly named create action on a pinned app write, by design', () => {
    expect(policy.classifyComposioAction('LINEAR_CREATE_ISSUE_TEMPLATE', ['createHint'])).toBe(
      'write'
    );
    expect(policy.classifyComposioAction('LINEAR_CREATE_ISSUE_TEMPLATE', [])).toBe('destructive');
  });

  it('keeps WRITE_INCLUDES_DELETES a source constant with no runtime setter', () => {
    const source = ts.createSourceFile(
      'action-classes.ts',
      readFileSync(new URL('../action-classes.ts', import.meta.url), 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    const statement = source.statements.find(
      (node) =>
        ts.isVariableStatement(node) &&
        node.declarationList.declarations.some(
          (declaration) =>
            ts.isIdentifier(declaration.name) && declaration.name.text === 'WRITE_INCLUDES_DELETES'
        )
    );
    expect(statement).toBeDefined();
    if (!statement || !ts.isVariableStatement(statement))
      throw new Error('Delete constant missing');
    expect(statement.declarationList.flags & ts.NodeFlags.Const).toBe(ts.NodeFlags.Const);
    const declaration = statement.declarationList.declarations.find(
      (node) => ts.isIdentifier(node.name) && node.name.text === 'WRITE_INCLUDES_DELETES'
    )!;
    expect(declaration.initializer?.kind).toBe(ts.SyntaxKind.FalseKeyword);
    // Enumerate every actual export, so adding a setter requires explicit review.
    expect(Object.keys(policy).sort()).toEqual([
      'WRITE_INCLUDES_DELETES',
      'classifyComposioAction',
      'isAccountReachAction',
    ]);
    expect(policy.WRITE_INCLUDES_DELETES).toBe(false);
    expect(
      policy.classifyComposioAction('GMAIL_MOVE_TO_TRASH', ['updateHint'], {
        writeIncludesDeletes: true,
      })
    ).toBe('write');
    expect(policy.classifyComposioAction('GMAIL_MOVE_TO_TRASH', ['updateHint'])).toBe(
      'destructive'
    );
    expect(policy.WRITE_INCLUDES_DELETES).toBe(false);
  });
});
