import { CircleCheckIcon, InfoIcon, OctagonXIcon, TriangleAlertIcon } from 'lucide-react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';
import { useTheme } from '../model/use-theme';
import { Spinner } from './spinner';

/** Theme-aware toast notification container with custom status icons. */
function Toaster({ ...props }: ToasterProps) {
  const { theme } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps['theme']}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Spinner />,
      }}
      style={
        {
          '--normal-bg': 'var(--color-popover)',
          '--normal-text': 'var(--color-popover-foreground)',
          '--normal-border': 'var(--color-border)',
          '--border-radius': 'var(--radius)',
        } as React.CSSProperties
      }
      {...props}
    />
  );
}

export { Toaster };
