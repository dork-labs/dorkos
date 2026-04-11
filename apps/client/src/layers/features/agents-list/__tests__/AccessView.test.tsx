/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('@/layers/features/mesh', () => ({
  TopologyPanel: () => <div data-testid="topology-panel">TopologyPanel</div>,
}));

import { AccessView } from '../ui/AccessView';

afterEach(cleanup);

describe('AccessView', () => {
  it('renders TopologyPanel', () => {
    render(<AccessView />);
    expect(screen.getByTestId('topology-panel')).toBeInTheDocument();
  });
});
