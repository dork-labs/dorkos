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
 * lockout. `marketplace.test.ts` pins that posture, so a later "harden this like
 * `config.ts`" change turns red instead of silently locking the operator out.
 *
 * What separates this from the surface that DOES run the cookie bar is the
 * OPERATOR SURFACE, not the risk level — and the distinction is worth stating
 * plainly, because the tempting version of it is wrong. Standing permissions
 * (DOR-501 phase 2) have no CLI verb at all; they are a cockpit-only affordance, so
 * demanding a cookie there costs an operator nothing they can currently do. Adding
 * a package source has a documented terminal workflow that people actually run, and
 * the only credential that workflow can present is an API key. So the cookie bar is
 * free on one surface and a lockout on the other, and that — not "a source is less
 * dangerous than a standing grant" — is why they differ.
 *
 * ## An unresolved inversion, recorded rather than argued away (DOR-474)
 *
 * The paragraph below says adding a source is strictly MORE consequential than
 * uninstalling a package. After DOR-474 the postures do not line up with that:
 * uninstall carries the cookie bar under login-on (its caller gets an approval
 * card instead of a removal), and adding a source does not. Read as a pair, that
 * is incoherent.
 *
 * It is not a contradiction of the decision below, because that decision does not
 * rest on consequence — it rests on the ABSENCE of an approval path. A caller
 * refused here has nowhere to go; a caller refused at uninstall gets a card a
 * person answers, so nobody is locked out. But the doc and the posture now
 * disagree about which act is graver, and that is worth resolving on purpose
 * rather than leaving for someone to trip over. Filed separately.
 *
 * Do NOT reach for the argument that the neighbouring install and uninstall routes
 * settled this already. They did not settle the same question, and this module's
 * own opening argues the opposite of it: the install gate never asks WHERE a
 * package came from, so adding a source is the strictly MORE consequential act —
 * installing from an attacker's feed requires adding that feed first. "The route
 * next door asks for less" is how a bar erodes, and it is not why this one is set
 * where it is. The CLI lockout above is the argument that carries this decision,
 * and it should be the only one anyone cites from here.
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
