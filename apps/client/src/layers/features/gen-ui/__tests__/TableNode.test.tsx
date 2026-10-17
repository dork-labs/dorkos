/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { WidgetNodeView } from '../ui/WidgetNodeView';

afterEach(cleanup);

describe('TableNode', () => {
  it('reads a row’s own values only, never Object.prototype members', () => {
    render(
      <WidgetNodeView
        node={{
          type: 'table',
          columns: [
            { key: 'constructor', label: 'C' },
            { key: 'toString', label: 'T' },
            { key: 'a', label: 'A' },
          ],
          rows: [{ a: 'plain' }, { constructor: 'own value', a: 'second' }],
        }}
      />
    );
    const table = screen.getByRole('table');
    expect(table).not.toHaveTextContent('function');
    expect(table).not.toHaveTextContent('native code');
    expect(table).toHaveTextContent('plain');
    // A row that really has the key still shows it.
    expect(table).toHaveTextContent('own value');
  });
});
