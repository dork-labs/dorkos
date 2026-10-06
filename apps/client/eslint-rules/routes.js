/** Enforce route factories at navigation boundaries without banning API or external URLs. */
// Lint runs before package builds. Node's supported TS loader reads this data-only
// source directly, preserving the same constants without requiring shared/dist.
import { APP_ROUTE_PATHS } from '../../../packages/shared/src/app-route-paths.ts';

const CORE_PATHS = new Set(APP_ROUTE_PATHS);

/** Whether a static destination is a core app link. */
function isCoreLink(value) {
  if (typeof value !== 'string') return false;
  const path = value.split(/[?#]/, 1)[0];
  return CORE_PATHS.has(path) || /^\/x(?:\/|$)/.test(path);
}

export default {
  rules: {
    'no-hardcoded-route': {
      meta: {
        type: 'problem',
        docs: { description: 'Build internal navigation through the shared route factories.' },
        schema: [],
        messages: {
          factory:
            'Build this destination with appRoutes, toSession, sessionHref, or extensionPageHref.',
        },
      },
      create(context) {
        function isHardcoded(node, seen = new Set()) {
          if (!node || seen.has(node)) return false;
          seen.add(node);
          if (node.type === 'Literal') return isCoreLink(node.value);
          if (node.type === 'TemplateLiteral') return isCoreLink(node.quasis[0].value.cooked);
          if (node.type === 'BinaryExpression' && node.operator === '+')
            return isHardcoded(node.left, seen);
          if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression')
            return isHardcoded(node.expression, seen);
          if (node.type !== 'Identifier') return false;
          let scope = context.sourceCode.getScope(node);
          while (scope) {
            const variable = scope.set.get(node.name);
            if (variable) {
              return variable.defs.some(
                (definition) =>
                  definition.type === 'Variable' &&
                  definition.parent.kind === 'const' &&
                  isHardcoded(definition.node.init, seen)
              );
            }
            scope = scope.upper;
          }
          return false;
        }
        function check(node) {
          if (isHardcoded(node)) context.report({ node, messageId: 'factory' });
        }
        return {
          Property(node) {
            const key = node.key.name ?? node.key.value;
            if (key === 'to' || key === 'href' || key === 'path') check(node.value);
          },
          JSXAttribute(node) {
            if (node.name.name !== 'to' && node.name.name !== 'href') return;
            check(
              node.value?.type === 'JSXExpressionContainer' ? node.value.expression : node.value
            );
          },
        };
      },
    },
  },
};
