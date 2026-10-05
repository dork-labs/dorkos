/**
 * What turning an extension on lets it do, in the person's words (DOR-516).
 *
 * One source for the two places that ask: the extension's card in Settings →
 * Extensions, and the Activity inbox row's ⓘ panel (DOR-2517). A second copy
 * of this sentence would be a consent question worded two ways.
 *
 * @module entities/extension/lib/consent-copy
 */

/**
 * The trust warning both places that ask show under the consent sentence, as
 * its own paragraph.
 */
export const EXTENSION_TRUST_COPY = 'Turn it on only if you trust its source.';

/**
 * The consent sentence for one extension.
 *
 * Nothing about an extension a person has not turned on runs: the server
 * refuses its server half AND withholds its browser half. So the sentence only
 * picks which reach to name — a server entry or data proxy adds "anything
 * DorkOS can" (this computer included) to acting as you on this page. An
 * extension that runs separately (DOR-2686) reaches only what its permission
 * lines list, so for it the sentence claims nothing past "nothing has run"
 * and leaves the reach to those lines. It stays one block of 15 words or
 * fewer, because the inbox renders it as a single paragraph.
 *
 * @param runsInServer - Whether the extension has a server half.
 * @param runsSeparately - Whether that half runs separately, limited to its lists.
 * @returns The sentence to show before a person decides.
 */
export function extensionConsentCopy(runsInServer: boolean, runsSeparately = false): string {
  if (runsSeparately) return 'None of it has run yet.';
  return runsInServer
    ? 'None of it has run yet. Once on, it can reach anything DorkOS can.'
    : 'None of it has run yet. Once on, it can act as you in DorkOS.';
}
