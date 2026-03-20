/**
 * Re-export the APIPage component for use in the docs catch-all page.
 *
 * This wrapper exists so the catch-all page can import from a local component
 * path rather than directly from the lib module, following FSD conventions.
 *
 * Note: This file must NOT have 'use client' — APIPage is an async Server
 * Component from fumadocs-openapi that performs file I/O to load the spec.
 */
export { APIPage } from '@/lib/openapi';
