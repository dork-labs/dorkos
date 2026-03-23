/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { OutputRenderer } from '../OutputRenderer';

vi.mock('react-json-view-lite/dist/index.css', () => ({}));

vi.mock('react-json-view-lite', () => ({
  JsonView: ({ data }: { data: unknown }) => (
    <pre data-testid="json-view">{JSON.stringify(data)}</pre>
  ),
  darkStyles: {},
  collapseAllNested: () => false,
}));

vi.mock('ansi-to-react', () => ({
  default: ({ children }: { children: string }) => (
    <span data-testid="ansi-output">{children}</span>
  ),
}));

vi.mock('react-diff-viewer-continued', () => ({
  default: ({ oldValue, newValue }: { oldValue: string; newValue: string }) => (
    <pre data-testid="diff-view">
      {oldValue}
      {newValue}
    </pre>
  ),
}));

afterEach(() => {
  cleanup();
});

describe('OutputRenderer', () => {
  it('renders plain text for non-JSON, non-ANSI content', () => {
    render(<OutputRenderer content="hello world" toolName="Bash" />);

    expect(screen.getByText('hello world')).toBeInTheDocument();
    expect(screen.queryByTestId('json-view')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ansi-output')).not.toBeInTheDocument();
  });

  it('renders JSON tree for valid JSON content', () => {
    const json = JSON.stringify({ key: 'value', count: 42 });
    render(<OutputRenderer content={json} toolName="Bash" />);

    expect(screen.getByTestId('json-view')).toBeInTheDocument();
  });

  it('renders ANSI output for content with escape codes', () => {
    // ESC[ is a valid ANSI escape sequence prefix
    const ansiContent = '\u001b[32mGreen text\u001b[0m';
    render(<OutputRenderer content={ansiContent} toolName="Bash" />);

    expect(screen.getByTestId('ansi-output')).toBeInTheDocument();
  });

  it('renders diff view for Edit tool with valid input', async () => {
    const input = JSON.stringify({ old_string: 'old line', new_string: 'new line' });
    render(<OutputRenderer content="result output" toolName="Edit" input={input} />);

    // DiffViewer is lazy-loaded — wait for Suspense to resolve
    await waitFor(() => {
      expect(screen.getByTestId('diff-view')).toBeInTheDocument();
    });
  });

  it('falls back to plain text for Edit tool with unparseable input', () => {
    render(<OutputRenderer content="result output" toolName="Edit" input="not valid json{{{" />);

    expect(screen.queryByTestId('diff-view')).not.toBeInTheDocument();
    expect(screen.getByText('result output')).toBeInTheDocument();
  });

  it('shows "Show full output" button for content over 5KB', () => {
    const longContent = 'x'.repeat(6000);
    render(<OutputRenderer content={longContent} toolName="Bash" />);

    expect(screen.getByRole('button', { name: /show full output/i })).toBeInTheDocument();
  });

  it('expands truncated content when button is clicked', () => {
    const longContent = 'x'.repeat(6000);
    render(<OutputRenderer content={longContent} toolName="Bash" />);

    const pre = screen.getByText(/^x+$/);
    expect(pre.textContent!.length).toBe(5120);

    fireEvent.click(screen.getByRole('button', { name: /show full output/i }));

    const expandedPre = screen.getByText(/^x+$/);
    expect(expandedPre.textContent!.length).toBe(6000);
    expect(screen.queryByRole('button', { name: /show full output/i })).not.toBeInTheDocument();
  });

  it('shows "Raw" toggle button for JSON content', () => {
    const json = JSON.stringify({ key: 'value' });
    render(<OutputRenderer content={json} toolName="Bash" />);

    expect(screen.getByRole('button', { name: /raw/i })).toBeInTheDocument();
    expect(screen.getByTestId('json-view')).toBeInTheDocument();
  });

  it('switches to raw view when "Raw" is clicked', () => {
    const json = JSON.stringify({ key: 'value' });
    render(<OutputRenderer content={json} toolName="Bash" />);

    fireEvent.click(screen.getByRole('button', { name: /raw/i }));

    expect(screen.queryByTestId('json-view')).not.toBeInTheDocument();
    // Raw button label flips to "Formatted"
    expect(screen.getByRole('button', { name: /formatted/i })).toBeInTheDocument();
    // Raw content is now rendered in a pre
    expect(screen.getByText(json)).toBeInTheDocument();
  });

  it('does not show raw toggle for plain text content', () => {
    render(<OutputRenderer content="just plain text" toolName="Bash" />);

    expect(screen.queryByRole('button', { name: /raw/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /formatted/i })).not.toBeInTheDocument();
  });
});
