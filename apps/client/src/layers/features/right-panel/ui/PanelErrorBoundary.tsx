import { Component, type ErrorInfo, type ReactNode } from 'react';

interface PanelErrorBoundaryProps {
  tabId: string | null;
  children: ReactNode;
}

interface PanelErrorBoundaryState {
  hasError: boolean;
}

/**
 * Error boundary for right panel tab components.
 *
 * Catches render errors and displays a fallback instead of crashing the
 * entire app shell. Resets when the active tab changes (via key prop).
 */
export class PanelErrorBoundary extends Component<
  PanelErrorBoundaryProps,
  PanelErrorBoundaryState
> {
  state: PanelErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): PanelErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[RightPanel] Tab component error:', error, info);
  }

  componentDidUpdate(prevProps: PanelErrorBoundaryProps): void {
    // Reset error state when the tab changes
    if (prevProps.tabId !== this.props.tabId && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex h-full items-center justify-center p-4">
          <p className="text-muted-foreground text-sm">Something went wrong in this panel.</p>
        </div>
      );
    }
    return this.props.children;
  }
}
