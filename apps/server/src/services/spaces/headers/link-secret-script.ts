/**
 * The page's one inline script (DOR-2957): it takes a link's secret out of the address bar while
 * the page is still parsing, before the bundle has even started to load. A mailed link, an
 * invitation and an owner's claim carry their secret after `#`; this keeps the fragment in page
 * memory only (`window.__dorkosLinkFragment`, read once by `browser/page-start/read-link-secret.ts`)
 * and replaces the address with the same one without it.
 *
 * `browser/index.html` carries exactly this text, which `page-start.test.ts` checks, and the page
 * policy allows exactly this script by its hash (`PAGE_CSP`). Changing a character here changes
 * the hash with it; a copy in `index.html` that drifts is refused by the browser.
 */
export const LINK_SECRET_SCRIPT =
  "(function(){var h=location.hash;if(h.length<2)return;Object.defineProperty(window,'__dorkosLinkFragment',{value:h.slice(1),configurable:true});history.replaceState(null,'',location.pathname+location.search)})()";
