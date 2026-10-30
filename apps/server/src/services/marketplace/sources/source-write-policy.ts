/**
 * The refusal behind `POST /api/marketplace/sources` and
 * `DELETE /api/marketplace/sources/:name`: an agent may not change WHICH package
 * feeds this install reads from. Only the operator may (DOR-502).
 *
 * ## Why this effect needed a guard at all
 *
 * Installing a package is gated: `marketplace.install` runs the tier gate (at tier
 * `act`, so it passes for every caller today, but the route answers to whatever
 * tier that capability declares), and `marketplace.uninstall` is `destructive`, so
 * an untrusted caller gets an approval card instead of an uninstall. But the list
 * of SOURCES those installs read from was ungated for every caller, so an agent could
 * point this instance at a feed somebody else controls and then install from it
 * through the gate, which sees a legitimate install of a legitimately-listed
 * package. The install gate never asks where the package came from, so the source
 * list is the only place that question can be asked.
 *
 * This is the DOR-467 defect class one level down: an agent-reachable route
 * reaching a consequential effect while its neighbours honor enforcement.
 *
 * ## Refuse, rather than authorize against a capability
 *
 * Three shapes were weighed. Two are deliberately NOT what this is:
 *
 * 1. **A new `marketplace.source_add` / `marketplace.source_remove` capability.**
 *    It would put the decision behind an approval card, which means an agent could
 *    still get there by asking. But `CONFIG_WRITE_POLICY` already settled the
 *    analogous question for `tunnel.*`, `mcp.*`, and `providers`: WHERE this
 *    instance reaches, and which credentials go there, is operator-only, refused
 *    outright rather than routed through a card. A package feed is the same kind of
 *    fact — the set of hosts DorkOS will fetch executable content from — so it gets
 *    the same answer. Adding a capability also moves the registry count that four
 *    documented surfaces assert, for a weaker guarantee.
 * 2. **Authorizing as `marketplace.install`.** It would gate the route with no new
 *    capability, but the audit trail would then record an install that never
 *    happened, on a capability whose schema does not describe this call. A false
 *    capability id in the Activity feed is worse than the gap it closes.
 *
 * So the answer is the smallest true one: adding or removing a source is the
 * person's, and an agent is told so plainly.
 *
 * ## A key is a program (DOR-3330)
 *
 * This route used to run the agent bar only, so `dorkos marketplace add`,
 * which presents a personal API key, counted as the person. Since DOR-3330 a
 * key is a program, never the person: once an owner exists, only their
 * browser session changes a source, and a program, the CLI included, is told
 * exactly where in the app to do it (`marketplaceSourceNeedsApp`). With no
 * owner yet, the agent bar alone decides, as before. A CLI sign-in is DOR-3342.
 *
 * The agent bar still answers anything that names itself an agent, in every
 * posture, with the refusal written for a model below.
 *
 * @module services/marketplace/sources/source-write-policy
 */

/** Which package-source write a caller attempted, for the refusal wording. */
export type MarketplaceSourceAction = 'add' | 'remove';

/** The machine-readable code every package-source refusal carries. */
export const OPERATOR_ONLY_MARKETPLACE_SOURCE_CODE = 'operator_only_marketplace_source';

/**
 * The one-line `error` field a refusal carries — the sentence a person reads in
 * the cockpit or in CLI output.
 *
 * @param action - Which write was attempted.
 * @returns One plain sentence naming who may do it.
 */
export function marketplaceSourceRefusalError(action: MarketplaceSourceAction): string {
  return `Only the person running DorkOS can ${action} a package source`;
}

/**
 * The refusal an agent reads. Says what did not happen, why the person owns this
 * decision, and exactly what to ask them for — because this text lands in a
 * model's context, and a model that is only told "no" will try again.
 *
 * @param action - Which write was attempted.
 * @returns One paragraph written for the model.
 */
export function describeMarketplaceSourceRefusal(action: MarketplaceSourceAction): string {
  const verb = action === 'add' ? 'added' : 'removed';
  return (
    `DorkOS ${verb} nothing. A package source is a feed this install will fetch and run code from, ` +
    `so which feeds it reads is the person's to choose, not yours. Ask them to change it on the ` +
    `Marketplace sources page in the DorkOS app. Retrying will not ` +
    `help and there is no approval that unlocks this. You can still list, refresh, and validate ` +
    `sources, and install from the sources they already added.`
  );
}

/** The code a package-source write answers a program or a caller with no session (DOR-3330). */
export const MARKETPLACE_SOURCE_NEEDS_APP_CODE = 'marketplace_source_needs_app';

/**
 * What a program, or the person with no session, reads when a package-source
 * write needs them signed in (DOR-3330): what it needs and exactly where in
 * the app to do it instead. The CLI prints it as it is.
 *
 * @param action - Which write was attempted.
 */
export function marketplaceSourceNeedsApp(action: MarketplaceSourceAction): string {
  return action === 'add'
    ? 'Adding a marketplace needs you signed in. In the DorkOS app, open Marketplace sources and click Add marketplace source.'
    : 'Removing a marketplace needs you signed in. In the DorkOS app, open Marketplace sources and remove it there.';
}
