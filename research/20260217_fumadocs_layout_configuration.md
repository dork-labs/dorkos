---
title: "Fumadocs Layout Configuration Research"
date: 2026-02-17
type: implementation
status: archived
tags: [fumadocs, layout, configuration, docs-site, next-js]
feature_slug: documentation-infrastructure
---

# Fumadocs Layout Configuration Research

**Date**: 2026-02-17
**Fumadocs-UI Version**: 16.6.2 (installed in this repo)
**Research Depth**: Deep

---

## Research Summary

Fumadocs UI 16.x uses a shared `BaseLayoutProps` interface that both `DocsLayout` and `HomeLayout` extend. The primary customization surface is the `nav` object (for logo/title/links in the top bar) and the `links` array (for nav link items). There is no first-class footer prop at the layout level — footer-level content at the sidebar is via `sidebar.footer` (ReactNode), and the page-level "previous/next" footer is via `DocsPage`'s `footer` prop. A site-wide footer must be custom JSX placed in your Next.js layout file.

---

## Key Findings

### 1. Shared BaseLayoutProps (applies to BOTH DocsLayout and HomeLayout)

Sourced directly from the installed type definitions at `node_modules/fumadocs-ui/dist/layouts/shared/index.d.ts`:

```typescript
interface NavOptions {
  enabled: boolean;
  component: ReactNode;                         // fully replace the navbar
  title?: ReactNode | ((props: ComponentProps<'a'>) => ReactNode);  // logo + name here
  url?: string;                                  // where clicking title navigates (default: '/')
  transparentMode?: 'always' | 'top' | 'none';  // default: 'none'
  children?: ReactNode;                          // inject extra content into navbar
}

interface BaseLayoutProps {
  themeSwitch?: {
    enabled?: boolean;
    component?: ReactNode;
    mode?: 'light-dark' | 'light-dark-system';
  };
  searchToggle?: Partial<{
    enabled: boolean;
    components: Partial<{ sm: ReactNode; lg: ReactNode }>;
  }>;
  i18n?: boolean | I18nConfig;
  githubUrl?: string;       // shortcut: adds GitHub icon link automatically
  links?: LinkItemType[];   // nav link items
  nav?: Partial<NavOptions>;
  children?: ReactNode;
}
```

### 2. LinkItemType — All Five Variants

From `node_modules/fumadocs-ui/dist/utils/link-item.d.ts`:

```typescript
// Where the item appears
type FilterOn = 'menu' | 'nav' | 'all';  // default: 'all'

// Standard link (text with optional icon)
interface MainItemType {
  type?: 'main';
  icon?: ReactNode;
  text: ReactNode;
  description?: ReactNode;
  url: string;
  active?: 'url' | 'nested-url' | 'none';  // default: 'url'
  external?: boolean;
  on?: FilterOn;
}

// Icon-only button (secondary by default)
interface IconItemType {
  type: 'icon';
  label?: string;    // aria-label
  icon: ReactNode;
  text: ReactNode;   // tooltip text
  url: string;
  secondary?: boolean;  // default: true
  on?: FilterOn;
}

// CTA button style link
interface ButtonItemType {
  type: 'button';
  icon?: ReactNode;
  text: ReactNode;
  url: string;
  secondary?: boolean;  // default: false
  on?: FilterOn;
}

// Dropdown menu
interface MenuItemType {
  type: 'menu';
  icon?: ReactNode;
  text: ReactNode;
  url?: string;
  items: (MainItemType | CustomItemType)[];
  secondary?: boolean;  // default: false
  on?: FilterOn;
}

// Arbitrary React content
interface CustomItemType {
  type: 'custom';
  children: ReactNode;
  secondary?: boolean;  // default: false
  on?: FilterOn;
}

type LinkItemType = MainItemType | IconItemType | ButtonItemType | MenuItemType | CustomItemType;
```

The `secondary: true` items are pushed to the right/end of the navbar. The `on` prop filters where links appear (`'nav'` = navbar only, `'menu'` = mobile hamburger only, `'all'` = both).

### 3. DocsLayout Props

From `node_modules/fumadocs-ui/dist/layouts/docs/index.d.ts`:

```typescript
interface DocsLayoutProps extends BaseLayoutProps {
  tree: PageTree.Root;          // REQUIRED - the page tree from source.pageTree
  sidebar?: SidebarOptions;
  tabMode?: 'top' | 'auto';
  containerProps?: HTMLAttributes<HTMLDivElement>;
}

interface SidebarOptions {
  enabled?: boolean;
  component?: ReactNode;        // fully replace sidebar
  components?: Partial<SidebarPageTreeComponents>;
  tabs?: SidebarTabWithProps[] | GetSidebarTabsOptions | false;
  banner?: ReactNode;           // content above sidebar nav
  footer?: ReactNode;           // content below sidebar nav
  collapsible?: boolean;        // default: true
  defaultOpenLevel?: number;    // default: 0
  prefetch?: boolean;
  // ...also accepts aside HTML attributes
}
```

Key: `sidebar.footer` is a `ReactNode` — perfect for putting "Back to Site" links at the bottom of the sidebar.

