/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { PackageTypeBadge } from '../ui/PackageTypeBadge';

afterEach(cleanup);

describe('PackageTypeBadge', () => {
  it('renders the plain type label for each package type', () => {
    render(<PackageTypeBadge type="adapter" />);
    expect(screen.getByText('ADAPTER')).toBeInTheDocument();
  });

  it('renders CONNECTOR for an adapter whose adapterType is the connector value', () => {
    render(<PackageTypeBadge type="adapter" adapterType="connector" />);
    expect(screen.getByText('CONNECTOR')).toBeInTheDocument();
    expect(screen.queryByText('ADAPTER')).not.toBeInTheDocument();
  });

  it('gives the connector badge a hue distinct from the plain adapter badge', () => {
    render(<PackageTypeBadge type="adapter" adapterType="connector" />);
    const badge = screen.getByText('CONNECTOR');
    expect(badge.className).toContain('cyan');
    expect(badge.className).not.toContain('amber');
  });

  it('keeps the ADAPTER badge for other adapter types', () => {
    render(<PackageTypeBadge type="adapter" adapterType="slack" />);
    expect(screen.getByText('ADAPTER')).toBeInTheDocument();
  });

  it('ignores adapterType on non-adapter packages', () => {
    render(<PackageTypeBadge type="plugin" adapterType="connector" />);
    expect(screen.getByText('PLUGIN')).toBeInTheDocument();
    expect(screen.queryByText('CONNECTOR')).not.toBeInTheDocument();
  });
});
