import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Resolve the installed OpenAPI dependency's public exports, without relying on
// a private pnpm store path or adding a second API-docs dependency instance.
const require = createRequire(resolve(import.meta.dirname, 'recursive-schema-ssr.test.mjs'));
const apiRequire = createRequire(require.resolve('fumadocs-openapi/ui'));
const { Schema, generateSchemaUI } = await import(
  pathToFileURL(apiRequire.resolve('@fumadocs/api-docs/components/schema')).href
);
const schemaRequire = createRequire(apiRequire.resolve('@fumadocs/api-docs/components/schema'));
const { createMagicProxy } = await import(
  pathToFileURL(schemaRequire.resolve('@scalar/json-magic/magic-proxy')).href
);
const raw = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../../../../docs/api/openapi.json'), 'utf8')
);
const original = JSON.stringify(raw);
const document = createMagicProxy(raw);
const rendering = {
  renderMarkdown: (text) => text,
  renderCodeblock: ({ code }) => code,
};

for (const endpoint of ['/api/canvas/docs/{id}/events', '/api/canvas/token/docs/{id}/events']) {
  test(`SSR preserves recursive JSON choices and clickable references: ${endpoint}`, () => {
    const body = document.paths[endpoint].post.requestBody.content['application/json'].schema;
    assert.equal(body.properties.payload.$ref, '#/components/schemas/CanvasChannelJson');
    const root = body.properties.payload;
    const generated = generateSchemaUI({ root, ...rendering });
    const choices = generated.refs[generated.$root];
    assert.equal(choices.type, 'or');
    assert.equal(choices.items.length, 6);
    assert.deepEqual(
      choices.items.map(({ $type }) => generated.refs[$type].type),
      ['primitive', 'primitive', 'primitive', 'primitive', 'array', 'object']
    );
    // The genuine generated graph retains its cycle; this fixes presentation,
    // rather than hiding a recursive variant or replacing its metadata.
    function cycle(id, ancestors = []) {
      if (ancestors.includes(id)) return true;
      const schema = generated.refs[id];
      const children =
        schema.type === 'or' || schema.type === 'and'
          ? schema.items.map((item) => item.$type)
          : schema.type === 'array'
            ? [schema.item.$type]
            : [];
      return children.some((child) => cycle(child, [...ancestors, id]));
    }
    assert.equal(cycle(generated.$root), true);
    const html = renderToStaticMarkup(
      createElement(Schema, {
        root,
        ...rendering,
        client: { name: 'payload' },
      })
    );
    assert.match(html, /array&lt;/);
    for (const type of ['string', 'number', 'boolean', 'null']) assert.ok(html.includes(type));
    // The stock popover trigger is still rendered for recursive navigation.
    assert.match(html, /<button[^>]*aria-haspopup="dialog"/);
    assert.ok(html.length < 100_000);
    assert.equal(JSON.stringify(raw), original);
  });
}

test('SSR expands shared sibling arrays independently', () => {
  const shared = { type: 'array', items: { type: 'string' } };
  const root = { anyOf: [shared, shared] };
  const html = renderToStaticMarkup(
    createElement(Schema, {
      root,
      ...rendering,
      client: { name: 'siblings' },
    })
  );
  assert.equal((html.match(/array&lt;/g) ?? []).length, 2);
  assert.equal((html.match(/>string</g) ?? []).length, 2);
  assert.doesNotMatch(html, /aria-haspopup="dialog"/);
});