### 4. HomeLayout Props

From `node_modules/fumadocs-ui/dist/layouts/home/index.d.ts`:

```typescript
interface HomeLayoutProps extends BaseLayoutProps {
  nav?: Partial<NavOptions & {
    enableHoverToOpen?: boolean;  // open mobile menu on hover
  }>;
}
```

HomeLayout is a thin wrapper over `BaseLayoutProps` — it only adds `nav.enableHoverToOpen`. Use it for marketing pages / landing pages that need a top nav but no sidebar.

### 5. DocsPage Footer (page-level prev/next navigation)

From `node_modules/fumadocs-ui/dist/layouts/docs/page/index.d.ts`:

```typescript
interface FooterOptions {
  enabled: boolean;
  component: ReactNode;         // replace prev/next footer entirely
  // ...also FooterProps (prev/next items)
}

interface DocsPageProps {
  footer?: Partial<FooterOptions>;
  breadcrumb?: Partial<BreadcrumbOptions>;
  toc?: TOCItemType[];
  tableOfContent?: Partial<TableOfContentOptions>;
  full?: boolean;
  className?: string;
  children?: ReactNode;
}
```

This is the per-page footer (prev/next links at the bottom of each doc page), NOT a site-wide footer.

---

## Detailed Analysis

### Setting Up Logo + Site Name in the Navbar

The `nav.title` prop accepts either a `ReactNode` or a render function. This is where you put your logo + site name combination:

```tsx
// apps/web/src/lib/layout.shared.tsx
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import Image from 'next/image';

export const baseOptions: BaseLayoutProps = {
  nav: {
    title: (
      <span className="flex items-center gap-2">
        <Image src="/logo.svg" alt="DorkOS" width={24} height={24} />
        <span className="font-semibold">DorkOS</span>
      </span>
    ),
    url: '/',  // clicking logo goes home
  },
  githubUrl: 'https://github.com/dork-labs/dorkos',
};
```

The `title` render function variant (called with `ComponentProps<'a'>`) lets you use Next.js `<Link>` for client-side navigation:

```tsx
nav: {
  title: (props) => (
    <Link {...props} href="/">
      <span className="flex items-center gap-2">
        <MyLogo className="h-6 w-6" />
        <span>DorkOS</span>
      </span>
    </Link>
  ),
}
```

### Adding Nav Links (Home, Docs, GitHub, etc.)

```tsx
import type { LinkItemType } from 'fumadocs-ui/layouts/shared';
import { BookIcon, GithubIcon, HomeIcon } from 'lucide-react';

export const baseOptions: BaseLayoutProps = {
  nav: {
    title: 'DorkOS',
  },
  githubUrl: 'https://github.com/dork-labs/dorkos',  // auto-adds GitHub icon
  links: [
    // Standard text link
    {
      text: 'Home',
      url: '/',
      active: 'url',
    },
    // Standard text link with icon
    {
      icon: <BookIcon />,
      text: 'Docs',
      url: '/docs',
      active: 'nested-url',
    },
    // Icon-only button (appears in nav, secondary = right-aligned)
    {
      type: 'icon',
      label: 'GitHub',
      icon: <GithubIcon />,
      text: 'GitHub',
      url: 'https://github.com/dork-labs/dorkos',
      external: true,
      secondary: true,
    },
    // CTA button
    {
      type: 'button',
      text: 'Download',
      url: '/download',
      secondary: false,
    },
    // Custom JSX in the nav
    {
      type: 'custom',
      children: <UserAvatar />,
      secondary: true,
    },
  ],
};
```

### The layout.shared.tsx Pattern

Fumadocs encourages a shared layout config file so `DocsLayout` and `HomeLayout` both use the same base options:

```tsx
// apps/web/src/lib/layout.shared.tsx
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

export const baseOptions: BaseLayoutProps = {
  nav: {
    title: 'DorkOS Docs',
    url: '/',
    transparentMode: 'none',
  },
  githubUrl: 'https://github.com/dork-labs/dorkos',
  links: [
    { text: 'Home', url: '/', active: 'url', on: 'nav' },
    { text: 'Docs', url: '/docs', active: 'nested-url' },
  ],
};

// apps/web/src/app/(docs)/layout.tsx
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { source } from '@/lib/source';
import { baseOptions } from '@/lib/layout.shared';

export default function Layout({ children }) {
  return (
    <DocsLayout {...baseOptions} tree={source.pageTree}>
      {children}
    </DocsLayout>
  );
}

// apps/web/src/app/(home)/layout.tsx
import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { baseOptions } from '@/lib/layout.shared';

export default function Layout({ children }) {
  return <HomeLayout {...baseOptions}>{children}</HomeLayout>;
}
```

Note: The current DorkOS `apps/web/src/app/(docs)/layout.tsx` does NOT yet use a shared `baseOptions` — it passes no nav/links config at all.

### Footer Strategy — No Built-in Layout Footer

Fumadocs does NOT have a site-wide footer prop on `DocsLayout` or `HomeLayout`. The word "footer" appears in two places only:

