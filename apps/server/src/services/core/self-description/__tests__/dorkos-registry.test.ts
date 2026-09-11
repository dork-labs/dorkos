/**
 * The docs composer says EVERY domain; this is what makes that true.
 *
 * `composeCapabilityRegistryForDocs` carries a hand-written domain list, while
 * `composeDorkOsCapabilityRegistry` derives its list from whichever service
 * handles boot supplied. The two drifted once already: #1635 added
 * `connectorExecutionDomain` to the boot composer and not to the docs one, and
 * because every capability in that domain declares `surfaces: {}` no projected
 * output changed — no route appeared or vanished, no tool list moved — so
 * nothing went red for two weeks. The only thing that shifted was the id space
 * the docs registry can see, which is what `routes/shapes.ts` reserves against
 * and what the MCP tier lookup reads.
 *
 * So the pin is against the boot composer with EVERY domain enabled, rather
 * than against a second hand-written list that would drift in its own right.
 */
import { describe, expect, it } from 'vitest';
import { noopLogger } from '@dorkos/shared/logger';
import { connectorExecutionDomain } from '../../../connectors/execution/execution-capabilities.js';
import type { CapabilityDeps } from '../../capabilities/index.js';
import {
  composeCapabilityRegistryForDocs,
  composeDorkOsCapabilityRegistry,
} from '../dorkos-registry.js';

/**
 * A dependency bag that answers "yes, present" to every handle a domain gate
 * could ask for, including handles that do not exist yet.
 *
 * A plain object listing today's six `*Deps` keys would defeat the purpose: a
 * new domain gated on a new key would simply not be composed here, the two id
 * sets would match, and the drift this file exists to catch would pass. The
 * proxy has no such list — any property read that is not on the base returns a
 * truthy placeholder, so a domain added to the boot composer is composed here
 * the moment it lands. Nothing is ever invoked: every `assertDeps` in the
 * codebase is a presence check, and this registry is only ever read for
 * metadata.
 */
function allDepsPresent(): CapabilityDeps {
  const base: Record<string | symbol, unknown> = { logger: noopLogger };
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol') return undefined;
      return {};
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  }) as unknown as CapabilityDeps;
}

describe('composeCapabilityRegistryForDocs', () => {
  it('composes exactly the domains a fully-wired boot composes', () => {
    const docs = composeCapabilityRegistryForDocs().capabilities.map((c) => c.id);
    const boot = composeDorkOsCapabilityRegistry(allDepsPresent()).capabilities.map((c) => c.id);

    // Guard the guard: a composer that returned nothing would satisfy an
    // equality of two empty sets.
    expect(boot.length).toBeGreaterThan(0);
    expect([...docs].sort()).toEqual([...boot].sort());
  });

  it('includes the connector execution capabilities, which declare no surface at all', () => {
    // Named explicitly because they are the ones that went missing, and because
    // they are invisible to every other check: no `http`, no `mcp`, no `cli`, so
    // only an assertion about the id space can see whether they are here. The
    // authenticated connector loopback registers these ids directly rather than
    // through a declared surface.
    const docs = composeCapabilityRegistryForDocs();

    for (const id of [
      'connectors.list_granted_connections',
      'connectors.list_granted_operations',
      'connectors.request_connection',
      'connectors.get_connection_request',
      'connectors.execute_read',
      'connectors.execute_write',
      'connectors.execute_destructive',
    ]) {
      expect(docs.get(id), `${id} is absent from the docs projection`).toBeDefined();
    }
  });

  it('adds no HTTP route and no MCP tool by including them', () => {
    // The reason the gap was invisible, asserted rather than assumed: the docs
    // registry's projected surfaces are unchanged by that domain, so the OpenAPI
    // document and every tool list stay exactly as they were. This is also what
    // keeps the docs/boot HTTP-parity check in `capabilityConformance` green.
    const subjectIds = new Set(connectorExecutionDomain.capabilities.map((c) => c.id));
    const subject = composeCapabilityRegistryForDocs().capabilities.filter((c) =>
      subjectIds.has(c.id)
    );

    // Count the subjects BEFORE judging them. Drop the domain and this filter is
    // empty, and an empty set satisfies "none of them is surfaced" without
    // looking at anything — the assertion below would stay green for the very
    // regression it exists to catch. The expected count comes from the domain's
    // own capability list, so it cannot fall out of date.
    expect(subject).toHaveLength(connectorExecutionDomain.capabilities.length);
    expect(
      subject.filter((c) => c.surfaces.http !== undefined || c.surfaces.mcp !== undefined)
    ).toEqual([]);
  });
});
