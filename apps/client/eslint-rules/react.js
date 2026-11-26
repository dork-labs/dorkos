/**
 * React 19 hands `ref` to a function component as an ordinary prop, so a
 * component takes `ref` in its props type and never wraps itself in
 * `forwardRef` (`.claude/rules/components.md`, DOR-4939).
 *
 * Local code, not `no-restricted-imports` with `importNames: ['forwardRef']`:
 * that option also reports every `import * as React from 'react'`, because a
 * namespace COULD reach the name, and 39 files here import React that way. This
 * rule reports the name where it is used: a named import of it, or
 * `React.forwardRef` read off a default or namespace import of `react`.
 */
const MESSAGE =
  'React 19 passes `ref` as a regular prop: take `ref` in the props type instead of forwardRef.';

export default {
  rules: {
    'no-forward-ref': {
      meta: {
        type: 'problem',
        docs: { description: 'Components take `ref` as a prop, never through forwardRef.' },
        schema: [],
        messages: { forwardRef: MESSAGE },
      },
      create(context) {
        /** Local names bound to the whole `react` module (default or namespace import). */
        const reactModules = new Set();
        return {
          ImportDeclaration(node) {
            if (node.source.value !== 'react') return;
            for (const specifier of node.specifiers) {
              if (specifier.type === 'ImportSpecifier') {
                const imported = specifier.imported.name ?? specifier.imported.value;
                if (imported === 'forwardRef') {
                  context.report({ node: specifier, messageId: 'forwardRef' });
                }
              } else {
                reactModules.add(specifier.local.name);
              }
            }
          },
          MemberExpression(node) {
            if (node.object.type !== 'Identifier' || !reactModules.has(node.object.name)) return;
            const name = node.computed ? node.property.value : node.property.name;
            if (name === 'forwardRef') context.report({ node, messageId: 'forwardRef' });
          },
        };
      },
    },
  },
};
