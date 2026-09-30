import { Button } from '@dork-labs/ui';
import type { CommunityWireAuthOptions } from '@dorkos/shared/community-wire';

/** A provider the host offers beside email and password. */
export type SignInProvider = 'google' | 'github' | 'oidc';

/**
 * One "Continue with …" button for each provider the host offers; nothing when it offers none.
 * Sign-in, invitation, owner claim and pairing pages all show the same row.
 */
export function ProviderButtons({
  providers,
  disabled,
  onChoose,
}: {
  providers: CommunityWireAuthOptions;
  disabled: boolean;
  onChoose: (provider: SignInProvider) => void;
}) {
  const offered: [SignInProvider, string][] = [
    ...(providers.google ? [['google', 'Google'] as [SignInProvider, string]] : []),
    ...(providers.github ? [['github', 'GitHub'] as [SignInProvider, string]] : []),
    ...(providers.oidc ? [['oidc', providers.oidc.label] as [SignInProvider, string]] : []),
  ];
  if (!offered.length) return null;
  return (
    <div className="row mt-4">
      {offered.map(([provider, label]) => (
        <Button
          key={provider}
          variant="outline"
          type="button"
          disabled={disabled}
          onClick={() => onChoose(provider)}
        >
          Continue with {label}
        </Button>
      ))}
    </div>
  );
}
