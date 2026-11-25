/**
 * Every failure the app's API answers is a problem document (ADR 261123-170831): sent
 * through `problem()` from `@dorkos/http-kit`, never a hand-built `{ error }` body. This
 * rule refuses a `.json(...)` call whose first argument is an object literal with an
 * `error` member, the shape the old bodies had (`c.json({ error, code }, 4xx)`,
 * `res.status(4xx).json({ error })`).
 *
 * The few bodies that keep another shape on purpose (MCP JSON-RPC and OAuth answers,
 * the login gate's `AUTH_REQUIRED`) carry a scoped `eslint-disable-next-line` with
 * their reason, or live outside the folders this rule is wired to.
 */
export default {
  rules: {
    'no-error-body': {
      meta: {
        type: 'problem',
        docs: { description: 'An error answer is a problem document, never `{ error }`.' },
        schema: [],
        messages: {
          errorBody:
            'Answer a failure with problem() from @dorkos/http-kit (a code from @dorkos/shared/problem, a `detail` sentence), not a `{ error }` body.',
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            const callee = node.callee;
            if (callee.type !== 'MemberExpression' || callee.computed) return;
            if (callee.property.type !== 'Identifier' || callee.property.name !== 'json') return;
            const [body] = node.arguments;
            if (body?.type !== 'ObjectExpression') return;
            const named = body.properties.some(
              (p) =>
                p.type === 'Property' &&
                !p.computed &&
                ((p.key.type === 'Identifier' && p.key.name === 'error') ||
                  (p.key.type === 'Literal' && p.key.value === 'error'))
            );
            if (named) context.report({ node: body, messageId: 'errorBody' });
          },
        };
      },
    },
  },
};
