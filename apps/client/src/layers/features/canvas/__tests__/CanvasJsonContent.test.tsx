/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { CanvasJsonContent } from '../ui/CanvasJsonContent';

afterEach(cleanup);

describe('CanvasJsonContent', () => {
  it('renders string values with quotes', () => {
    render(<CanvasJsonContent content={{ type: 'json', data: { name: 'Alice' } }} />);
    expect(screen.getByText('"Alice"')).toBeInTheDocument();
  });

  it('renders number values', () => {
    render(<CanvasJsonContent content={{ type: 'json', data: { count: 42 } }} />);
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('renders boolean values', () => {
    render(<CanvasJsonContent content={{ type: 'json', data: { active: true } }} />);
    expect(screen.getByText('true')).toBeInTheDocument();
  });

  it('renders null values', () => {
    render(<CanvasJsonContent content={{ type: 'json', data: { value: null } }} />);
    expect(screen.getByText('null')).toBeInTheDocument();
  });

  it('renders nested objects with expand/collapse toggle', async () => {
    const user = userEvent.setup();
    render(<CanvasJsonContent content={{ type: 'json', data: { nested: { deep: 'value' } } }} />);

    // The root object starts expanded (depth 0); nested object at depth 1 also starts expanded
    expect(screen.getByText('"value"')).toBeInTheDocument();

    // Click the nested object toggle to collapse it
    const buttons = screen.getAllByRole('button');
    await user.click(buttons[1]); // buttons[0] is root, buttons[1] is nested
    expect(screen.queryByText('"value"')).not.toBeInTheDocument();
  });

  it('collapses deeply nested nodes by default', () => {
    const deepData = { a: { b: { c: { d: 'hidden' } } } };
    render(<CanvasJsonContent content={{ type: 'json', data: deepData }} />);
    // depth > 2 starts collapsed, so 'd' key value should not be visible initially
    expect(screen.queryByText('"hidden"')).not.toBeInTheDocument();
  });

  it('renders arrays with numeric indices', () => {
    render(<CanvasJsonContent content={{ type: 'json', data: ['alpha', 'beta'] }} />);
    expect(screen.getByText('"alpha"')).toBeInTheDocument();
    expect(screen.getByText('"beta"')).toBeInTheDocument();
  });
});
