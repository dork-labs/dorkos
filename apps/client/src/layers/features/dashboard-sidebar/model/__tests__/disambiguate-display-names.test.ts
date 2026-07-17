import { describe, expect, it } from 'vitest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { disambiguateDisplayNames } from '../disambiguate-display-names';

const manifest = (displayName: string): AgentManifest => ({ displayName }) as AgentManifest;

describe('disambiguateDisplayNames', () => {
  it('returns bare names when nothing collides', () => {
    const result = disambiguateDisplayNames(['/home/a/api', '/home/a/web'], {});
    expect(result).toEqual({ '/home/a/api': 'api', '/home/a/web': 'web' });
  });

  it('disambiguates collisions via the parent directory', () => {
    const result = disambiguateDisplayNames(['/home/acme/server', '/home/globex/server'], {});
    expect(result['/home/acme/server']).toBe('server (acme)');
    expect(result['/home/globex/server']).toBe('server (globex)');
  });

  it('reaches the root segment for 2-segment paths (PR #293 review: loop bound)', () => {
    // Paths differ ONLY at the root — the old `offset < segments.length`
    // bound never examined index 0, leaving both labels identical.
    const result = disambiguateDisplayNames(['/acme/server', '/globex/server'], {});
    expect(result['/acme/server']).toBe('server (acme)');
    expect(result['/globex/server']).toBe('server (globex)');
    expect(new Set(Object.values(result)).size).toBe(2);
  });

  it('uses the leaf directory when custom displayNames collide across different dirs', () => {
    const agents = { '/home/x/api': manifest('Server'), '/home/x/web': manifest('Server') };
    const result = disambiguateDisplayNames(['/home/x/api', '/home/x/web'], agents);
    expect(result['/home/x/api']).toBe('Server (api)');
    expect(result['/home/x/web']).toBe('Server (web)');
  });

  it('handles colliding paths of different lengths', () => {
    const result = disambiguateDisplayNames(['/server', '/nested/server'], {});
    // The shorter path has no differentiating segment left; the longer one
    // disambiguates, keeping the label set unique overall.
    expect(result['/nested/server']).toBe('server (nested)');
    expect(new Set(Object.values(result)).size).toBe(2);
  });

  it('falls back to the base name when no single segment differentiates', () => {
    // Each candidate segment of the first path collides with one of the others.
    const result = disambiguateDisplayNames(['/a/x/server', '/b/x/server', '/a/y/server'], {});
    expect(result['/b/x/server']).toBe('server (b)');
    expect(result['/a/y/server']).toBe('server (y)');
    expect(result['/a/x/server']).toBe('server');
  });
});
