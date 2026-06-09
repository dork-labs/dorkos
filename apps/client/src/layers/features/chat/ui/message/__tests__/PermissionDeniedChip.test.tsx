// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { PermissionDeniedChip } from '../PermissionDeniedChip';

afterEach(cleanup);

describe('PermissionDeniedChip', () => {
  it('renders classifier-specific copy with the reason for classifier denials', () => {
    render(
      <PermissionDeniedChip
        toolName="Bash"
        reasonType="classifier"
        reason="Destructive shell command"
        message="Blocked by the safety classifier."
      />
    );

    const chip = screen.getByTestId('permission-denied-chip');
    expect(chip).toHaveTextContent('Blocked by auto-mode classifier: Destructive shell command');
    expect(chip).toHaveTextContent('Bash');
    expect(chip).toHaveAttribute('data-reason-type', 'classifier');
  });

  it('falls back to the message when reason is absent', () => {
    render(
      <PermissionDeniedChip
        toolName="Write"
        reasonType="classifier"
        message="Write outside the working directory is not allowed."
      />
    );

    expect(screen.getByTestId('permission-denied-chip')).toHaveTextContent(
      'Blocked by auto-mode classifier: Write outside the working directory is not allowed.'
    );
  });

  it('uses generic blocked copy for non-classifier denials', () => {
    render(<PermissionDeniedChip toolName="Bash" reasonType="rule" message="Rule blocked it." />);

    const chip = screen.getByTestId('permission-denied-chip');
    expect(chip).toHaveTextContent('Blocked: Rule blocked it.');
    expect(chip).not.toHaveTextContent('auto-mode classifier');
  });
});
