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

  // DOR-795: a backgrounded helper's tool call is auto-denied by the runtime and
  // the refusal lands in the helper's own notes, which nobody reads. This chip in
  // the main conversation is the only warning that work never happened, so it has
  // to name the helper, the tool, and why nobody was asked.
  it('attributes a backgrounded helper denial to the helper and the tool', () => {
    render(
      <PermissionDeniedChip
        toolName="Bash"
        reasonType="asyncAgent"
        agentId="agent_child_7abcdef"
        message="Backgrounded agents cannot request permission."
      />
    );

    const chip = screen.getByTestId('permission-denied-chip');
    expect(chip).toHaveTextContent(
      'Helper agent_ch was blocked from using Bash: Backgrounded agents cannot request permission.'
    );
    expect(chip).toHaveTextContent(/can’t ask you to approve anything/);
    expect(chip).toHaveAttribute('data-agent-id', 'agent_child_7abcdef');
  });

  it('still says a helper was blocked when the runtime named none', () => {
    render(
      <PermissionDeniedChip
        toolName="Edit"
        reasonType="asyncAgent"
        message="Backgrounded agents cannot request permission."
      />
    );

    expect(screen.getByTestId('permission-denied-chip')).toHaveTextContent(
      'A background helper was blocked from using Edit:'
    );
  });

  it('attributes a named helper on a non-asyncAgent denial too', () => {
    render(
      <PermissionDeniedChip
        toolName="WebFetch"
        reasonType="classifier"
        agentId="agent_child_9"
        reason="Untrusted host"
        message="Blocked."
      />
    );

    expect(screen.getByTestId('permission-denied-chip')).toHaveTextContent(
      'Helper agent_ch was blocked from using WebFetch by the auto-mode classifier: Untrusted host'
    );
  });

  it('never invents a helper for an unattributed denial', () => {
    // No agentId and no asyncAgent reason means the main agent was blocked —
    // naming a helper would report a child that never existed.
    render(<PermissionDeniedChip toolName="Bash" reasonType="rule" message="Rule blocked it." />);

    const chip = screen.getByTestId('permission-denied-chip');
    expect(chip).not.toHaveTextContent(/helper/i);
    expect(chip).not.toHaveAttribute('data-agent-id');
  });
});
