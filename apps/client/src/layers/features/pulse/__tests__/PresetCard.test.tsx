/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { PulsePreset } from '@dorkos/shared/types';
import { PresetCard } from '../ui/PresetCard';

vi.mock('../ui/use-spotlight', () => ({
  useSpotlight: () => ({ onMouseMove: vi.fn(), onMouseLeave: vi.fn(), spotlightStyle: null }),
}));
vi.mock('../ui/format-cron', () => ({ formatCron: (cron: string) => `cron:${cron}` }));

const PRESET: PulsePreset = {
  id: 'health-check',
  name: 'Health Check',
  description: 'Run lint, tests, and type-check.',
  prompt: 'Run the project health checks.',
  cron: '0 8 * * 1',
  timezone: 'UTC',
  category: 'maintenance',
};

describe('PresetCard', () => {
  afterEach(() => { cleanup(); });
  beforeEach(() => { vi.clearAllMocks(); });

  describe('toggle variant', () => {
    it('renders the preset name and description', () => {
      render(<PresetCard preset={PRESET} variant="toggle" checked={false} onCheckedChange={vi.fn()} />);
      expect(screen.getByText('Health Check')).toBeTruthy();
      expect(screen.getByText('Run lint, tests, and type-check.')).toBeTruthy();
    });

    it('calls onCheckedChange when the card is clicked', () => {
      const onCheckedChange = vi.fn();
      render(<PresetCard preset={PRESET} variant="toggle" checked={false} onCheckedChange={onCheckedChange} />);
      fireEvent.click(screen.getByRole('button'));
      expect(onCheckedChange).toHaveBeenCalledWith(true);
    });

    it('renders a Switch element (aria-label present)', () => {
      render(<PresetCard preset={PRESET} variant="toggle" checked={true} onCheckedChange={vi.fn()} />);
      expect(screen.getByRole('switch', { name: /Enable Health Check/i })).toBeTruthy();
    });

    it('applies checked styles when checked=true', () => {
      const { container } = render(<PresetCard preset={PRESET} variant="toggle" checked={true} onCheckedChange={vi.fn()} />);
      const btn = container.querySelector('button')!;
      expect(btn.className).toContain('border-primary/40');
    });
  });

  describe('selectable variant', () => {
    it('renders the preset name and description', () => {
      render(<PresetCard preset={PRESET} variant="selectable" onSelect={vi.fn()} />);
      expect(screen.getByText('Health Check')).toBeTruthy();
    });

    it('calls onSelect with the preset when clicked', () => {
      const onSelect = vi.fn();
      render(<PresetCard preset={PRESET} variant="selectable" onSelect={onSelect} />);
      fireEvent.click(screen.getByRole('button'));
      expect(onSelect).toHaveBeenCalledWith(PRESET);
    });

    it('does not render a Switch element', () => {
      render(<PresetCard preset={PRESET} variant="selectable" onSelect={vi.fn()} />);
      expect(screen.queryByRole('switch')).toBeNull();
    });

    it('applies selection ring styles when selected=true', () => {
      const { container } = render(<PresetCard preset={PRESET} variant="selectable" selected={true} onSelect={vi.fn()} />);
      const btn = container.querySelector('button')!;
      expect(btn.className).toContain('ring-primary');
    });

    it('does not apply selection ring when selected=false', () => {
      const { container } = render(<PresetCard preset={PRESET} variant="selectable" selected={false} onSelect={vi.fn()} />);
      const btn = container.querySelector('button')!;
      expect(btn.className).not.toContain('ring-primary');
    });
  });
});
