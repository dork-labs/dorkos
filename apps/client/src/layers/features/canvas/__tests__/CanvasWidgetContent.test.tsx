/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { CanvasWidgetContent } from '../ui/CanvasWidgetContent';

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

describe('CanvasWidgetContent', () => {
  it('renders the widget definition in the canvas', () => {
    const content: Extract<UiCanvasContent, { type: 'widget' }> = {
      type: 'widget',
      title: 'Metrics',
      definition: {
        version: 1,
        title: 'Metrics',
        root: { type: 'stat', label: 'Uptime', value: '99.9%' },
      },
    };
    render(<CanvasWidgetContent content={content} />);
    expect(screen.getByText('Uptime')).toBeInTheDocument();
    expect(screen.getByText('99.9%')).toBeInTheDocument();
  });
});
