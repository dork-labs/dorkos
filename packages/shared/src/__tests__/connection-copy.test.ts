import { describe, expect, it } from 'vitest';
import {
  CONNECTION_STATUS_LABELS,
  KEY_CHECK_COPY,
  OPERATION_CLASSIFICATION_LABELS,
  connectionAccessWords,
  connectionServiceName,
  connectionUsageLine,
  connectionWayName,
} from '../connector-schemas.js';

describe('connectionUsageLine — who pays, only where someone does', () => {
  it.each([
    ['DorkOS account', 'dorkos_managed', 'managed', 'Your DorkOS account covers its use.'],
    [
      'own Composio key',
      'operator_byo',
      'managed',
      'Any usage charges go to your own Composio account.',
    ],
    ['own Nango server', 'operator_byo', 'self-host', null],
    ['the app’s own MCP server', 'operator_byo', 'external', null],
  ] as const)('%s', (_way, payer, custody, line) => {
    expect(connectionUsageLine({ payer, custody })).toBe(line);
  });
});

describe('connectionWayName and connectionServiceName', () => {
  it.each([
    ['dorkos-managed', 'Your DorkOS account', 'DorkOS'],
    ['composio', 'Your Composio key', 'Composio'],
    ['nango', 'Your Nango server', 'Nango'],
    ['mcp', 'The app’s own MCP server', 'MCP'],
    ['acme', 'Your Acme key', 'Acme'],
  ])('%s', (type, way, service) => {
    expect(connectionWayName(type)).toBe(way);
    expect(connectionServiceName(type)).toBe(service);
  });
});

describe('labels shown in place of stored values', () => {
  it('names action kinds without promising what a destructive action does', () => {
    expect(OPERATION_CLASSIFICATION_LABELS).toEqual({
      read: 'Read',
      write: 'Write',
      // The service marks sending and sharing destructive too, so never "Delete".
      destructive: 'High risk',
    });
  });

  it('names sign-in states in plain words', () => {
    expect(CONNECTION_STATUS_LABELS).toEqual({
      active: 'Connected',
      expired: 'Signed out',
      revoked: 'Disconnected',
      pending: 'Signing in',
      paused: 'Paused',
    });
  });
});

describe('KEY_CHECK_COPY.unreachable', () => {
  it('names the person’s own Nango server and what to check once DorkOS stops trying', () => {
    expect(KEY_CHECK_COPY.unreachable('nango', true)).toBe(
      'DorkOS couldn’t reach your Nango server. It checks again on its own.'
    );
    expect(KEY_CHECK_COPY.unreachable('nango', false)).toBe(
      'DorkOS couldn’t reach your Nango server. Check that it’s running and its address is right, then save the key again.'
    );
  });
});

describe('connectionAccessWords', () => {
  it('says what a set of kinds allows, never "delete" for a destructive one', () => {
    expect(connectionAccessWords(['read'])).toBe('read');
    expect(connectionAccessWords(['write', 'read'])).toBe('read and write');
    expect(connectionAccessWords(['destructive', 'read', 'write'])).toBe(
      'read, write and high-risk actions'
    );
  });
});
