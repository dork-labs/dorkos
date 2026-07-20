import { Component, type ErrorInfo, type ReactNode } from 'react';

interface SidebarBodyErrorBoundaryProps {
  /** The winning `sidebar.body` contribution's id — a change resets the error. */
  contributionId: string;
  children: ReactNode;
}

interface SidebarBodyErrorBoundaryState {
  hasError: boolean;
}

/**
 * Error boundary for contributed `sidebar.body` takeovers.
 *
 * AppShell is the `_shell` route component, so an error thrown by a lazy body
 * chunk (a 404 on a stale deploy) or by the body's render would otherwise
 * escape to the router's `defaultErrorComponent` and replace the ENTIRE shell —
 * sidebar, header, and content. This boundary sits at the slot seam (paired
 * with the seam's `Suspense`), so every current and future `sidebar.body`
 * consumer inherits it: a failing takeover degrades to a small inline message
 * inside an otherwise fully working shell. It resets when the winning
 * contribution changes, so navigating away and back re-attempts the render.
 * Mirrors `PanelErrorBoundary` on the sibling slots.
 */
export class SidebarBodyErrorBoundary extends Component<
  SidebarBodyErrorBoundaryProps,
  SidebarBodyErrorBoundaryState
> {
  state: SidebarBodyErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): SidebarBodyErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[Sidebar] Body contribution error:', error, info);
  }

  componentDidUpdate(prevProps: SidebarBodyErrorBoundaryProps): void {
    // Reset error state when a different contribution wins the slot.
    if (prevProps.contributionId !== this.props.contributionId && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          data-testid="sidebar-body-error"
          className="flex h-full items-center justify-center p-4"
        >
          <p className="text-muted-foreground text-center text-sm">
            This panel couldn&apos;t load. Reload the page to try again.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
