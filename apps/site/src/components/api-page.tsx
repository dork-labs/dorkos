'use client';

import { createOpenAPIPage } from 'fumadocs-openapi/ui';

/**
 * Client `APIPage` component for the interactive OpenAPI reference pages.
 *
 * Under fumadocs-openapi v11, `createOpenAPIPage()` returns a **client**
 * component that renders entirely from serialized props — the OpenAPI document
 * is passed in as data, never read from disk at runtime. This file is therefore
 * a `'use client'` module, the exact inverse of the v10 wiring (where `APIPage`
 * was an async Server Component that performed file I/O). The server catch-all
 * page (`app/(docs)/docs/[[...slug]]/page.tsx`) bundles each page's schema at
 * build time via `openapi.preloadOpenAPIPage(page)` and binds it into this
 * component through the `preloaded` prop.
 */
export const APIPage = createOpenAPIPage();
