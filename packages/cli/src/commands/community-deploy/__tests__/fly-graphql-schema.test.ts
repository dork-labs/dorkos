/** @vitest-environment node */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  checkGraphqlDocument,
  FLY_SCHEMA_SNAPSHOT,
  LAUNCHER_GRAPHQL_DOCUMENTS,
  type IntrospectedSchema,
} from '../../../../scripts/community-deploy-contract-graphql.js';

// The snapshot is trimmed from Fly's live introspection by
// `pnpm --filter dorkos replay:community-contract --write-schema`; never edit it by hand.
async function snapshot(): Promise<IntrospectedSchema> {
  return JSON.parse(await readFile(FLY_SCHEMA_SNAPSHOT, 'utf8')) as IntrospectedSchema;
}

describe('launcher GraphQL documents against Fly’s live schema snapshot', () => {
  it.each(Object.entries(LAUNCHER_GRAPHQL_DOCUMENTS))(
    '%s names only fields, arguments and types Fly serves',
    async (_name, document) => {
      expect(checkGraphqlDocument(document, await snapshot())).toEqual([]);
    }
  );

  // DOR-2584: the launcher asked for `node(id:)`, which Fly's API does not have, and a paid live
  // run stopped on "Field 'node' doesn't exist on type 'Queries'". Fixtures could not catch it.
  it('rejects the root field the live API refused', async () => {
    const problems = checkGraphqlDocument(
      `query DorkosReadTigris($id: ID!) { node(id: $id) { ... on AddOn { id } } }`,
      await snapshot()
    );
    expect(problems.join('\n')).toContain('query.node: no such field on Queries');
  });

  it.each([
    [
      'a field the type lacks',
      `query Q($id: ID!) { addOn(id: $id) { id bucketName } }`,
      'bucketName: no such field on AddOn',
    ],
    [
      'an argument the field lacks',
      `query Q($id: ID!) { addOn(addOnId: $id) { id } }`,
      '(addOnId): no such argument',
    ],
    [
      'an input field the input lacks',
      `mutation M($name: String!) { deleteAddOn(input: { bucket: $name }) { deletedAddOnName } }`,
      '.bucket: no such input field',
    ],
    [
      'a fragment the type cannot be',
      `query Q { viewer { ... on App { name } } }`,
      'App is not a Principal',
    ],
    [
      'a variable of an unknown type',
      `query Q($id: AddOnId!) { addOn(id: $id) { id } }`,
      'variable type AddOnId does not exist',
    ],
    [
      'an object without a selection',
      `query Q($id: ID!) { addOn(id: $id) { app } }`,
      'App needs a selection',
    ],
    [
      'a selection on a scalar',
      `query Q($id: ID!) { addOn(id: $id) { id { x } } }`,
      'ID has no fields to select',
    ],
  ])('reports %s', async (_label, document, expected) => {
    expect(checkGraphqlDocument(document, await snapshot()).join('\n')).toContain(expected);
  });

  it('refuses GraphQL it does not understand instead of passing it', async () => {
    expect(checkGraphqlDocument(`query Q { addOn(id: "x") { id } }`, await snapshot())).not.toEqual(
      []
    );
    expect(checkGraphqlDocument(`subscription S { x }`, await snapshot())).not.toEqual([]);
  });
});
