/** Compatibility string entry; unsupported markup/CSP remains byte-for-byte unchanged. */
import { injectFrameScripts } from './frame-inject.js';
export { DEVTOOLS_AGENT_SCRIPT } from './devtools-shim.js';

/** Delegate to the single conservative insertion decision for both fixed SDKs. */
export function injectDevtoolsScript(
  html: string,
  enforcingPolicies: readonly string[] = []
): string {
  return injectFrameScripts(Buffer.from(html, 'utf8'), {
    contentType: 'text/html; charset=utf-8',
    enforcingPolicies,
  }).bytes.toString('utf8');
}
