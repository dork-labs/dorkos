import { Component, type ErrorInfo, type ReactNode } from 'react';

interface SidebarTabErrorBoundaryProps {
  tabId: string | null;
  children: ReactNode;
}

interface SidebarTabErrorBoundaryState {
  hasError: boolean;
}

/**
 * Error boundary for extension-contributed sidebar tab panels.
 *
 * A third-party tab component that throws while rendering must not take down
 * the whole sidebar (tab strip, session list, built-in panels) with it. This
 * catches the error and shows a small fallback in the panel area instead. It
 * resets when the active tab changes, so switching away and back re-attempts
 * the render. Mirrors the right panel's `PanelErrorBoundary`.
 */
export class SidebarTabErrorBoundary extends Component<
  SidebarTabErrorBoundaryProps,
  SidebarTabErrorBoundaryState
> {
  state: SidebarTabErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): SidebarTabErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[Sidebar] Tab component error:', error, info);
  }

  componentDidUpdate(prevProps: SidebarTabErrorBoundaryProps): void {
    // Reset error state when the active tab changes.
    if (prevProps.tabId !== this.props.tabId && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex h-full items-center justify-center p-4">
          <p className="text-muted-foreground text-sm">Something went wrong in this tab.</p>
        </div>
      );
    }
    return this.props.children;
  }
}
