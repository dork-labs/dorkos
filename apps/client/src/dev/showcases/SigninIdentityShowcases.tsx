import { useState } from 'react';
import type { Transport } from '@dorkos/shared/transport';
import type { ClaudeSigninPolicyView } from '@dorkos/shared/runtime-connect';
import { AccountSigninIdentity, SigninFailure } from '@/layers/entities/runtime';
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
      accountId: 'six',
      name: 'Claude6',
      path: '/Users/dev/.claude6',
      identity: { state: 'unconfirmed', email: 'e…@example.com' },
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
            return async () => ({
              ok: true,
              identity: { state: 'confirmed', email: 'b…@example.com' },
            });
          return Reflect.get(target, property, receiver);
        },
      })
  );
  return <TransportProvider transport={transport}>{children}</TransportProvider>;
}
/** The person's sign-in review and Never use lists, backed entirely by fake metadata. */
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
                <AccountSigninIdentity
                  accountId={account.accountId}
                  accountRoot={account.path}
                  name={account.name}
                />
              </div>
            ))}
            <div data-testid="identity-shot-policy">
              <SigninPolicySection />
            </div>
          </div>
        </FakeOwnerTransport>
      </MockedQueryProvider>
      <div data-testid="signin-failure-shots" className="mt-5 space-y-3">
        {FAILURE_REASONS.map((reason) => (
          <div key={reason ?? 'none'} className="rounded-lg border p-4">
            <SigninFailure name="Claude5" reason={reason} />
          </div>
        ))}
      </div>
    </PlaygroundSection>
  );
}

/**
 * What a failed sign-in can say under an account (DOR-4426). Copies of the
 * server's lines in `services/runtimes/connect/login-failure.ts`, plus `null`
 * for a request that never got an answer.
 */
const FAILURE_REASONS: (string | null)[] = [
  'Sign-in timed out. Finish it in the browser within 3 minutes, then try again.',
  'The sign-in couldn’t start. Reinstall DorkOS, then try again.',
  'The sign-in service couldn’t be reached. Check your connection, then try again.',
  'The sign-in couldn’t be saved on this computer. Try signing in from a terminal.',
  'This account was refused. Sign in with a different account.',
  'The sign-in stopped before it finished. Try again, or sign in from a terminal.',
  null,
];
