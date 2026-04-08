import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  isRemoteTarget,
  parseMarketplaceValidateArgs,
  runMarketplaceValidate,
} from '../marketplace-validate.js';

// The dispatcher delegates to the two existing handlers — mock them at the
// module level so we can assert routing behaviour without re-exercising the
// fetch/read pipelines (covered exhaustively by package-validate-remote.test.ts
// and package-validate-marketplace.test.ts).
vi.mock('../package-validate-remote.js', () => ({
  runValidateRemote: vi.fn(async () => 0),
}));
vi.mock('../package-validate-marketplace.js', () => ({
  runValidateMarketplace: vi.fn(async () => 0),
}));

import { runValidateRemote } from '../package-validate-remote.js';
import { runValidateMarketplace } from '../package-validate-marketplace.js';

const runValidateRemoteMock = vi.mocked(runValidateRemote);
const runValidateMarketplaceMock = vi.mocked(runValidateMarketplace);

describe('isRemoteTarget', () => {
  it('detects https:// URLs', () => {
    expect(isRemoteTarget('https://github.com/dork-labs/marketplace')).toBe(true);
  });

  it('detects http:// URLs', () => {
    expect(isRemoteTarget('http://localhost:8080/marketplace.json')).toBe(true);
  });

  it('treats bare relative paths as local', () => {
    expect(isRemoteTarget('./marketplace.json')).toBe(false);
  });

  it('treats absolute filesystem paths as local', () => {
    expect(isRemoteTarget('/tmp/marketplace.json')).toBe(false);
  });

  it('does not misdetect local paths that contain "http" as a substring', () => {
    expect(isRemoteTarget('./fixtures/http-test/marketplace.json')).toBe(false);
    expect(isRemoteTarget('./https-fixture.json')).toBe(false);
  });

  it('does not match protocols other than http(s)', () => {
    expect(isRemoteTarget('file:///tmp/marketplace.json')).toBe(false);
    expect(isRemoteTarget('ftp://example.com/marketplace.json')).toBe(false);
  });
});

describe('parseMarketplaceValidateArgs', () => {
  it('returns the first positional argument as target', () => {
    expect(parseMarketplaceValidateArgs(['./marketplace.json'])).toEqual({
      target: './marketplace.json',
    });
  });

  it('returns a URL positional unchanged', () => {
    expect(parseMarketplaceValidateArgs(['https://github.com/dork-labs/marketplace'])).toEqual({
      target: 'https://github.com/dork-labs/marketplace',
    });
  });

  it('skips flag-shaped tokens when picking the positional', () => {
    expect(parseMarketplaceValidateArgs(['--verbose', './marketplace.json'])).toEqual({
      target: './marketplace.json',
    });
  });

  it('throws a usage-hinted error when no positional is supplied', () => {
    expect(() => parseMarketplaceValidateArgs([])).toThrow(/Missing required <path-or-url>/);
    expect(() => parseMarketplaceValidateArgs([])).toThrow(/dorkos marketplace validate/);
  });
});

describe('runMarketplaceValidate', () => {
  beforeEach(() => {
    runValidateRemoteMock.mockClear();
    runValidateMarketplaceMock.mockClear();
    runValidateRemoteMock.mockResolvedValue(0);
    runValidateMarketplaceMock.mockResolvedValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes https:// targets to runValidateRemote with the url field', async () => {
    const exit = await runMarketplaceValidate({
      target: 'https://github.com/dork-labs/marketplace',
    });

    expect(exit).toBe(0);
    expect(runValidateRemoteMock).toHaveBeenCalledTimes(1);
    expect(runValidateRemoteMock).toHaveBeenCalledWith({
      url: 'https://github.com/dork-labs/marketplace',
    });
    expect(runValidateMarketplaceMock).not.toHaveBeenCalled();
  });

  it('routes http:// targets to runValidateRemote', async () => {
    await runMarketplaceValidate({ target: 'http://localhost:8080/marketplace.json' });

    expect(runValidateRemoteMock).toHaveBeenCalledWith({
      url: 'http://localhost:8080/marketplace.json',
    });
  });

  it('routes local paths to runValidateMarketplace with the path field', async () => {
    const exit = await runMarketplaceValidate({
      target: './.claude-plugin/marketplace.json',
    });

    expect(exit).toBe(0);
    expect(runValidateMarketplaceMock).toHaveBeenCalledTimes(1);
    expect(runValidateMarketplaceMock).toHaveBeenCalledWith({
      path: './.claude-plugin/marketplace.json',
    });
    expect(runValidateRemoteMock).not.toHaveBeenCalled();
  });

  it('forwards the delegate exit code unchanged (exit 2 — strict CC failure)', async () => {
    runValidateRemoteMock.mockResolvedValueOnce(2);

    const exit = await runMarketplaceValidate({
      target: 'https://github.com/dork-labs/marketplace',
    });

    expect(exit).toBe(2);
  });

  it('forwards the delegate exit code unchanged (exit 1 — fetch failure)', async () => {
    runValidateMarketplaceMock.mockResolvedValueOnce(1);

    const exit = await runMarketplaceValidate({ target: './nope.json' });

    expect(exit).toBe(1);
  });
});
