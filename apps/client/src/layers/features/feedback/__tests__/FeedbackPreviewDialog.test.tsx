// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { FeedbackDiagnostics } from '@dorkos/shared/telemetry-events';
import { FeedbackPreviewDialog } from '../ui/FeedbackPreviewDialog';

/**
 * DOR-1962: the "Private. Only the DorkOS core team sees these." footer must
 * stay a fully opaque, non-shrinking bar below the scroll area — never a
 * transparent line the scrolled content can show through.
 */
describe('FeedbackPreviewDialog', () => {
  const diagnostics: FeedbackDiagnostics = {
    clientReport: {
      version: '0.90.0',
      platform: 'darwin',
      runtimes: ['claude-code'],
      flags: { 'telemetry.install': true },
    },
  };

  function renderDialog() {
    render(
      <FeedbackPreviewDialog
        open
        onOpenChange={() => {}}
        initialTab="diagnostics"
        diagnostics={diagnostics}
        kind="bug"
        route="/team"
        showConversation={false}
        sessionId={undefined}
      />
    );
  }

  it('renders the privacy footer outside the scrollable diagnostics region', () => {
    renderDialog();

    const footerText = screen.getByText(/Only the DorkOS core team sees these/);
    const footerBar = footerText.closest('[data-slot="feedback-preview-footer"]');
    expect(footerBar).not.toBeNull();

    // The footer must not be a descendant of the scroll area's viewport — it
    // has to sit below it in the flex column, never inside the scrolled
    // content it would otherwise overlap.
    const scrollViewport = document.querySelector('[data-slot="scroll-area-viewport"]');
    expect(scrollViewport).not.toBeNull();
    expect(scrollViewport?.contains(footerBar)).toBe(false);
  });

  it('gives the footer an opaque background so scrolled content cannot show through', () => {
    renderDialog();

    const footerBar = screen
      .getByText(/Only the DorkOS core team sees these/)
      .closest('[data-slot="feedback-preview-footer"]');
    expect(footerBar).not.toBeNull();
    expect(footerBar?.className).toMatch(/\bbg-background\b/);
    expect(footerBar?.className).toMatch(/\bshrink-0\b/);
  });
});
