import { cloudFailure } from '@/layers/entities/connectors';
import { SETTINGS_RELINK_SECTION, useSettingsDeepLink } from '@/layers/shared/model';
import { Button, QueryErrorState } from '@/layers/shared/ui';

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
  const settings = useSettingsDeepLink();
  const failure = cloudFailure(error);
  return (
    <div className="space-y-2">
      <QueryErrorState
        title={failure?.title ?? title}
        description={failure?.description ?? description}
        {...retry}
      />
      {failure?.action === 'relink' && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => settings.open('access', SETTINGS_RELINK_SECTION)}
        >
          Link my DorkOS account again
        </Button>
      )}
    </div>
  );
}
