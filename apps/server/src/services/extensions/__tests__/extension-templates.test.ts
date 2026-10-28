import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import {
  generateManifest,
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
  describe('generateManifest', () => {
    it('declares the right-panel slot for the right-panel-tab template', () => {
      const manifest = generateManifest('my-panel', 'A panel', 'right-panel-tab') as {
        id: string;
        name: string;
        contributions: Record<string, boolean>;
      };

      expect(manifest.id).toBe('my-panel');
      expect(manifest.name).toBe('My Panel');
      expect(manifest.contributions['right-panel']).toBe(true);
      // It must not leak an unrelated slot.
      expect(manifest.contributions['dashboard.sections']).toBeUndefined();
    });

    it('declares the dashboard slot for the dashboard-card template', () => {
      const manifest = generateManifest('cards', undefined, 'dashboard-card') as {
        contributions: Record<string, boolean>;
      };

      expect(manifest.contributions['dashboard.sections']).toBe(true);
    });
  });

  describe('generateTemplate (right-panel-tab)', () => {
    const source = generateTemplate('my-panel', 'A panel', 'right-panel-tab');

    it('registers a component in the right-panel slot with a namespaced id', () => {
      expect(source).toContain("api.registerComponent('right-panel', 'my-panel-panel'");
    });

    it('passes a label, an icon, and a priority', () => {
      expect(source).toContain("label: 'My Panel'");
      expect(source).toContain('icon: MyPanelTabIcon');
      expect(source).toContain('priority: 50');
    });

    it('ships an inline-SVG icon component that takes a className', () => {
      expect(source).toContain('function MyPanelTabIcon({ className }: { className?: string })');
      expect(source).toContain('<svg');
      expect(source).toContain('stroke="currentColor"');
    });

    it('renders a panel body component', () => {
      expect(source).toContain('function MyPanelPanel()');
    });

    it('imports the API as a type only and never imports React', () => {
      expect(source).toContain("import type { ExtensionAPI } from '@dorkos/extension-api'");
      expect(source).not.toContain('import React');
    });
  });

  describe('generateTemplate (all kinds)', () => {
    it('produces a non-empty activate() entry point for every template', () => {
      const kinds = [
        'dashboard-card',
        'right-panel-tab',
        'command',
        'settings-panel',
        'data-provider',
      ] as const;
      for (const kind of kinds) {
        const source = generateTemplate('sample', 'desc', kind);
        expect(source).toContain('export function activate(api: ExtensionAPI)');
      }
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

    it('still shows the description on the page', () => {
      const source = generateTemplate('my-app', 'Shows open pull requests', 'dashboard-card');
      expect(source).toContain('{"Shows open pull requests"}');
    });
  });
});
