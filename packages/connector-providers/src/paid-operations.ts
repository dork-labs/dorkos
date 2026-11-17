/**
 * Operations that spend money (DOR-4204): a mark beside the read, write and
 * destructive class, because a service's own "read-only" label says nothing
 * about who pays. An Apify scrape is read-only to Apify and still bills the
 * account owner. No access level covers a paid operation, it is never shared
 * with every agent or handed on by another agent, and it runs only for an
 * agent a person gave it to on its own.
 *
 * @module connector-providers/paid-operations
 */
import type { ConnectorReconciliationCandidate } from './connector-schemas.js';

/**
 * Composio toolkits whose operations spend money unless Security reviewed an
 * exception: services that bill per call, per credit or per minute (DOR-4597).
 * Names are Composio's toolkit slugs exactly, because a misspelt one reads as
 * free. Each group was found by searching Composio's catalog for the terms its
 * comment names (2026-11-17); a new entry is copied from the catalog and added
 * to `__tests__/fixtures/composio-paid-toolkits.json` too. The last group is
 * the one exception: older names Composio doesn't use, kept to fail toward paid.
 */
export const PAID_BY_DEFAULT_TOOLKITS: ReadonlySet<string> = new Set([
  // Scraping, crawling and hosted browsers ("scraping", "scraper", "crawl", "proxy").
  'apify',
  'apify_mcp',
  'brightdata',
  'browserbase_mcp',
  'browserbase_tool',
  'browserless',
  'capturekit',
  'crawl4ai',
  'crawlbase',
  'diffbot',
  'firecrawl',
  'geekflare',
  'olostep',
  'piloterr',
  'scrape_do',
  'scrapecreators',
  'scrapegraph_ai',
  'scrapfly',
  'scrapingant',
  'scrapingbee',
  'scrapingdog',
  'smartproxy',
  'spider',
  'tik_hub',
  'webcrawlerapi',
  'webscraping_ai',
  'zenrows',
  'zyte_api',
  // AI model APIs: text, images, video and 3D ("LLM", "AI model", "inference",
  // "image generation", "video generation", "avatar").
  'ai_ml_api',
  'apiframe',
  'apipie_ai',
  'beatapi',
  'bfl',
  'byte_plus_ark',
  'captions',
  'cohere',
  'cometapi',
  'deepimage',
  'deepseek',
  'dreamstudio',
  'eden_ai',
  'fal_ai',
  'fireworks_ai',
  'gemini',
  'grok',
  'groqcloud',
  'heygen',
  'higgsfield',
  'higgsfield_mcp',
  'imagerouter',
  'jigsawstack',
  'jogg_ai',
  'kieai',
  'llm_api',
  'luma_labs',
  'magic_hour',
  'meshy',
  'minimax',
  'mistral_ai',
  'muapi',
  'openai',
  'openrouter',
  'perplexityai',
  'photoroom',
  'recraft',
  'replicate',
  'runway',
  'slazzer',
  'studio_by_ai21_labs',
  'tripo3d',
  'vast_ai',
  'veo',
  'vercel_ai_gateway',
  'writer',
  // Speech, transcription, voice agents and meeting bots ("text-to-speech",
  // "speech-to-text", "transcription", "voice call").
  'assemblyai',
  'bland_ai',
  'camb_ai',
  'cartesia',
  'castingwords',
  'deepgram',
  'elevenlabs',
  'fish_audio',
  'gan_ai',
  'gladia',
  'happy_scribe',
  'inworld_ai',
  'recallai',
  'retellai',
  'rev',
  'rev_ai',
  'speechmatics',
  'supadata',
  'synthflow_ai',
  // SMS and phone ("SMS", "text message", "phone call").
  'clicksend',
  'dialmycalls',
  'labsmobile',
  'mocean',
  'msg91',
  'plivo',
  'saperly',
  'saperly_mcp',
  'seven_io',
  'sms_alert',
  'telnyx',
  'twilio',
  // Search results ("search API", "SERP").
  'autom',
  'brave_search',
  'countdown_api',
  'dataforseo',
  'exa',
  'openperplex',
  'openweb_ninja',
  'parallel_task_mcp',
  'search1api',
  'search_api',
  'serpapi',
  'serpdog',
  'serper',
  'serphouse',
  'serply',
  'tavily',
  'tavily_mcp',
  'valyu',
  'zenserp',
  // People and company data ("enrichment", "lead data").
  'apollo',
  'bettercontact',
  'clay',
  'clay_mcp',
  'companyenrich',
  'contactout',
  'dropcontact',
  'enrich_layer',
  'explorium',
  'findymail',
  'fullenrich',
  'getprospect',
  'hunter',
  'icypeas',
  'interzoid',
  'interzoid_mcp',
  'leadmagic',
  'lusha',
  'peopledatalabs',
  'prospeo',
  'thecompaniesapi',
  'trestle',
  'wiza',
  // Email address checks ("email verification").
  'bouncer',
  'bouncify',
  'bulk_email_checker',
  'debounce',
  'easy_email_verification',
  'emailable',
  'emaillistverify',
  'invalid_bounce',
  'kickbox',
  'listclean',
  'mailboxlayer',
  'mailcheck',
  'mailercheck',
  'mailfloss',
  'neverbounce',
  'purechecker',
  'verifiedemail',
  // Credit or plan-metered, pricing unclear (DOR-4597): found by the same searches,
  // marked paid on Security's call, since a free toolkit marked paid fails closed.
  'agenty',
  'ai_ark',
  'aivoov',
  'all_images_ai',
  'allmodels',
  'anakin_io',
  'blitz_api',
  'browseract',
  'ceramic',
  'cloro',
  'context_dev',
  'dropleads',
  'elai',
  'enrich',
  'fiber',
  'firmable',
  'get_transcribe',
  'gradium',
  'hystruct',
  'keenable',
  'kitt',
  'leadiq',
  'leadsforge',
  'limadata',
  'minelead',
  'moltsets',
  'mrscraper',
  'ngram',
  'ocean_io',
  'onepage',
  'parse_bot',
  'parsehub',
  'parsera',
  'phantombuster',
  'ploid',
  'quickenrich',
  'signalbase',
  'simplescraper_mcp',
  'sixtyfour',
  'smtping',
  'sumble',
  'teltel',
  'textcortex',
  'tinyfish',
  'verifi_email',
  'webscraper_io',
  'zoominfo',
  // Not in the Composio catalog today; kept so a matching name never reads as free.
  'anthropic',
  'browserbase',
  'clearbit',
  'messagebird',
  'stabilityai',
  'vonage',
]);

