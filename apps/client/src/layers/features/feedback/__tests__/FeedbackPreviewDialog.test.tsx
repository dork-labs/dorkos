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

  it('places the footer after the scroll area, as its sibling in the flex column', () => {
    renderDialog();

    const footerBar = screen
      .getByText(/Only the DorkOS core team sees these/)
      .closest('[data-slot="feedback-preview-footer"]');
    const scrollArea = document.querySelector('[data-slot="scroll-area"]');
    // The panel `<TabsContent>` wraps the scroll area — its parent is the same
    // `Tabs` flex column the footer is a direct child of.
    const tabPanel = scrollArea?.closest('[data-slot="tabs-content"]');
    expect(footerBar).not.toBeNull();
    expect(scrollArea).not.toBeNull();
    expect(tabPanel).not.toBeNull();

    // Same flex column, and the footer strictly AFTER the tab panel in tree
    // order — the ordering `Tabs`' layout (and the paint order the docblock on
    // `PrivacyNote` explains) depends on.
    expect(footerBar?.parentElement).toBe(tabPanel?.parentElement);
    expect(tabPanel?.compareDocumentPosition(footerBar as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });
});
