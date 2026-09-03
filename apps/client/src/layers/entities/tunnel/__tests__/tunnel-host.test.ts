import { describe, it, expect } from 'vitest';
import { tunnelHost } from '../lib/tunnel-host';

describe('tunnelHost', () => {
  it('drops the scheme, which every tunnel URL shares', () => {
    expect(tunnelHost('https://calm-otter.ngrok.app')).toBe('calm-otter.ngrok.app');
    expect(tunnelHost('http://calm-otter.ngrok.app')).toBe('calm-otter.ngrok.app');
  });

  it('drops a trailing slash, so two spellings of one host read alike', () => {
    expect(tunnelHost('https://calm-otter.ngrok.app/')).toBe('calm-otter.ngrok.app');
  });

  it('keeps a custom domain and a port intact', () => {
    expect(tunnelHost('https://dork.example.com:8443')).toBe('dork.example.com:8443');
  });

  it('says nothing when there is no URL', () => {
    expect(tunnelHost(null)).toBeNull();
    expect(tunnelHost('')).toBeNull();
  });
});
