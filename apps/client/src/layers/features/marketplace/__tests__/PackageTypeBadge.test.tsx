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
    expect(badge.className).toContain('package-connector');
    expect(badge.className).not.toContain('package-adapter');
  });

  // Hues live in the `--package-*` token family, which carries a value per
  // theme. A palette class like `bg-cyan-500/10` was one colour asked to work
  // over a near-white page and a near-black one.
  it('paints every hue from the package token family, never a raw palette class', () => {
    render(
      <>
        <PackageTypeBadge type="agent" />
        <PackageTypeBadge type="plugin" />
        <PackageTypeBadge type="skill-pack" />
        <PackageTypeBadge type="adapter" />
        <PackageTypeBadge type="shape" />
      </>
    );
    for (const label of ['AGENT', 'PLUGIN', 'SKILL PACK', 'ADAPTER', 'SHAPE']) {
      const className = screen.getByText(label).className;
      expect(className).toMatch(/bg-package-[a-z]+-bg/);
      expect(className).not.toMatch(/-(blue|purple|emerald|amber|rose|cyan)-\d/);
    }
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
