import { describe, expect, it } from 'vitest';
import { accessLevelRevisionIds } from '../../connector-schemas.js';
import { classifyComposioAction, isAccountReachAction, MONEY_TOOLKITS } from '../action-classes.js';

describe('Composio write hardening', () => {
  it.each(['brex', 'zoho_books', 'freshbooks', 'plaid', 'polymarket'])(
    'keeps every new money app %s outside write levels',
    (toolkit) => {
      expect(classifyComposioAction(toolkit, 'FUTUREAPP_CREATE_ITEM', ['createHint'])).toBe(
        'destructive'
      );
      expect(classifyComposioAction(toolkit, 'FUTUREAPP_LIST_ITEMS', ['readOnlyHint'])).toBe(
        'read'
      );
    }
  );
  it.each(['CAMPAIGN', 'BUDGET', 'BID', 'BOOST', 'CRYPTO', 'WITHDRAW', 'TRADE', 'BUY'])(
    'keeps a new %s money action explicit on a neutral app',
    (name) => {
      expect(classifyComposioAction('futureapp', `FUTUREAPP_CREATE_${name}`, ['createHint'])).toBe(
        'destructive'
      );
    }
  );
  it.each([
    'GitHubCreateAGitHubAppFromAManifest',
    'GitHubUpdateAReference',
    'GitHubDeleteARepository',
    'GoogleDriveUpdateDrive',
    'GitHubUploadReleaseAsset',
  ])('preserves family and exact-list policy across app-name word boundaries: %s', (slug) => {
    expect(
      classifyComposioAction('futureapp', slug, ['createHint'], { writeIncludesDeletes: true })
    ).toBe('destructive');
  });
  it.each(['linear-create-issue', 'LinearCreateIssue', './linear.create.issue/'])(
    'accepts an ordinary normalized write %s',
    (slug) => {
      expect(classifyComposioAction('linear', slug, ['createHint'])).toBe('write');
    }
  );
  it.each(['github_create_webhook', 'GitHubCreateApiKey', 'github-update-a-release-asset'])(
    'matches normalized reach or exact-list spelling %s',
    (slug) => {
      expect(isAccountReachAction(slug)).toBe(true);
    }
  );
  it('pins every verified money toolkit exactly', () => {
    expect([...MONEY_TOOLKITS].sort()).toEqual([
      'adroll',
      'adtraction',
      'adyntel',
      'airwallex',
      'alpaca',
      'altoviz',
      'amazon',
      'apaleo',
      'baselinker',
      'billsby',
      'brex',
      'btcpay_server',
      'cashfree_payments_mcp',
      'check_cherry',
      'clientary',
      'clio_manage',
      'cloudcart',
      'clover',
      'coinbase',
      'coinbase_agents_mcp',
      'coinbase_wallet_mcp',
      'coingecko',
      'coinmarketcal',
      'coinmarketcap',
      'coinranking',
      'commerce_layer',
      'creem',
      'currencyscoop',
      'debitura',
      'ebay',
      'era_context_mcp',
      'facebook',
      'fidel_api',
      'finage',
      'finmei',
      'finmo',
      'flutterwave',
      'fraudlabs_pro',
      'freshbooks',
      'gift_up',
      'gocardless_mcp',
      'goody',
      'google_adsense',
      'google_merchant',
      'googleads',
      'googlesuper',
      'gorgias',
      'gorilladesk',
      'gumroad',
      'harvest',
      'highlevel_location',
      'hitpay',
      'hotspotsystem',
      'jobber',
      'klarna',
      'lemon_squeezy',
      'linkedin_ads',
      'linq',
      'longbridge_mcp',
      'maxio',
      'memberstack',
      'merchantpro',
      'metaads',
      'metronome',
      'microsoft_advertising',
      'mindbody',
      'minerstat',
      'moonclerk',
      'netlicensing',
      'netsuite',
      'open_sea',
      'owl_protocol',
      'paychasers',
      'payhere',
      'payhip',
      'paypal',
      'paystack',
      'pinterest_ads',
      'plaid',
      'plisio',
      'polar',
      'polygon',
      'polygon_io',
      'polymarket',
      'poof',
      'postgrid',
      'printify',
      'quickbooks',
      'quicknode_mcp',
      'ramp',
      'ramp_mcp',
      'razorpay',
      'recurly',
      'reddit_ads',
      'sage_intacct',
      'servicetitan',
      'shipday',
      'shipengine',
      'shippo',
      'shopify',
      'skyfire',
      'smokeball',
      'snapchat',
      'spoki',
      'square',
      'storeganise',
      'strale',
      'stripe',
      'stripe_mcp',
      'surf',
      'tiktok_ads',
      'tipalti',
      'token_metrics',
      'toneden',
      'trackdesk',
      'twelve_data',
      'vibe',
      'wild_apricot',
      'wise',
      'workiz',
      'xero',
      'zernio_mcp',
      'zettle',
      'zip',
      'zoho_books',
      'zoho_invoice',
    ]);
  });

  it.each([...MONEY_TOOLKITS])('keeps every change on %s explicit, preserving reads', (toolkit) => {
    for (const writeIncludesDeletes of [false, true]) {
      for (const tags of [['createHint'], ['updateHint'], ['destructiveHint']]) {
        const classification = classifyComposioAction(
          toolkit.toUpperCase(),
          'FUTUREAPP_CREATE_ITEM',
          tags,
          { writeIncludesDeletes }
        );
        expect(classification).toBe('destructive');
        expect(
          accessLevelRevisionIds(
            [
              {
                toolkit,
                operationSlug: 'FUTUREAPP_CREATE_ITEM',
                operationRevisionId: 'change',
                supported: true,
                capabilityClassification: classification,
              },
            ],
            'read-write'
          )
        ).toEqual([]);
      }
      expect(
        classifyComposioAction(toolkit, 'FUTUREAPP_LIST_ITEMS', ['readOnlyHint'], {
          writeIncludesDeletes,
        })
      ).toBe('read');
    }
  });

  it.each([
    'APIKEY',
    'API_KEY',
    'DEPLOYKEY',
    'GRANT',
    'GUEST',
    'BOT',
    'INSTALL',
    'INTEGRATION',
    'AUTHORIZE',
    'PASSWORD',
    'MFA',
    'SSO',
    'AUTOMATIC_REPLY',
    'REDIRECT',
    'ALIAS',
    'SHARED_LINK',
    'SHARE_LINK',
    'PUBLIC_LINK',
    'EXPORT',
    'DEFAULT_BRANCH',
  ])('keeps the %s reach synonym explicit', (name) => {
    expect(classifyComposioAction('futureapp', `FUTUREAPP_CREATE_${name}`, ['createHint'])).toBe(
      'destructive'
    );
  });

  it.each([
    'GOOGLEADS_UPDATE_BUDGET',
    'METAADS_CREATE_AD',
    'COINBASE_SEND_CRYPTO',
    'COINBASE_WITHDRAW',
    'COINBASE_TRADE',
    'STRIPE_SEND_MONEY',
    'AMAZON_BUY_ITEM',
  ])('keeps money action %s outside levels even on a neutral app', (slug) => {
    const classification = classifyComposioAction('futureapp', slug, ['createHint']);
    expect(classifyComposioAction(slug.split('_')[0]!.toLowerCase(), slug, ['createHint'])).toBe(
      'destructive'
    );
    expect(classification).toBe('destructive');
    expect(
      accessLevelRevisionIds(
        [
          {
            toolkit: 'futureapp',
            operationSlug: slug,
            operationRevisionId: slug,
            supported: true,
            capabilityClassification: classification,
          },
        ],
        'read-write'
      )
    ).toEqual([]);
  });

  it.each([
    'github_create_webhook',
    'GitHubCreateApiKey',
    'github-create-webhook',
    'Slack.InviteUser',
    '创建',
    'CrÉateItem',
    '',
  ])('normalises or refuses %j before matching', (slug) => {
    expect(classifyComposioAction(slug.split('_')[0]!.toLowerCase(), slug, ['createHint'])).toBe(
      'destructive'
    );
  });

  it.each(['创建', 'CrÉateItem', ''])('refuses an unknown read slug %j', (slug) => {
    expect(classifyComposioAction(slug.split('_')[0]!.toLowerCase(), slug, ['readOnlyHint'])).toBe(
      'destructive'
    );
  });

  it.each(['GITHUB_UPLOAD_RELEASE_ASSET', 'GITHUB_UPDATE_A_RELEASE_ASSET'])(
    'keeps release file %s a hand-picked action',
    (slug) => {
      expect(classifyComposioAction(slug.split('_')[0]!.toLowerCase(), slug, ['updateHint'])).toBe(
        'destructive'
      );
    }
  );
});
