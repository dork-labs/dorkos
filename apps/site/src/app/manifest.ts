import type { MetadataRoute } from 'next';
import { siteConfig } from '@/config/site';

/**
 * Web app manifest (`/manifest.webmanifest`). Gives DorkOS a proper name, icons,
 * and theme so add-to-homescreen and installed-PWA surfaces render the brand
 * instead of a generic screenshot. Colors mirror the site's light theme-color
 * (see `viewport.themeColor` in the root layout); the 512 icon is `maskable` so
 * Android can crop it into its adaptive-icon shape without clipping the mark.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: siteConfig.name,
    short_name: siteConfig.name,
    description: siteConfig.description,
    start_url: '/',
    display: 'standalone',
    background_color: '#FFFCF7',
    theme_color: '#FFFCF7',
    icons: [
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
