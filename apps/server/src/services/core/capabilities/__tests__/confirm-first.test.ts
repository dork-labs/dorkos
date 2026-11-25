/**
 * The registry's half of a confirm-first hold (ADR 261125-114705, decision 4):
 * no call runs a held input without the confirmation the HTTP mount mints once
 * the person's step-up passed, not even the most trusted in-process caller,
 * and a confirmation runs one call of one capability with one input, once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noopLogger } from '@dorkos/shared/logger';

import {
  ConfirmFirstRequired,
  composeRegistry,
  personCaller,
  personConfirmed,
  trustedCaller,
} from '../index.js';
import { heartbeatDomain } from '../../../heartbeats/heartbeat-capabilities.js';
import { setTriageCreditsChoiceStore } from '../../../heartbeats/triage/triage-credits-capability.js';

const ID = 'heartbeat.choose_triage_credits';
const setChoice = vi.fn();
const registry = composeRegistry([heartbeatDomain], { logger: noopLogger });

/** A person at the app with login off: the most any in-process caller can carry. */
function asPerson() {
  const request = {
    agentIdentityPresented: false,
    approvalTokenPresented: false,
    loginEnabled: () => false,
  };
  return {
    trusted: trustedCaller(request)!,
    person: personCaller({ ...request, authorizationPresented: false })!,
  };
}

beforeEach(() => {
  setChoice.mockClear();
  setTriageCreditsChoiceStore({ choice: () => null, setChoice, record: vi.fn() });
});
afterEach(() => setTriageCreditsChoiceStore(undefined));

describe('a confirm-first call', () => {
  it('is refused without a confirmation, whoever calls, and nothing runs', async () => {
    await expect(registry.invoke(ID, { useCredits: true }, asPerson())).rejects.toBeInstanceOf(
      ConfirmFirstRequired
    );
    // Something that only looks like a confirmation is none.
    await expect(
      registry.invoke(ID, { useCredits: true }, { ...asPerson(), confirmed: { used: false } })
    ).rejects.toBeInstanceOf(ConfirmFirstRequired);
    expect(setChoice).not.toHaveBeenCalled();
  });

  it('runs at once when its declaration does not hold that input', async () => {
    await expect(registry.invoke(ID, { useCredits: false }, asPerson())).resolves.toEqual({
      useCredits: false,
    });
    expect(setChoice).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('runs once with a confirmation for this capability and this input, and never again', async () => {
    const confirmed = personConfirmed(ID, { useCredits: true });
    await expect(
      registry.invoke(ID, { useCredits: true }, { ...asPerson(), confirmed })
    ).resolves.toEqual({ useCredits: true });
    await expect(
      registry.invoke(ID, { useCredits: true }, { ...asPerson(), confirmed })
    ).rejects.toBeInstanceOf(ConfirmFirstRequired);
    expect(setChoice).toHaveBeenCalledOnce();
  });

  it('refuses a confirmation made for another input of the same capability', async () => {
    const confirmed = personConfirmed(ID, { useCredits: false });
    await expect(
      registry.invoke(ID, { useCredits: true }, { ...asPerson(), confirmed })
    ).rejects.toBeInstanceOf(ConfirmFirstRequired);
    expect(setChoice).not.toHaveBeenCalled();
  });

  it('refuses a confirmation made for another capability', async () => {
    const confirmed = personConfirmed('heartbeat.something_else', { useCredits: true });
    await expect(
      registry.invoke(ID, { useCredits: true }, { ...asPerson(), confirmed })
    ).rejects.toBeInstanceOf(ConfirmFirstRequired);
    expect(setChoice).not.toHaveBeenCalled();
  });
});