/** Operations reviewed as free inside paid-by-default toolkits. Additions need Security review. */
export const REVIEWED_FREE_OPERATIONS: ReadonlySet<string> = new Set();

/**
 * Operations that spend money inside otherwise free toolkits (DOR-4460), by
 * toolkit and slug pattern. GitHub Models calls bill the account owner, and
 * Composio tags them `readOnlyHint`. A pattern, so a model call Composio adds
 * later is paid from its first catalog read; listing the model catalog runs
 * no model and stays free.
 */
export const PAID_OPERATION_PATTERNS: ReadonlyMap<string, RegExp> = new Map([
  ['github', /^GITHUB_\w*INFERENCE/],
]);

/**
 * Whether an operation spends money: every operation of a pay-per-use service,
 * unless Security reviewed it as free, and the paid operations of a free one.
 *
 * @param op - The service (toolkit) and operation, as the provider names them.
 */
export function isPaidOperation(op: { toolkit: string; operationSlug: string }): boolean {
  const toolkit = op.toolkit.toLowerCase();
  const slug = op.operationSlug.toUpperCase();
  if (PAID_OPERATION_PATTERNS.get(toolkit)?.test(slug)) return true;
  return PAID_BY_DEFAULT_TOOLKITS.has(toolkit) && !REVIEWED_FREE_OPERATIONS.has(slug);
}

/** What an access level reads of one operation: its class, and whether it spends money. */
export type AccessLevelCandidate = Pick<
  ConnectorReconciliationCandidate,
  'operationRevisionId' | 'toolkit' | 'operationSlug' | 'capabilityClassification' | 'supported'
>;
