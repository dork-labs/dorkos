import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ingressOf,
  isManagedIngress,
  markIngress,
  noteGateAdmitted,
  setManagedAdmissionListener,
  type IngressKind,
} from '../ingress-mark.js';

function fakeRequest(): IncomingMessage {
  return {} as IncomingMessage;
}

describe('ingress marks', () => {
  // Purpose: each listener's mark reads back as itself, and an unmarked
  // request is the main listener's.
  it('reads back each mark, and direct for none', () => {
    const kinds: IngressKind[] = ['managed', 'own-tunnel', 'wifi', 'relay'];
    for (const kind of kinds) {
      const req = fakeRequest();
      markIngress(req, kind);
      expect(ingressOf(req)).toBe(kind);
    }
    expect(ingressOf(fakeRequest())).toBe('direct');
  });

  // Purpose: managed-only questions (the managed host guard, the managed
  // activity count) must not start counting own-tunnel or Wi-Fi traffic.
  it('answers the managed questions for managed requests only', () => {
    const listener = vi.fn();
    setManagedAdmissionListener(listener);
    try {
      for (const kind of ['own-tunnel', 'wifi', 'relay'] as const) {
        const req = fakeRequest();
        markIngress(req, kind);
        expect(isManagedIngress(req)).toBe(false);
        noteGateAdmitted(req, {} as ServerResponse);
      }
      expect(listener).not.toHaveBeenCalled();

      const managed = fakeRequest();
      markIngress(managed, 'managed');
      expect(isManagedIngress(managed)).toBe(true);
      noteGateAdmitted(managed, {} as ServerResponse);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      setManagedAdmissionListener(null);
    }
  });
});
