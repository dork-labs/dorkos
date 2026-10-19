import type { CommunityWireAuthOptions } from '@dorkos/shared/community-wire';
import { ProviderButton, type SignInProvider } from './ProviderButton.js';

export type { SignInProvider } from './ProviderButton.js';

/**
 * One "Continue with …" button for each provider the host offers, stacked full width; nothing
 * when it offers none. Sign-in, invitation, owner claim and pairing pages all show the same stack.
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
    <div className="mt-4 flex flex-col gap-2">
      {offered.map(([provider, label]) => (
        <ProviderButton
          key={provider}
          provider={provider}
          label={label}
          // An older server sends no mark; it reads as none.
          mark={provider === 'oidc' ? (providers.oidc?.mark ?? null) : null}
          disabled={disabled}
          onClick={() => onChoose(provider)}
        />
      ))}
    </div>
  );
}
