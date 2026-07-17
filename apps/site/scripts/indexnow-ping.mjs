// IndexNow ping: submits the site's URLs to IndexNow so Bing and Yandex learn
// about changes quickly (Google ignores IndexNow, so this is for those engines).
//
// Reads the production sitemap, extracts every URL, and POSTs them in one batch
// to https://api.indexnow.org/indexnow with the host verification key.
//
// Run it manually or from CI after a deploy; it is deliberately NOT wired into
// the build. Verify the parse without hitting the network with `--dry-run`.
//
//   node scripts/indexnow-ping.mjs
//   node scripts/indexnow-ping.mjs --dry-run

/** IndexNow host verification key. Must match `public/<KEY>.txt`. */
const KEY = '37ca4bebf55689646a110a64ab0100c5';

const HOST = 'dorkos.ai';
const SITEMAP_URL = `https://${HOST}/sitemap.xml`;
const KEY_LOCATION = `https://${HOST}/${KEY}.txt`;
const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';

const dryRun = process.argv.includes('--dry-run');

/**
 * Fetch the production sitemap and return every `<loc>` URL it contains.
 *
 * @returns The list of absolute URLs from the sitemap.
 */
async function readSitemapUrls() {
  const res = await fetch(SITEMAP_URL, { headers: { accept: 'application/xml' } });
  if (!res.ok) {
    throw new Error(`Failed to fetch sitemap (${res.status} ${res.statusText}): ${SITEMAP_URL}`);
  }
  const xml = await res.text();
  const urls = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((match) => match[1]);
  if (urls.length === 0) {
    throw new Error('Sitemap contained no <loc> URLs');
  }
  return urls;
}

/**
 * Submit a batch of URLs to IndexNow.
 *
 * @param urlList - Absolute URLs to submit; all must be on {@link HOST}.
 */
async function submit(urlList) {
  const body = { host: HOST, key: KEY, keyLocation: KEY_LOCATION, urlList };
  const res = await fetch(INDEXNOW_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  // IndexNow returns 200 or 202 on success.
  if (!res.ok) {
    throw new Error(`IndexNow rejected the submission (${res.status} ${res.statusText})`);
  }
  return res.status;
}

async function main() {
  const urls = await readSitemapUrls();
  console.log(`Found ${urls.length} URL(s) in ${SITEMAP_URL}`);
  for (const url of urls) console.log(`  ${url}`);

  if (dryRun) {
    console.log('\n--dry-run: not submitting to IndexNow.');
    return;
  }

  const status = await submit(urls);
  console.log(`\nSubmitted ${urls.length} URL(s) to IndexNow (HTTP ${status}).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
