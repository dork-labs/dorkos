import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import {
  generateServerTemplate,
  generateTemplate,
  type ExtensionTemplate,
} from '../extension-templates.js';

const TEMPLATES: ExtensionTemplate[] = [
  'dashboard-card',
  'right-panel-tab',
  'command',
  'settings-panel',
  'data-provider',
];

/** Every call to `injected()` the generated source would actually make. */
function injectedCalls(source: string): number {
  const file = ts.createSourceFile(
    'index.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  let calls = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'injected') calls += 1;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return calls;
}

/**
 * Direct coverage for the extension starter templates. These generators are
 * otherwise exercised only indirectly through the scaffolder, so the assertions
 * below pin the generated source that authors actually receive.
 */
describe('extension-templates', () => {
  describe('generateTemplate (right-panel-tab)', () => {
    const source = generateTemplate('my-panel', 'A panel', 'right-panel-tab');

    it('registers a component in the right-panel slot with a namespaced id', () => {
      expect(source).toContain("api.registerComponent('right-panel', 'my-panel-panel'");
    });

    it('passes no icon component, which cannot cross the sandboxed frame', () => {
      expect(source).not.toContain('icon:');
      expect(source).not.toContain('<svg');
    });
  });

  describe('a description is only ever text (DOR-3068)', () => {
    const descriptions = [
      'x\ninjected();\n//',
      'x\r\ninjected();',
      'x\u2028injected();',
      'x\u2029injected();',
      '</p>{injected()}<p>',
    ];

    it.each(TEMPLATES)('never turns a description into code in the %s template', (template) => {
      for (const description of descriptions) {
        expect(injectedCalls(generateTemplate('my-app', description, template))).toBe(0);
      }
    });

    it('never turns a description into code in the server template', () => {
      for (const description of descriptions) {
        expect(injectedCalls(generateServerTemplate('my-app', description))).toBe(0);
      }
    });
  });
});
