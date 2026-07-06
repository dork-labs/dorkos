/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ModelNatureBadge } from '../ui/ModelNatureBadge';

afterEach(cleanup);

describe('ModelNatureBadge', () => {
  it('renders the local · private · free badge and benefit line for an Ollama model', () => {
    render(<ModelNatureBadge provider="ollama" modelId="ollama/qwen2.5-coder:7b" detail />);

    expect(screen.getByText('local · private · free')).toBeInTheDocument();
    expect(screen.getByText(/private and free/i)).toBeInTheDocument();
  });

  it('renders the cloud · per-token badge for an OpenRouter model', () => {
    render(<ModelNatureBadge provider="openrouter" modelId="anthropic/claude-3.5-sonnet" />);

    expect(screen.getByText('cloud · per-token')).toBeInTheDocument();
    expect(screen.queryByText('local · private · free')).not.toBeInTheDocument();
  });

  it('renders the honest capability caveat for a sub-14B local model — no frontier claim', () => {
    render(<ModelNatureBadge provider="ollama" modelId="ollama/qwen2.5-coder:7b" detail />);

    // The capability line names the honest tradeoff rather than claiming parity.
    expect(screen.getByText(/not frontier/i)).toBeInTheDocument();
    expect(screen.getByText(/14B/i)).toBeInTheDocument();
    expect(screen.queryByText(/claude-equivalent/i)).not.toBeInTheDocument();
  });

  it('tags the badge with its derived locality for styling/inspection', () => {
    const { container } = render(
      <ModelNatureBadge provider="ollama" modelId="qwen2.5-coder:32b" />
    );
    expect(container.querySelector('[data-locality="local"]')).not.toBeNull();
  });
});
