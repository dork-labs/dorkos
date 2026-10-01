import { cloudFailure } from '@/layers/entities/connectors';
import { SETTINGS_RELINK_SECTION, useSettingsDeepLink } from '@/layers/shared/model';
import { Button, QueryErrorState, type ButtonProps } from '@/layers/shared/ui';

/** Props for {@link LoadFailedState}. */
export interface LoadFailedStateProps {
  /** The error the failed load settled with. */
  error: unknown;
  /** The surface's own title, kept for any failure that isn't a DorkOS account problem. */
  title: string;
  /** The surface's own description, kept the same way. */
  description: string;
  onRetry: () => void;
  isRetrying?: boolean;
}

/**
 * A failed load that says where the problem is. A DorkOS account problem gets
 * its own words, and a link problem gets the one action that fixes it; any
 * other failure keeps the surface's own copy.
 */
export function LoadFailedState({ error, title, description, ...retry }: LoadFailedStateProps) {
  const failure = cloudFailure(error);
  return (
    <div className="space-y-2">
      <QueryErrorState
        title={failure?.title ?? title}
        description={failure?.description ?? description}
        {...retry}
      />
      {failure?.action === 'relink' && <RelinkButton variant="outline" size="sm" />}
    </div>
  );
}

/**
 * The one action a link problem needs: open Settings › DorkOS account and start
 * linking this computer to the DorkOS account again, in one click.
 */
export function RelinkButton(props: Pick<ButtonProps, 'variant' | 'size' | 'className'>) {
  const settings = useSettingsDeepLink();
  return (
    <Button {...props} onClick={() => settings.open('account', SETTINGS_RELINK_SECTION)}>
      Link my DorkOS account again
    </Button>
  );
}
