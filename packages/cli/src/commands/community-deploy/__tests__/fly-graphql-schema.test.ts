/** @vitest-environment node */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  checkGraphqlDocument,
  FLY_SCHEMA_SNAPSHOT,
  LAUNCHER_GRAPHQL_DOCUMENTS,
  trimSchemaForDocuments,
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

  // DOR-2584 review: with a type missing from the snapshot, every field selected on it used to
  // pass unchecked (`organization { bogusField }` with Organization dropped).
  it('reports a selection that reaches a type the snapshot lacks, at any depth', async () => {
    const schema = await snapshot();
    const withoutOrganization = {
      ...schema,
      types: schema.types.filter((type) => type.name !== 'Organization'),
    };
    const problems = checkGraphqlDocument(
      LAUNCHER_GRAPHQL_DOCUMENTS.DorkosReadTigris,
      withoutOrganization
    ).join('\n');
    expect(problems).toContain('type Organization missing from snapshot');
    expect(
      checkGraphqlDocument(
        `query Q($id: ID!) { addOn(id: $id) { organization { bogusField } } }`,
        withoutOrganization
      )
    ).not.toEqual([]);
    const withoutJson = { ...schema, types: schema.types.filter((type) => type.name !== 'JSON') };
    expect(
      checkGraphqlDocument(LAUNCHER_GRAPHQL_DOCUMENTS.DorkosReadTigris, withoutJson).join('\n')
    ).toContain('type JSON missing from snapshot');
  });

  it('keeps every type a document reaches when trimming, however deep', async () => {
    const document = `query Q($appName: String!) { app(name: $appName) { addOns(type: tigris, first: 5) { nodes { organization { slug } } } } }`;
    const trimmed = trimSchemaForDocuments(await snapshot(), [document]);
    expect(checkGraphqlDocument(document, trimmed)).toEqual([]);
    expect(trimmed.types.map((type) => type.name)).toEqual(
      expect.arrayContaining(['App', 'AddOnConnection', 'AddOn', 'Organization', 'AddOnType'])
    );
  });

  it('checks enum and integer literals against the argument type', async () => {
    const schema = await snapshot();
    expect(
      checkGraphqlDocument(
        `query Q($n: String!) { app(name: $n) { addOns(type: bucket) { totalCount } } }`,
        schema
      ).join('\n')
    ).toContain('bucket is not a AddOnType');
    expect(checkGraphqlDocument(`query Q { app(name: 5) { name } }`, schema).join('\n')).toContain(
      'an integer is not a String'
    );
  });

  it('refuses GraphQL it does not understand instead of passing it', async () => {
    expect(checkGraphqlDocument(`query Q { addOn(id: "x") { id } }`, await snapshot())).not.toEqual(
      []
    );
    expect(checkGraphqlDocument(`subscription S { x }`, await snapshot())).not.toEqual([]);
  });
});
