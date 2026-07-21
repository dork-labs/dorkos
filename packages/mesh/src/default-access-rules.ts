/**
 * Single source of truth for the default Relay access rules a mesh namespace
 * gets on every agent registration.
 *
 * {@link RelayBridge.registerAgent} writes these to Relay (the enforcer);
 * {@link TopologyManager.defaultAccessRules} surfaces them in the topology
 * view. Both read from {@link defaultAccessRuleSpecs} so the write side and
 * the read side can never drift apart again.
 *
 * @module mesh/default-access-rules
 */

/** Priority for same-namespace allow rules. */
export const SAME_NAMESPACE_ALLOW_PRIORITY = 100;

/** Priority for cross-namespace deny rules. */
export const CROSS_NAMESPACE_DENY_PRIORITY = 10;

/**
 * Priority for system-agent allow rules — above the same-namespace allow so a
 * system agent (DorkBot) is reachable from, and can reach, every namespace
 * despite the default cross-namespace deny.
 */
export const SYSTEM_AGENT_ALLOW_PRIORITY = 200;

/**
 * Sentinel namespace meaning "every other namespace" — used in place of a
 * single-pair `sourceNamespace`/`targetNamespace` for the catch-all and
 * system-agent bridge rules, which match `relay.agent.>` (every namespace),
 * not one specific namespace.
 */
export const CATCH_ALL_NAMESPACE = '*';

/**
 * One default access-rule write, in both forms a consumer needs: the Relay
 * subject pattern actually written (`from`/`to`/`action`/`priority`) and the
 * namespace-level description for display (`sourceNamespace`/`targetNamespace`,
 * using {@link CATCH_ALL_NAMESPACE} where the rule isn't a single pair).
 */
export interface DefaultAccessRuleSpec {
  /** Relay subject pattern the rule matches messages FROM. */
  from: string;
  /** Relay subject pattern the rule matches messages TO. */
  to: string;
  action: 'allow' | 'deny';
  priority: number;
  /** Namespace-level source; {@link CATCH_ALL_NAMESPACE} for "every namespace". */
  sourceNamespace: string;
  /** Namespace-level target; {@link CATCH_ALL_NAMESPACE} for "every namespace". */
  targetNamespace: string;
}

/**
 * The default access-rule writes for one namespace's agent registration.
 *
 * Every namespace gets a same-namespace allow and a catch-all cross-namespace
 * deny. A namespace containing a system agent (`isSystem`, e.g. DorkBot) also
 * gets a bidirectional allow at {@link SYSTEM_AGENT_ALLOW_PRIORITY} — above the
 * catch-all deny — since system agents run background tasks and onboarding
 * across every project namespace and would otherwise be cut off by their own
 * namespace's deny rule.
 *
 * The bidirectional allow shares its exact `from`/`to` pattern with the
 * catch-all deny in the forward direction (`{ns}.* -> agent.>`): Relay
 * evaluates rules highest-priority-first and the first pattern match wins, so
 * that deny is entirely shadowed for a system namespace — it's written (for
 * write-order parity with non-system namespaces) but never actually enforced.
 *
 * @param namespace - The namespace these rules apply to
 * @param isSystem - Whether the namespace contains a system agent (`isSystem: true`)
 */
export function defaultAccessRuleSpecs(
  namespace: string,
  isSystem: boolean
): DefaultAccessRuleSpec[] {
  const specs: DefaultAccessRuleSpec[] = [
    {
      from: `relay.agent.${namespace}.*`,
      to: `relay.agent.${namespace}.*`,
      action: 'allow',
      priority: SAME_NAMESPACE_ALLOW_PRIORITY,
      sourceNamespace: namespace,
      targetNamespace: namespace,
    },
    {
      from: `relay.agent.${namespace}.*`,
      to: 'relay.agent.>',
      action: 'deny',
      priority: CROSS_NAMESPACE_DENY_PRIORITY,
      sourceNamespace: namespace,
      targetNamespace: CATCH_ALL_NAMESPACE,
    },
  ];

  if (isSystem) {
    specs.push(
      {
        from: `relay.agent.${namespace}.*`,
        to: 'relay.agent.>',
        action: 'allow',
        priority: SYSTEM_AGENT_ALLOW_PRIORITY,
        sourceNamespace: namespace,
        targetNamespace: CATCH_ALL_NAMESPACE,
      },
      {
        from: 'relay.agent.>',
        to: `relay.agent.${namespace}.*`,
        action: 'allow',
        priority: SYSTEM_AGENT_ALLOW_PRIORITY,
        sourceNamespace: CATCH_ALL_NAMESPACE,
        targetNamespace: namespace,
      }
    );
  }

  return specs;
}
