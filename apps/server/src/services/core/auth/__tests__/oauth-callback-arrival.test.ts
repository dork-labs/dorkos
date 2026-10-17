/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  gateFactsFor,
  isOAuthCallbackArrival,
  withoutReferringPage,
} from '../oauth-callback-arrival.js';
import type { ClassifierFacts } from '../../../../lib/request-classifier.js';

const FACTS: ClassifierFacts = {
  peerAddress: '127.0.0.1',
  ingress: 'direct',
  headers: {
    host: 'localhost:4242',
    referer: 'https://mcp.artblocks.io/',
    origin: 'https://mcp.artblocks.io',
    cookie: 'a=b',
  },
};

describe('isOAuthCallbackArrival', () => {
  it('matches a GET or HEAD to either callback route, however it is spelled', () => {
    expect(isOAuthCallbackArrival('GET', '/api/agents/mcp-oauth/callback')).toBe(true);
    expect(isOAuthCallbackArrival('head', '/API/agents//mcp-oauth/callback/')).toBe(true);
    expect(isOAuthCallbackArrival('GET', '/api/runtimes/opencode/openrouter/oauth/callback')).toBe(
      true
    );
  });

  it('never matches a write or another path', () => {
    expect(isOAuthCallbackArrival('POST', '/api/agents/mcp-oauth/callback')).toBe(false);
    expect(isOAuthCallbackArrival('GET', '/api/agents/mcp-oauth/callback/x')).toBe(false);
    expect(isOAuthCallbackArrival('GET', '/api/agents/mcp-oauth')).toBe(false);
    expect(isOAuthCallbackArrival('GET', '/api/sessions')).toBe(false);
  });
});

describe('gateFactsFor', () => {
  it('drops only Origin and Referer for a callback arrival', () => {
    const judged = gateFactsFor('GET', '/api/agents/mcp-oauth/callback', FACTS);
    expect(judged.headers).toEqual({ host: 'localhost:4242', cookie: 'a=b' });
    expect(judged.peerAddress).toBe('127.0.0.1');
    // The request's own facts are untouched.
    expect(FACTS.headers.referer).toBe('https://mcp.artblocks.io/');
  });

  it('leaves every other request as it came', () => {
    expect(gateFactsFor('GET', '/api/sessions', FACTS)).toBe(FACTS);
    expect(gateFactsFor('POST', '/api/agents/mcp-oauth/callback', FACTS)).toBe(FACTS);
  });

  it('withoutReferringPage keeps the rest of the facts', () => {
    expect(withoutReferringPage(FACTS).ingress).toBe('direct');
  });
});
