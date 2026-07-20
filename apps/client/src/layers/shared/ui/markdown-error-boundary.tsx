import { Component, type ErrorInfo, type ReactNode } from 'react';

interface MarkdownErrorBoundaryProps {
  /** The markdown subtree to guard (a `Streamdown` render). */
  children: ReactNode;
  /**
   * Shown in place of the markdown when a render error is caught. Consumers pass
   * copy or a degraded view that fits their surface (a quiet note for a README,
   * the raw text for a chat message). Defaults to a generic muted note.
   */
  fallback?: ReactNode;
  /**
   * Reset the boundary whenever this value changes — pass the markdown content
   * so switching to different content (another package's README, the next chat
   * message) re-attempts the render instead of staying stuck on the fallback.
   */
  resetKey?: unknown;
}

interface MarkdownErrorBoundaryState {
  hasError: boolean;
}

/**
 * Error boundary around a `Streamdown` render.
 *
 * Streamdown loads its syntax-highlighted code-block body from a lazily
 * imported chunk (`React.lazy`). When that chunk fails to fetch — a stale
 * optimized-dep hash after a mid-session Vite re-optimization in dev, or a
 * redeploy that rotated the asset hash while a tab was open in prod — the
 * rejected dynamic import throws past Streamdown's `Suspense` (which only
 * handles the pending state, not rejections) to the nearest error boundary.
 * Without one, the whole route is replaced by the app's error screen just
 * because a README (or a chat message) happened to contain a fenced code block.
 *
 * This catches that error at the markdown seam so the surrounding surface — the
 * package sheet, the chat transcript — stays fully usable, and degrades to a
 * quiet fallback in place of the markdown. It resets when {@link resetKey}
 * changes so new content re-attempts the render.
 */
export class MarkdownErrorBoundary extends Component<
  MarkdownErrorBoundaryProps,
  MarkdownErrorBoundaryState
> {
  state: MarkdownErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): MarkdownErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[Markdown] Render error:', error, info.componentStack);
  }

  componentDidUpdate(prevProps: MarkdownErrorBoundaryProps): void {
    // Re-attempt the render when the content changes (e.g. a different package's
    // README, or the next chat message) so the fallback never outlives the
    // content that failed.
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <p className="text-muted-foreground text-sm">This content couldn&rsquo;t be displayed.</p>
        )
      );
    }
    return this.props.children;
  }
}
