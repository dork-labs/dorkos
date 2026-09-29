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
 * The consent sentence for one extension.
 *
 * Nothing about an extension a person has not turned on runs: the server
 * refuses its server half AND withholds its browser half. So the sentence only
 * picks which reach to name — a server entry or data proxy adds "anything on
 * this machine" to "anything you can do in DorkOS".
 *
 * @param runsInServer - Whether the extension has a server half.
 * @returns The sentence to show before a person decides.
 */
export function extensionConsentCopy(runsInServer: boolean): string {
  return runsInServer
    ? 'None of it has run yet. Turning it on lets its code run inside DorkOS, both on this ' +
        'machine, where it can reach anything DorkOS can, and on this page, signed in as you. ' +
        'Turn it on only if you trust where it came from.'
    : 'None of it has run yet. Turning it on lets its code run on this page, signed in as you, ' +
        'so it can do anything you can do in DorkOS. Turn it on only if you trust where it ' +
        'came from.';
}
