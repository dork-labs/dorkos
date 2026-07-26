/**
 * The refusal behind `POST /api/marketplace/sources` and
 * `DELETE /api/marketplace/sources/:name`: an agent may not change WHICH package
 * feeds this install reads from. Only the operator may (DOR-502).
 *
 * ## Why this effect needed a guard at all
 *
 * Installing a package is gated: `marketplace.install` runs the tier gate, and
 * `marketplace.uninstall` is `destructive` and waits for a person. But the list of
 * SOURCES those installs read from was ungated for every caller, so an agent could
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
 * ## One bar, not two — and why the `PATCH /api/config` cookie bar is NOT copied
 *
 * `routes/config.ts` runs TWO bars on its operator-only paths: an agent bar
 * (`trustedCaller`) and, under login-on, a cookie bar
 * (`requireOperatorCookieUnderLogin`) that refuses a caller holding a per-user API
 * key. This route runs the agent bar only, and that difference is chosen rather
 * than overlooked.
 *
 * `dorkos marketplace add|remove` is a first-class OPERATOR verb, and the CLI has
 * no cookie — it authenticates with a personal API key by design
 * (`packages/cli/src/lib/api-client.ts`). A cookie bar here would refuse the person
 * at their own terminal on any login-on instance, which is not a hardening, it is a
 * lockout. The neighbouring marketplace mutation routes already settled this the
 * same way: `POST /packages/:name/install|uninstall` clear their gate on
 * `trustedCaller` alone, so a key-holding caller can already install and uninstall
 * on this router. Requiring MORE proof to add a source than to install from one
 * would protect nothing.
 *
 * **The residual, stated plainly:** with `Require login` off — the default — a
 * program on this machine that omits its agent header is indistinguishable from the
 * person in the cockpit, so it can still add a source. That is the same residual
 * `routes/config.ts` documents for its agent bar and the same one
 * `docs/guides/action-approvals.mdx` describes for `dorkos uninstall`. What this
 * guard DOES close, in every posture, is the agent that follows its instructions
 * and carries `DORKOS_AGENT_TOKEN` — the prompt-injected agent this feature exists
 * to stop.
 *
 * @module services/marketplace/source-write-policy
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
  const command =
    action === 'add'
      ? 'dorkos marketplace add <url> --name <name>'
      : 'dorkos marketplace remove <name>';
  return (
    `DorkOS ${verb} nothing. A package source is a feed this install will fetch and run code from, ` +
    `so which feeds it reads is the person's to choose, not yours. Ask them to run \`${command}\` ` +
    `themselves, or to change it on the Marketplace sources screen in DorkOS. Retrying will not ` +
    `help and there is no approval that unlocks this. You can still list, refresh, and validate ` +
    `sources, and install from the sources they already added.`
  );
}
