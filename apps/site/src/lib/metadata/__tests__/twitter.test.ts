import { describe, expect, it } from 'vitest';
import { twitterFromOpenGraph } from '../twitter';

describe('twitterFromOpenGraph', () => {
  it('mirrors the Open Graph title and description into a large-image card', () => {
    const twitter = twitterFromOpenGraph({
      title: 'Marketplace — DorkOS',
      description: 'Pre-built agents, plugins, and skill packs.',
    });

    expect(twitter).toEqual({
      card: 'summary_large_image',
      title: 'Marketplace — DorkOS',
      description: 'Pre-built agents, plugins, and skill packs.',
    });
  });

  it('does not set its own images (the OG image is reused by Next)', () => {
    const twitter = twitterFromOpenGraph({ title: 'T', description: 'D' });
    expect(twitter).not.toHaveProperty('images');
  });
});
