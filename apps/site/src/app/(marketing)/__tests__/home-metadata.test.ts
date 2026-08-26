import { describe, expect, it } from 'vitest';
import { siteConfig } from '@/config/site';
import { metadata as layoutMetadata } from '../layout';
import { metadata } from '../page';

/**
 * The home page is the site's most-linked URL, and every one of these was
 * wrong at least once while the page was being built. Next shallow-merges
 * metadata, so declaring a key at all replaces the parent's copy of it whole —
 * which is how an `openGraph` block without `images` and an `alternates`
 * without `types` both shipped and had to be caught by hand.
 */
describe('the home page’s metadata', () => {
  it('says DorkOS exactly once in the title', () => {
    // The root layout's template is `%s | DorkOS`. A plain string title would
    // be fed through it and come back "DorkOS — … | DorkOS".
    expect(metadata.title).toEqual({ absolute: 'DorkOS — All your agents. One place.' });
  });

  it('is indexable, with the site root as its canonical', () => {
    // It was `noindex, nofollow` while it lived at `/new`.
    expect(metadata.robots).toBeUndefined();
    expect(metadata.alternates?.canonical).toBe('/');
  });

  it('keeps the RSS feed link the layout would otherwise have supplied', () => {
    expect(metadata.alternates?.types).toEqual(layoutMetadata.alternates?.types);
  });

  it('carries its own Open Graph card picture', () => {
    const og = metadata.openGraph;
    expect(og?.url).toBe('https://dorkos.ai');
    expect(og && 'images' in og ? og.images : undefined).toEqual([
      {
        url: '/opengraph-image',
        width: 1200,
        height: 630,
        alt: 'DorkOS: one place for every AI agent you run',
      },
    ]);
  });

  it('says which site the shared card came from', () => {
    // `og:site_name` and `og:locale` are declared once, in the root layout,
    // and an `openGraph` block anywhere below replaces that block whole rather
    // than adding to it. So the page that redeclares it has to restate them,
    // or the site's most-shared URL is the one card that does not say what
    // site it belongs to.
    const og = metadata.openGraph;
    expect(og?.siteName).toBe(siteConfig.name);
    expect(og?.locale).toBe('en_US');
  });

  it('mirrors the long description onto the Twitter card', () => {
    // Without a `twitter` block of its own the page would fall back to the
    // root layout's much shorter description, and the two previews would say
    // different things about the same URL.
    expect(metadata.twitter).toEqual({
      card: 'summary_large_image',
      title: 'DorkOS — All your agents. One place.',
      description: metadata.description,
    });
  });
});
