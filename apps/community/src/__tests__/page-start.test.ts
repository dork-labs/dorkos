/**
 * The page's one inline script (DOR-2957): `browser/index.html` carries exactly the text in
 * `headers/link-secret-script.ts`, it is the page's only inline script, and the page policy
 * allows it by the hash of that text and allows no other inline script. Together these stop the
 * copy in the page and the hash in the policy from drifting apart, which would leave a link's
 * secret in the address bar until the bundle loads.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LINK_SECRET_SCRIPT } from '../headers/link-secret-script.js';
import { PAGE_CSP } from '../headers/security-headers.js';

const html = readFileSync(new URL('../browser/index.html', import.meta.url), 'utf8');

describe('the page start script', () => {
  it('is the one inline script the page carries, exactly as the policy hashes it', () => {
    // Purpose: fails when index.html's inline script differs by a character from the hashed
    // text, or when a second inline script appears.
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gu)].map(
      (match) => match[1]
    );
    expect(inline).toEqual([LINK_SECRET_SCRIPT]);
  });

  it('is the only inline script the page policy allows', () => {
    // Purpose: fails when the policy's hash is not the script's own, or when the policy lets
    // inline script in some other way.
    const scriptSrc = PAGE_CSP.split('; ').find((part) => part.startsWith('script-src '));
    const hash = createHash('sha256').update(LINK_SECRET_SCRIPT).digest('base64');
    expect(scriptSrc).toBe(`script-src 'self' 'sha256-${hash}'`);
  });
});
