import { describe, expect, it } from 'vitest';
import type { RequestFacts } from '../../http/request-facts.js';
import { NOT_FROM_WIFI } from '../../services/core/auth/sessions/wifi-level.js';
import { WIFI_RAISE_REFUSAL } from '../../services/core/auth/sessions/wifi-raise-guard.js';
import { wifiScheduleRefusal } from '../task-wifi-guard.js';

const WIFI_CALLER: RequestFacts = {
  headers: { host: '192.168.1.20:4243' },
  peerAddress: '192.168.1.31',
  forwardedAddress: '192.168.1.31',
  connectionEncrypted: false,
  ingress: 'wifi',
  user: undefined,
  agentIdentity: undefined,
  method: 'PATCH',
};

describe('wifiScheduleRefusal', () => {
  it('refuses applied task rules but allows an empty rule list on a Default schedule', () => {
    const existing = { permissionMode: 'default' as const, runtime: 'claude-code' };

    expect(
      wifiScheduleRefusal(WIFI_CALLER, { approvedAllow: ['Bash(ls /tmp)'] }, existing)
    ).toEqual({ error: WIFI_RAISE_REFUSAL, code: NOT_FROM_WIFI });
    expect(wifiScheduleRefusal(WIFI_CALLER, { approvedAllow: [] }, existing)).toBeUndefined();
  });
});
