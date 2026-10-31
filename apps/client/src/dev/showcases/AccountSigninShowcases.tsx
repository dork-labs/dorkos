import { RuntimeSigninBanner } from '@/layers/widgets/app-banner';
import { ClaudeAccountsSection } from '@/layers/features/settings';
import { MockedQueryProvider } from './settings-showcase-helpers';
import { MOCK_SERVER_CONFIG_MULTI_ACCOUNT } from './settings-mock-data';
import { MOCK_ACCOUNT_USAGE } from './account-mock-data';
import { PlaygroundSection } from '../PlaygroundSection';

const accounts = MOCK_SERVER_CONFIG_MULTI_ACCOUNT.claudeCode!.accounts.slice(0, 2).map(
  (account, index) => ({
    ...account,
    id: `claude${5 - index}`,
    label: `Claude${5 - index}`,
    path: `/Users/dev/.claude${5 - index}`,
    onlyProjects: undefined,
  })
);
const config = {
  ...MOCK_SERVER_CONFIG_MULTI_ACCOUNT,
  claudeCode: {
    ...MOCK_SERVER_CONFIG_MULTI_ACCOUNT.claudeCode!,
    accounts,
    resolvedAccount: accounts[0].path,
    resolvedAccountId: accounts[0].id,
    projectAccounts: [],
  },
};
const usage = accounts.map((account) => ({
  ...MOCK_ACCOUNT_USAGE[0],
  accountId: account.id,
  path: account.path,
  label: account.label,
  color: account.color,
  signInState: 'signed-out' as const,
}));

/** Real recovery components over mock account records; no login or account probe. */
export function AccountSigninShowcases() {
  return (
    <PlaygroundSection
      title="Account sign-in recovery"
      description="Mock accounts needing a sign-in."
    >
      <MockedQueryProvider config={config} usage={usage}>
        <div className="w-full space-y-6">
          <div data-testid="signin-shot-one">
            <RuntimeSigninBanner runtimes={[`claude-code:${accounts[0].path}`]} />
          </div>
          <div data-testid="signin-shot-two">
            <RuntimeSigninBanner
              runtimes={accounts.map((account) => `claude-code:${account.path}`)}
            />
          </div>
          <div data-testid="signin-shot-rows" className="rounded-lg border p-4">
            <ClaudeAccountsSection />
          </div>
        </div>
      </MockedQueryProvider>
    </PlaygroundSection>
  );
}
