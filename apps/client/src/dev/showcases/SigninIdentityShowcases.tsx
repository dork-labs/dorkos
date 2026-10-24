import { useState } from 'react';
import type { Transport } from '@dorkos/shared/transport';
import type { ClaudeSigninPolicyView } from '@dorkos/shared/runtime-connect';
import { AccountSigninIdentity } from '@/layers/entities/runtime';
import { SigninPolicySection } from '@/layers/features/settings';
import { TransportProvider, useTransport } from '@/layers/shared/model';
import { MockedQueryProvider } from './settings-showcase-helpers';
import { PlaygroundSection } from '../PlaygroundSection';

const policy: ClaudeSigninPolicyView = {
  deniedOrganizations: [{ id: '11111111-1111-4111-8111-111111111111', label: 'Client work' }],
  folders: [{ accountId: 'excluded', path: '/Users/dev/.claude-client', label: 'Client folder' }],
  accounts: [
    {
      accountId: 'five',
      name: 'Claude5',
      path: '/Users/dev/.claude5',
      identity: { state: 'changed', email: 'b…@example.com', previousEmail: 'd…@example.net' },
    },
    {
      accountId: 'four',
      name: 'Claude4',
      path: '/Users/dev/.claude4',
      identity: { state: 'blocked' },
    },
  ],
};
function FakeOwnerTransport({ children }: { children: React.ReactNode }) {
  const base = useTransport();
  const [transport] = useState<Transport>(
    () =>
      new Proxy(base, {
        get(target, property, receiver) {
          if (property === 'getClaudeSigninPolicy') return async () => policy;
          if (property === 'changeClaudeSigninPolicy') return async () => ({ ok: true });
          if (property === 'delegateRuntimeLogin')
            return async () => ({ ok: false, identity: { state: 'changed' } });
          return Reflect.get(target, property, receiver);
        },
      })
  );
  return <TransportProvider transport={transport}>{children}</TransportProvider>;
}
/** Owner-only identity review and exclusions, backed entirely by fake metadata. */
export function SigninIdentityShowcases() {
  return (
    <PlaygroundSection
      title="Sign-in identity"
      description="Fake identity changes and exclusions. No vendor process runs."
    >
      <MockedQueryProvider>
        <FakeOwnerTransport>
          <div data-testid="signin-identity-shots" className="space-y-5">
            {policy.accounts.map((account) => (
              <div
                key={account.accountId}
                data-testid={`identity-shot-${account.accountId}`}
                className="rounded-lg border p-4"
              >
                <p className="mb-1 text-sm font-medium">{account.name}</p>
                <p className="text-muted-foreground mb-2 text-xs">{account.path}</p>
                <AccountSigninIdentity accountId={account.accountId} name={account.name} />
              </div>
            ))}
            <div data-testid="identity-shot-policy">
              <SigninPolicySection />
            </div>
          </div>
        </FakeOwnerTransport>
      </MockedQueryProvider>
    </PlaygroundSection>
  );
}
