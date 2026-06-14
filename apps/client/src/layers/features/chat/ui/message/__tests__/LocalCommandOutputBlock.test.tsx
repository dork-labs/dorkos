/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { LocalCommandOutputBlock } from '../LocalCommandOutputBlock';

describe('LocalCommandOutputBlock', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the command output content under a labelled block', () => {
    render(<LocalCommandOutputBlock content="Context: 42% used (84k/200k tokens)" />);
    expect(screen.getByTestId('local-command-output')).toBeInTheDocument();
    expect(screen.getByText('Command output')).toBeInTheDocument();
    expect(screen.getByText(/Context: 42% used/)).toBeInTheDocument();
  });
});
