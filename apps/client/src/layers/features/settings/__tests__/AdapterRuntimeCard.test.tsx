/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { Bot } from 'lucide-react';

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

afterEach(cleanup);

import { AdapterRuntimeCard } from '../ui/AdapterRuntimeCard';

describe('AdapterRuntimeCard', () => {
  it('renders the adapter name and description', () => {
    render(
      <AdapterRuntimeCard
        name="Claude Code"
        icon={Bot}
        description="Anthropic coding runtime"
        status="active"
        enabled={true}
      />
    );

    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('Anthropic coding runtime')).toBeInTheDocument();
  });

  it('shows Active badge when status is active', () => {
    render(
      <AdapterRuntimeCard
        name="Claude Code"
        icon={Bot}
        description="Active adapter"
        status="active"
        enabled={true}
      />
    );

    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows Coming Soon badge when status is coming-soon', () => {
    render(
      <AdapterRuntimeCard
        name="OpenAI"
        icon={Bot}
        description="GPT models"
        status="coming-soon"
        enabled={false}
      />
    );

    expect(screen.getByText('Coming Soon')).toBeInTheDocument();
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
  });

  it('does not show any badge when status is disabled', () => {
    render(
      <AdapterRuntimeCard
        name="Local"
        icon={Bot}
        description="Local model"
        status="disabled"
        enabled={false}
      />
    );

    expect(screen.queryByText('Active')).not.toBeInTheDocument();
    expect(screen.queryByText('Coming Soon')).not.toBeInTheDocument();
  });

  it('renders the toggle switch when onToggle is provided and not coming-soon', () => {
    const onToggle = vi.fn();

    render(
      <AdapterRuntimeCard
        name="Claude Code"
        icon={Bot}
        description="Active adapter"
        status="active"
        enabled={true}
        onToggle={onToggle}
      />
    );

    expect(screen.getByRole('switch')).toBeInTheDocument();
  });

  it('does not render toggle for coming-soon adapters', () => {
    render(
      <AdapterRuntimeCard
        name="OpenAI"
        icon={Bot}
        description="GPT models"
        status="coming-soon"
        enabled={false}
        onToggle={vi.fn()}
      />
    );

    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('calls onToggle when the switch is clicked', () => {
    const onToggle = vi.fn();

    render(
      <AdapterRuntimeCard
        name="Claude Code"
        icon={Bot}
        description="Active adapter"
        status="active"
        enabled={true}
        onToggle={onToggle}
      />
    );

    // Use fireEvent instead of userEvent because the Switch (a button) is nested
    // inside the header <button>. userEvent walks the ancestor chain and fails on
    // the illegal <button>-in-<button> nesting in jsdom.
    fireEvent.click(screen.getByRole('switch'));
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it('expands to show children when header is clicked', async () => {
    const user = userEvent.setup();

    render(
      <AdapterRuntimeCard
        name="Claude Code"
        icon={Bot}
        description="Active adapter"
        status="active"
        enabled={true}
      >
        <div>Max turns setting</div>
      </AdapterRuntimeCard>
    );

    // Children not visible initially
    expect(screen.queryByText('Max turns setting')).not.toBeInTheDocument();

    // Click header to expand
    await user.click(screen.getByRole('button', { name: /claude code/i }));

    expect(screen.getByText('Max turns setting')).toBeInTheDocument();
  });

  it('does not expand coming-soon cards even with children', async () => {
    const user = userEvent.setup();

    render(
      <AdapterRuntimeCard
        name="OpenAI"
        icon={Bot}
        description="GPT models"
        status="coming-soon"
        enabled={false}
      >
        <div>Should not appear</div>
      </AdapterRuntimeCard>
    );

    // The header button should be disabled for coming-soon
    const headerBtn = screen.getByRole('button', { name: /openai/i });
    expect(headerBtn).toBeDisabled();

    await user.click(headerBtn);
    expect(screen.queryByText('Should not appear')).not.toBeInTheDocument();
  });

  it('collapses when header is clicked again', async () => {
    const user = userEvent.setup();

    render(
      <AdapterRuntimeCard
        name="Claude Code"
        icon={Bot}
        description="Active adapter"
        status="active"
        enabled={true}
      >
        <div>Expandable content</div>
      </AdapterRuntimeCard>
    );

    const headerBtn = screen.getByRole('button', { name: /claude code/i });

    // Expand
    await user.click(headerBtn);
    expect(screen.getByText('Expandable content')).toBeInTheDocument();

    // Collapse
    await user.click(headerBtn);
    // After animation, content should be removed
    // AnimatePresence handles this — in test we check it's gone
    expect(screen.queryByText('Expandable content')).not.toBeInTheDocument();
  });

  it('disables header button when no expandable body exists', () => {
    render(
      <AdapterRuntimeCard
        name="Claude Code"
        icon={Bot}
        description="Active adapter"
        status="active"
        enabled={true}
      />
    );

    const headerBtn = screen.getByRole('button', { name: /claude code/i });
    expect(headerBtn).toBeDisabled();
  });
});