1. **`sidebar.footer`** — A `ReactNode` placed at the bottom of the sidebar navigation panel (good for "Back to main site" link or version selector).
2. **`DocsPage.footer`** — The prev/next navigation at the bottom of each docs page body.

For a **site-wide footer** (copyright, links, etc.), the standard approach is to add it in the Next.js layout wrapper above/below the Fumadocs component:

```tsx
// apps/web/src/app/(docs)/layout.tsx
export default function Layout({ children }) {
  return (
    <>
      <DocsLayout {...baseOptions} tree={source.pageTree}>
        {children}
      </DocsLayout>
      <footer className="border-t px-6 py-8 text-sm text-muted-foreground">
        <div className="mx-auto max-w-screen-xl flex justify-between">
          <span>© 2026 Dork Labs</span>
          <a href="https://dorkos.dev">dorkos.dev</a>
        </div>
      </footer>
    </>
  );
}
```

However, wrapping DocsLayout in a footer this way can cause layout issues with the sticky sidebar. The more common pattern is using `sidebar.footer`:

```tsx
<DocsLayout
  {...baseOptions}
  tree={source.pageTree}
  sidebar={{
    footer: (
      <div className="px-3 py-2 text-xs text-muted-foreground border-t">
        <a href="/" className="flex items-center gap-1 hover:text-foreground">
          ← Back to dorkos.dev
        </a>
      </div>
    ),
  }}
>
```

### Linking Back to Main Site

Three common patterns for linking from docs to the main marketing site:

**1. Nav link (appears in docs top navbar):**
```tsx
links: [
  { text: 'dorkos.dev', url: 'https://dorkos.dev', on: 'nav', external: true },
]
```

**2. Sidebar footer (persistent, bottom of sidebar):**
```tsx
sidebar: {
  footer: (
    <a href="https://dorkos.dev" className="text-xs text-muted-foreground hover:text-foreground">
      ← Back to main site
    </a>
  )
}
```

**3. Nav title links to main site instead of `/docs`:**
```tsx
nav: {
  title: 'DorkOS',
  url: 'https://dorkos.dev',  // clicking logo exits docs
}
```

### Favicon and Metadata

Fumadocs itself does not manage favicons — that's handled by Next.js App Router metadata. In `apps/web/src/app/layout.tsx`:

```tsx
export const metadata: Metadata = {
  title: {
    template: '%s | DorkOS',
    default: 'DorkOS',
  },
  icons: {
    icon: '/favicon.ico',
    apple: '/apple-touch-icon.png',
  },
};
```

### Replacing the Entire Navbar

When full custom control is needed:

```tsx
nav: {
  component: <MyCustomNavbar />,
}
```

Then override the CSS variable for layout calculations:

```css
/* global.css */
:root {
  --fd-nav-height: 64px !important;  /* must match your navbar height exactly */
}
```

### Transparent Navbar (for hero sections)

Common on marketing-style doc pages:

```tsx
nav: {
  title: 'DorkOS',
  transparentMode: 'top',  // transparent when at scroll top, opaque after scrolling
}
```

---

## Current State in This Repo

The current `apps/web/src/app/(docs)/layout.tsx` (as of this research) is minimal:

```tsx
// Current — no branding, no nav links, no footer
export default function Layout({ children }) {
  return (
    <RootProvider>
      <DocsLayout tree={source.pageTree}>
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
```

To add branding, a `baseOptions` constant or file should be created and passed to `DocsLayout`.

---

## Sources & Evidence

- Type definitions pulled directly from installed package: `node_modules/fumadocs-ui@16.6.2/dist/layouts/shared/index.d.ts`, `docs/index.d.ts`, `home/index.d.ts`, `docs/page/index.d.ts`, `utils/link-item.d.ts`
- [Docs Layout | Fumadocs](https://www.fumadocs.dev/docs/ui/layouts/docs) — official docs page for DocsLayout
- [Home Layout | Fumadocs](https://fumadocs.dev/docs/ui/layouts/home-layout) — official docs page for HomeLayout
- [Nav Options | Fumadocs](https://fumadocs.dev/docs/ui/layouts/nav) — transparentMode, custom navbar
- [Links | Fumadocs](https://fumadocs.dev/docs/ui/layouts/links) — LinkItemType variants
- [Fumadocs v14 Blog](https://www.fumadocs.dev/blog/v14) — import path changes, nav redesign

---

## Research Gaps

- No official fumadocs documentation page dedicated to "footer" — confirmed by 404 on `/docs/ui/layouts/footer`. The footer concept exists only in `sidebar.footer` (ReactNode) and `DocsPage.footer` (prev/next nav).
- The `nav.children` prop (extra content injected into navbar) is typed but not documented with examples in the official docs.
- No `HomeLayout`-specific footer mechanism beyond wrapping with custom JSX.

---

## Search Methodology

- Searches performed: 7 web searches + 6 WebFetch calls + 8 local file reads
- Most productive: Reading installed `.d.ts` files directly from `node_modules/fumadocs-ui/dist/`
- Primary sources: fumadocs.dev official docs, installed package type definitions
