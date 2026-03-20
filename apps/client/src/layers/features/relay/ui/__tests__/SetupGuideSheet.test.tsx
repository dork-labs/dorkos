// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SetupGuideSheet } from '../SetupGuideSheet';

describe('SetupGuideSheet', () => {
  it('renders title and content when open', () => {
    render(
      <SetupGuideSheet
        open={true}
        onOpenChange={vi.fn()}
        title="Slack"
        content="Follow these steps."
      />
    );
    expect(screen.getByText('Slack Setup Guide')).toBeTruthy();
    expect(screen.getByText(/Follow these steps/)).toBeTruthy();
  });

  it('is not visible when open is false', () => {
    const { container } = render(
      <SetupGuideSheet open={false} onOpenChange={vi.fn()} title="Slack" content="# Guide" />
    );
    expect(container.querySelector('[data-slot="sheet-content"]')).toBeNull();
  });

  it('renders content markdown when open', () => {
    render(
      <SetupGuideSheet
        open={true}
        onOpenChange={vi.fn()}
        title="Telegram"
        content="Setup content here."
      />
    );
    expect(screen.getByText(/Setup content here/)).toBeTruthy();
  });
});
