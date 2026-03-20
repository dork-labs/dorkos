/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { OverviewPage } from '../pages/OverviewPage';
import {
  TOKENS_SECTIONS,
  FORMS_SECTIONS,
  COMPONENTS_SECTIONS,
  CHAT_SECTIONS,
  FEATURES_SECTIONS,
} from '../playground-registry';
import type { Page } from '../playground-registry';

describe('OverviewPage', () => {
  let onNavigate: (page: Page) => void;

  beforeEach(() => {
    onNavigate = vi.fn();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the page header', () => {
    render(<OverviewPage onNavigate={onNavigate} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('DorkOS Dev Playground');
  });

  it('renders all five category cards', () => {
    render(<OverviewPage onNavigate={onNavigate} />);
    expect(screen.getByRole('heading', { name: 'Design Tokens' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Forms' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Components' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Chat Components' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Feature Components' })).toBeInTheDocument();
  });

  it('displays the correct section count for tokens', () => {
    render(<OverviewPage onNavigate={onNavigate} />);
    const card = screen.getByRole('button', { name: /design tokens/i });
    expect(within(card).getByText(`${TOKENS_SECTIONS.length} sections`)).toBeInTheDocument();
  });

  it('displays the correct section count for forms', () => {
    render(<OverviewPage onNavigate={onNavigate} />);
    const card = screen.getByRole('button', { name: /forms/i });
    expect(within(card).getByText(`${FORMS_SECTIONS.length} sections`)).toBeInTheDocument();
  });

  it('displays the correct section count for components', () => {
    render(<OverviewPage onNavigate={onNavigate} />);
    const card = screen.getByRole('button', { name: /^components/i });
    expect(within(card).getByText(`${COMPONENTS_SECTIONS.length} sections`)).toBeInTheDocument();
  });

  it('displays the correct section count for chat', () => {
    render(<OverviewPage onNavigate={onNavigate} />);
    const card = screen.getByRole('button', { name: /chat components/i });
    expect(within(card).getByText(`${CHAT_SECTIONS.length} sections`)).toBeInTheDocument();
  });

  it('displays the correct section count for features', () => {
    render(<OverviewPage onNavigate={onNavigate} />);
    const card = screen.getByRole('button', { name: /feature components/i });
    expect(within(card).getByText(`${FEATURES_SECTIONS.length} sections`)).toBeInTheDocument();
  });

  it('calls onNavigate with "tokens" when the Design Tokens card is clicked', () => {
    render(<OverviewPage onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: /design tokens/i }));
    expect(onNavigate).toHaveBeenCalledWith('tokens');
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('calls onNavigate with "forms" when the Forms card is clicked', () => {
    render(<OverviewPage onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: /forms/i }));
    expect(onNavigate).toHaveBeenCalledWith('forms');
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('calls onNavigate with "components" when the Components card is clicked', () => {
    render(<OverviewPage onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: /^components/i }));
    expect(onNavigate).toHaveBeenCalledWith('components');
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('calls onNavigate with "chat" when the Chat Components card is clicked', () => {
    render(<OverviewPage onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: /chat components/i }));
    expect(onNavigate).toHaveBeenCalledWith('chat');
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('calls onNavigate with "features" when the Feature Components card is clicked', () => {
    render(<OverviewPage onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: /feature components/i }));
    expect(onNavigate).toHaveBeenCalledWith('features');
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('renders category card descriptions', () => {
    render(<OverviewPage onNavigate={onNavigate} />);
    expect(screen.getByText(/Color palette, typography/)).toBeInTheDocument();
    expect(screen.getByText(/Form primitives and composed input/)).toBeInTheDocument();
    expect(screen.getByText(/Interactive gallery of shared UI primitives/)).toBeInTheDocument();
    expect(screen.getByText(/Visual testing gallery for chat UI/)).toBeInTheDocument();
    expect(screen.getByText(/Domain-specific components from Relay/)).toBeInTheDocument();
  });

  it('each category card is an accessible button', () => {
    render(<OverviewPage onNavigate={onNavigate} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(5);
  });
});
