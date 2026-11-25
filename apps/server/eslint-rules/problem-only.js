/**
 * Every failure the app's API answers is a problem document (ADR 261123-170831): sent
 * through `problem()` from `@dorkos/http-kit`, never a hand-built `{ error }` body. This
 * rule refuses a `.json(...)` call whose first argument has an `error` member, the shape
 * the old bodies had (`c.json({ error, code }, 4xx)`, `res.status(4xx).json({ error })`):
 * an object literal, or an identifier naming a module-level `const` that holds one
 * (`c.json(SPACES_DISABLED_BODY, 404)`).
 *
 * Blind spots, reviewed by hand instead: a conditional argument
 * (`c.json(ok ? a : { error })`), a body built in another module and imported, a local
 * variable, `c.body(JSON.stringify(...))` and `new Response(...)`.
 *
 * The few bodies that keep another shape on purpose (MCP JSON-RPC and OAuth answers,
 * the login gate's `AUTH_REQUIRED`) carry a scoped `eslint-disable-next-line` with
 * their reason, or live outside the folders this rule is wired to.
 */

/** Whether an object literal (through `as const` or `satisfies`) names an `error` member. */
function hasErrorMember(node) {
  let body = node;
  while (body && (body.type === 'TSAsExpression' || body.type === 'TSSatisfiesExpression')) {
    body = body.expression;
  }
  if (body?.type !== 'ObjectExpression') return false;
  return body.properties.some(
    (p) =>
      p.type === 'Property' &&
      !p.computed &&
      ((p.key.type === 'Identifier' && p.key.name === 'error') ||
        (p.key.type === 'Literal' && p.key.value === 'error'))
  );
}

/** The first argument of a `.json(...)` call, or `undefined` for any other call. */
function jsonBodyOf(node) {
  const callee = node.callee;
  if (callee.type !== 'MemberExpression' || callee.computed) return undefined;
  if (callee.property.type !== 'Identifier' || callee.property.name !== 'json') return undefined;
  return node.arguments[0];
}

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
        /** Module-level `const` declarators whose value has an `error` member. */
        const errorConsts = new Set();
        /** Identifiers passed to `.json(...)`, checked once the whole module is read. */
        const named = [];
        const noteConst = (node) => {
          if (node.id.type === 'Identifier' && hasErrorMember(node.init)) errorConsts.add(node);
        };
        return {
          'Program > VariableDeclaration[kind="const"] > VariableDeclarator': noteConst,
          'Program > ExportNamedDeclaration > VariableDeclaration[kind="const"] > VariableDeclarator':
            noteConst,
          CallExpression(node) {
            const body = jsonBodyOf(node);
            if (!body) return;
            if (hasErrorMember(body)) context.report({ node: body, messageId: 'errorBody' });
            else if (body.type === 'Identifier') named.push(body);
          },
          'Program:exit'() {
            for (const identifier of named) {
              // Resolve the name, so a local of the same name is never mistaken for the const.
              let scope = context.sourceCode.getScope(identifier);
              let variable;
              while (scope && !variable) {
                variable = scope.set.get(identifier.name);
                scope = scope.upper;
              }
              const declared = variable?.defs[0]?.node;
              if (declared && errorConsts.has(declared)) {
                context.report({ node: identifier, messageId: 'errorBody' });
              }
            }
          },
        };
      },
    },
  },
};
