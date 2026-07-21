// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SidebarProvider } from '@/layers/shared/ui';
import { RevealRow } from '../ui/RevealRow';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => cleanup());

function renderRow(path: string, keyPrefix: string) {
  return <li key={`${keyPrefix}-${path}`}>{path}</li>;
}

function renderWithProvider(ui: React.ReactElement) {
  return render(<SidebarProvider>{ui}</SidebarProvider>);
}

describe('RevealRow', () => {
  it('renders nothing when there are no hidden agents', () => {
    const { container } = renderWithProvider(
      <RevealRow kind="hidden" agents={[]} renderRow={renderRow} keyPrefix="g1" />
    );
    expect(container.querySelector('[data-slot="sidebar-wrapper"]')).toBeEmptyDOMElement();
  });

  it('shows the "N hidden" label for kind=hidden', () => {
    renderWithProvider(
      <RevealRow kind="hidden" agents={['/a', '/b', '/c']} renderRow={renderRow} keyPrefix="g1" />
    );
    expect(screen.getByText('3 hidden')).toBeInTheDocument();
  });

  it('shows the pluralized "N inactive agents" label for kind=inactive', () => {
    renderWithProvider(
      <RevealRow kind="inactive" agents={['/a', '/b']} renderRow={renderRow} keyPrefix="g1" />
    );
    expect(screen.getByText('2 inactive agents')).toBeInTheDocument();
  });

  it('singularizes "1 inactive agent"', () => {
    renderWithProvider(
      <RevealRow kind="inactive" agents={['/a']} renderRow={renderRow} keyPrefix="g1" />
    );
    expect(screen.getByText('1 inactive agent')).toBeInTheDocument();
  });

  it('starts collapsed: revealed rows are not rendered until clicked', () => {
    renderWithProvider(
      <RevealRow kind="hidden" agents={['/a', '/b']} renderRow={renderRow} keyPrefix="g1" />
    );
    expect(screen.queryByText('/a')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /2 hidden/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('clicking expands the row, revealing every hidden agent via the shared row renderer', () => {
    renderWithProvider(
      <RevealRow kind="hidden" agents={['/a', '/b']} renderRow={renderRow} keyPrefix="g1" />
    );
    fireEvent.click(screen.getByRole('button', { name: /2 hidden/ }));
    expect(screen.getByText('/a')).toBeInTheDocument();
    expect(screen.getByText('/b')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /2 hidden/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  it('clicking again collapses it back — a peek, not a persisted mode', () => {
    renderWithProvider(
      <RevealRow kind="hidden" agents={['/a']} renderRow={renderRow} keyPrefix="g1" />
    );
    const button = screen.getByRole('button', { name: /1 hidden/ });
    fireEvent.click(button);
    expect(screen.getByText('/a')).toBeInTheDocument();
    fireEvent.click(button);
    expect(screen.queryByText('/a')).not.toBeInTheDocument();
  });

  it('calls renderRow with the section keyPrefix for each revealed agent', () => {
    const spy = vi.fn(renderRow);
    renderWithProvider(
      <RevealRow kind="hidden" agents={['/a']} renderRow={spy} keyPrefix="group-42" />
    );
    fireEvent.click(screen.getByRole('button', { name: /1 hidden/ }));
    expect(spy).toHaveBeenCalledWith('/a', 'group-42');
  });
});
