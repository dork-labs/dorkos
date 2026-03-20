---
slug: update-homepage-brand-foundation
spec: 38
created: 2026-02-17
last-decompose: 2026-02-17
---

# Tasks: Update Homepage Based on Brand Foundation

## Phase 1: Content & Data Updates (Foundation)

### Task 1.1: Update site config and types

Update `config/site.ts` description and simplify `types.ts` by removing `ProjectStatus` and `ProjectType`.

**Files:**

- `apps/web/src/config/site.ts` — change `description` from `'A web UI for Claude Code'` to `'Remote access to Claude Code. On your machine.'`
- `apps/web/src/layers/features/marketing/lib/types.ts` — remove `ProjectStatus` and `ProjectType` types, remove `status` and `type` fields from `Project` interface

**Updated `types.ts`:**

```typescript
export interface Project {
  id: string;
  title: string;
  description: string;
  href?: string;
}

export interface PhilosophyItem {
  number: string;
  title: string;
  description: string;
}

export interface NavLink {
  label: string;
  href: string;
}
```

**Updated `site.ts` description:**

```typescript
description: 'Remote access to Claude Code. On your machine.',
```

**Acceptance criteria:**

- `siteConfig.description` reads `'Remote access to Claude Code. On your machine.'`
- `Project` interface has only `id`, `title`, `description`, `href?`
- `ProjectStatus` and `ProjectType` types no longer exist
- OG metadata in `layout.tsx` auto-updates (reads from siteConfig)
- Barrel exports in `index.ts` no longer export `ProjectStatus` or `ProjectType`
- TypeScript compiles without errors

---

### Task 1.2: Update projects and philosophy data

Reduce projects from 6 to 4 with updated descriptions. Rewrite philosophy items to match brand foundation values.

**Files:**

- `apps/web/src/layers/features/marketing/lib/projects.ts`
- `apps/web/src/layers/features/marketing/lib/philosophy.ts`

**Updated `projects.ts`:**

```typescript
import type { Project } from './types';

export const projects: Project[] = [
  {
    id: 'chat-interface',
    title: 'Chat Interface',
    description:
      'Rich markdown, streaming responses, and syntax highlighting. Claude Code in a real browser UI.',
  },
  {
    id: 'tool-approval',
    title: 'Tool Approval',
    description:
      'Review and approve every tool call before it executes. Full control over what Claude does on your machine.',
  },
  {
    id: 'session-management',
    title: 'Session Management',
    description:
      'Browse, resume, and sync sessions across devices. Works with CLI-started sessions. One source of truth.',
  },
  {
    id: 'slash-commands',
    title: 'Slash Commands',
    description:
      'Discover and run commands from .claude/commands/ with a searchable palette. Your workflows, surfaced.',
  },
];
```

**Updated `philosophy.ts`:**

```typescript
import type { PhilosophyItem } from './types';

export const philosophyItems: PhilosophyItem[] = [
  {
    number: '01',
    title: 'Your Machine',
    description: 'Your AI runs on your hardware. Your sessions stay local. No cloud dependency.',
  },
  {
    number: '02',
    title: 'Open Source',
    description: 'MIT licensed. Read every line of code that touches your AI sessions.',
  },
  {
    number: '03',
    title: 'Power Users',
    description: 'Built for developers who ship. Not a toy. Not a wrapper. A runtime.',
  },
  {
    number: '04',
    title: 'Autonomy',
    description: 'Full control is the default. Unrestricted permissions by design.',
  },
];
```

**Acceptance criteria:**

- `projects` array has exactly 4 items
- No `status` or `type` fields in project objects
- Philosophy items match brand foundation "We Believe" values
- TypeScript compiles without errors

---

## Phase 2: Modify Existing Components

### Task 2.1: Rewrite Hero component

Simplify Hero props (remove taglineLine1/Line2 split, add headline/ctaText/ctaHref), update content to "Own Your AI." positioning.

**File:** `apps/web/src/layers/features/marketing/ui/Hero.tsx`

**New props interface:**

```typescript
interface HeroProps {
  label?: string;
  headline: string;
  subhead: string;
  ctaText: string;
  ctaHref: string;
}
```

**Content from page.tsx call site:**

```tsx
<Hero
  label="Open Source"
  headline="Own Your AI."
  subhead="Remote access to Claude Code from any browser. One npm install. Runs on your machine. No cloud. No middleman."
  ctaText="npm install -g dorkos"
  ctaHref={siteConfig.npm}
/>
```

**Implementation details:**

- Headline is a single `<h1>` in `text-brand-orange` (no line break, no span split)
- The "." in "Own Your AI." is intentional — declarative statement
- Subhead: one paragraph, no line breaks, `max-w-[500px]`
- CTA primary: `ctaText` with blinking cursor, linked to `ctaHref`
- CTA secondary: "Read the docs →" linked to `/docs/getting-started/quickstart`
- Keep all existing visual effects (graph paper bg, radial glow, scan lines, responsive clamp sizing)
- Keep product screenshot unchanged (`/images/dorkos-screenshot.png`)
- Font sizing stays with `clamp(48px, 8vw, 96px)` for headline

**Acceptance criteria:**

- Headline reads "Own Your AI." in brand-orange
- Subhead is one paragraph, no line breaks, max-w-[500px]
- `npm install -g dorkos` CTA with blinking cursor
- Product screenshot below CTAs
- "Read the docs →" secondary link below CTA
- All existing visual effects preserved

---

### Task 2.2: Simplify ProjectCard and update ProjectsGrid layout

Remove status/type badges from ProjectCard, change ProjectsGrid from 3-col to 2-col.

**Files:**

- `apps/web/src/layers/features/marketing/ui/ProjectCard.tsx`
- `apps/web/src/layers/features/marketing/ui/ProjectsGrid.tsx`

**ProjectCard changes:**

- Remove `'use client'` directive (no longer needed without posthog tracking on click)
- Remove `statusColors` and `statusLabels` maps
- Remove `Badge` import and usage
- Remove `posthog` import and `handleProjectClick`
- Remove the meta div with status + type badges
- Keep: title, description, hover effect, optional href link
- Update to use simplified `Project` type (no `status`/`type` fields)

**Simplified ProjectCard:**

```typescript
import Link from 'next/link'
import type { Project } from '../lib/types'

interface ProjectCardProps {
  project: Project
}

export function ProjectCard({ project }: ProjectCardProps) {
  const content = (
    <>
      <h3 className="text-charcoal font-semibold text-xl tracking-[-0.01em] mb-3">
        {project.title}
      </h3>
      <p className="text-warm-gray text-sm leading-relaxed">
        {project.description}
      </p>
    </>
  )

  const baseClassName = "text-center py-12 px-6 bg-cream-primary transition-smooth"
  const hoverClassName = project.href ? "hover:bg-cream-secondary cursor-pointer" : ""

  if (project.href) {
    return (
      <Link
        href={project.href}
        target="_blank"
        rel="noopener noreferrer"
        className={`${baseClassName} ${hoverClassName}`}
      >
        {content}
      </Link>
    )
  }

  return <article className={baseClassName}>{content}</article>
}
```

**ProjectsGrid change:**

- Change grid from `lg:grid-cols-3` to `lg:grid-cols-2` (4 cards = 2x2)

**Acceptance criteria:**

- 4 feature cards (Chat Interface, Tool Approval, Session Management, Slash Commands)
- No status or type badges on cards
- 2-column grid on desktop, 1-column on mobile (stacks at md breakpoint via `md:grid-cols-2`)
- "Features" label in brand-orange preserved

---

### Task 2.3: Merge AboutSection and remove OriginSection

Merge OriginSection content into AboutSection, update copy, add closing line, delete OriginSection file.

**Files:**

- `apps/web/src/layers/features/marketing/ui/AboutSection.tsx` — rewrite
- `apps/web/src/layers/features/marketing/ui/OriginSection.tsx` — delete
- `apps/web/src/layers/features/marketing/index.ts` — remove OriginSection export, remove ProjectStatus/ProjectType type exports

**Updated AboutSection:**

- Lead text: "DorkOS is open source infrastructure for Claude Code by Dork Labs."
  - "by Dork Labs" is a link to GitHub (same as current)
- Description: "DorkOS exists because Claude Code deserved a browser interface. Built on the Agent SDK, it reads the same JSONL session files as the CLI. No separate backend. No data duplication. One source of truth."
- Philosophy grid: 4 items (from updated philosophy.ts)
- Closing line: "The name is playful. The tool is serious." (italic, warm-gray-light) — moved from OriginSection

**Implementation:**

```tsx
import Link from 'next/link';
import { PhilosophyCard } from './PhilosophyCard';
import type { PhilosophyItem } from '../lib/types';

interface AboutSectionProps {
  bylineText?: string;
  bylineHref?: string;
  description: string;
  philosophyItems?: PhilosophyItem[];
}

export function AboutSection({
  bylineText = 'by Dork Labs',
  bylineHref = 'https://github.com/dork-labs/dorkos',
  description,
  philosophyItems = [],
}: AboutSectionProps) {
  return (
    <section id="about" className="bg-cream-white px-8 py-40 text-center">
      <span className="text-2xs text-charcoal mb-16 block font-mono tracking-[0.15em] uppercase">
        About
      </span>

      <p className="text-charcoal mx-auto mb-6 max-w-3xl text-[32px] leading-[1.3] font-medium tracking-[-0.02em]">
        DorkOS is open source infrastructure for Claude Code{' '}
        <Link
          href={bylineHref}
          target="_blank"
          rel="noopener noreferrer"
          className="text-brand-orange hover:text-brand-green transition-smooth"
        >
          {bylineText}
        </Link>
        .
      </p>

      <p className="text-warm-gray mx-auto mb-20 max-w-xl text-base leading-[1.7]">{description}</p>

      {philosophyItems.length > 0 && (
        <div className="mx-auto mb-16 grid max-w-4xl grid-cols-1 gap-12 md:grid-cols-2 lg:grid-cols-4">
          {philosophyItems.map((item) => (
            <PhilosophyCard key={item.number} item={item} />
          ))}
        </div>
      )}

      <p className="text-warm-gray-light text-lg leading-[1.7] italic">
        The name is playful. The tool is serious.
      </p>
    </section>
  );
}
```

**Barrel export updates in `index.ts`:**

- Remove: `export { OriginSection } from './ui/OriginSection'`
- Remove: `ProjectStatus, ProjectType` from type exports line

**Acceptance criteria:**

- Single "About" section replaces old About + Origin
- Lead text is "DorkOS is open source infrastructure for Claude Code by Dork Labs."
- Philosophy grid reflects brand foundation "We Believe" values
- "The name is playful. The tool is serious." closing line preserved
- OriginSection.tsx file deleted
- Barrel export for OriginSection removed
- ProjectStatus and ProjectType type exports removed from barrel
- TypeScript compiles without errors

---

### Task 2.4: Update MarketingFooter with real version

Replace hardcoded "v1.0 · System Online" with actual package version.

**File:** `apps/web/src/layers/features/marketing/ui/MarketingFooter.tsx`

**Change:**
Replace the system status line:

```tsx
// Before
<p className="font-mono text-3xs tracking-[0.2em] uppercase text-cream-tertiary/40 mt-12">
  v1.0 · System Online
</p>

// After — read from package.json or hardcode current version
<p className="font-mono text-3xs tracking-[0.2em] uppercase text-cream-tertiary/40 mt-12">
  v0.2.0 · System Online
</p>
```

**Note:** If reading from package.json at build time is straightforward (Next.js supports `import pkg from '../../../../../package.json'` or via a build-time env var), prefer that approach. Otherwise hardcode the current version from `packages/cli/package.json`. The version in the footer should reflect the published CLI version.

**Acceptance criteria:**

- Footer shows real version number (not "v1.0")
- Format: `v{version} · System Online`
- No runtime errors

---

## Phase 3: New Sections

### Task 3.1: Create CredibilityBar component

Static credibility signals bar displayed after the Hero section.

**File:** `apps/web/src/layers/features/marketing/ui/CredibilityBar.tsx` (new)

**Implementation:**

```tsx
export function CredibilityBar() {
  return (
    <div className="bg-cream-secondary py-6">
      <p className="text-2xs text-warm-gray-light text-center font-mono tracking-[0.1em]">
        Built on the Claude Agent SDK&nbsp;&nbsp;·&nbsp;&nbsp;Open
        Source&nbsp;&nbsp;·&nbsp;&nbsp;MIT Licensed
      </p>
    </div>
  );
}
```

**Design details:**

- Horizontal centered bar
- Background: `bg-cream-secondary` (subtle contrast from hero)
- Typography: `font-mono text-2xs tracking-[0.1em] text-warm-gray-light`
- Padding: `py-6` (compact)
- Three items separated by `·` (middle dot) with `&nbsp;&nbsp;` spacing
- No links, no icons — pure text credibility

**Acceptance criteria:**

- Renders three static text items separated by middle dots
- Visually distinct from hero (different background)
- Monospace, small, understated

---

### Task 3.2: Create ProblemSection component

Antagonist framing section — cloud vs. local positioning.

**File:** `apps/web/src/layers/features/marketing/ui/ProblemSection.tsx` (new)

**Implementation:**

```tsx
export function ProblemSection() {
  return (
    <section className="bg-cream-tertiary px-8 py-32">
      <div className="relative mx-auto max-w-[600px] text-center">
        {/* Corner brackets - engineering document aesthetic (reused from old OriginSection) */}
        <div className="border-warm-gray-light/30 absolute -top-8 -left-8 h-6 w-6 border-t-2 border-l-2" />
        <div className="border-warm-gray-light/30 absolute -top-8 -right-8 h-6 w-6 border-t-2 border-r-2" />
        <div className="border-warm-gray-light/30 absolute -bottom-8 -left-8 h-6 w-6 border-b-2 border-l-2" />
        <div className="border-warm-gray-light/30 absolute -right-8 -bottom-8 h-6 w-6 border-r-2 border-b-2" />

        <p className="text-warm-gray mb-6 text-lg leading-[1.7]">
          Every AI coding interface you&apos;ve used lives in someone else&apos;s cloud. Their
          servers. Their logs. Their uptime. Their rules.
        </p>

        <p className="text-charcoal mb-6 text-lg leading-[1.7] font-semibold">
          DorkOS is different.
        </p>

        <p className="text-warm-gray text-lg leading-[1.7]">
          It runs on your machine. You access it from any browser. Your sessions, your transcripts,
          your infrastructure.
        </p>
      </div>
    </section>
  );
}
```

**Design details:**

- Background: `bg-cream-tertiary`
- Centered text, max-w-[600px]
- Engineering bracket corners (same as current OriginSection aesthetic)
- First paragraph: `text-warm-gray text-lg`
- "DorkOS is different." line: `text-charcoal font-semibold`
- Second paragraph: `text-warm-gray text-lg`
- Padding: `py-32 px-8`
- No section label

**Acceptance criteria:**

- Two paragraphs with "DorkOS is different." as visual separator
- Corner bracket decorations
- Direct "you" address in opening line
- No section label

---

### Task 3.3: Create NotSection component

"What DorkOS Is Not" tribe-building section.

**File:** `apps/web/src/layers/features/marketing/ui/NotSection.tsx` (new)

**Implementation:**

```tsx
export function NotSection() {
  return (
    <section className="bg-cream-white px-8 py-32">
      <div className="mx-auto max-w-[600px] text-center">
        <p className="text-warm-gray text-2xl leading-[2] font-light md:text-3xl">
          DorkOS is not a hosted service.
        </p>
        <p className="text-warm-gray text-2xl leading-[2] font-light md:text-3xl">
          Not a model aggregator.
        </p>
        <p className="text-warm-gray mb-8 text-2xl leading-[2] font-light md:text-3xl">
          Not a chat widget.
        </p>
        <p className="text-charcoal text-2xl leading-[2] font-semibold md:text-3xl">
          It&apos;s infrastructure you run, own, and control.
        </p>
      </div>
    </section>
  );
}
```

**Design details:**

- Background: `bg-cream-white`
- Centered, generous vertical padding (`py-32`)
- Negation lines: `text-2xl md:text-3xl`, `text-warm-gray`, `font-light`
- Final affirmation: same size, `text-charcoal font-semibold`
- Line spacing: generous (`leading-[2]`)
- No section label, no decorations

**Acceptance criteria:**

- Three negation lines in warm-gray
- Final affirmation line in charcoal (visually distinct)
- Large typography, generous spacing
- No section label or decorations

---

### Task 3.4: Create HowItWorksSection with terminal animation

3-step install/run/work section with animated terminal that types out commands on scroll.

**File:** `apps/web/src/layers/features/marketing/ui/HowItWorksSection.tsx` (new, `'use client'`)

**Implementation:**

This is the most complex new component. It needs:

1. A `'use client'` directive for IntersectionObserver and useState
2. A custom `useTypingAnimation` hook or inline effect
3. SSR-safe rendering (full text on server, animation is client-side enhancement)

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';

interface Step {
  number: string;
  command: string;
  description: string;
}

const steps: Step[] = [
  {
    number: '01',
    command: 'npm install -g dorkos',
    description: 'One command. No config files. No Docker. No cloud account.',
  },
  {
    number: '02',
    command: 'dorkos --dir ~/projects',
    description: 'Server starts at localhost:4242. Add --tunnel for remote access from anywhere.',
  },
  {
    number: '03',
    command: 'Full Claude Code in your browser.',
    description:
      'Tool approvals, session history, slash commands. JSONL transcripts stored at ~/.claude/projects/. Always local.',
  },
];

function TerminalBlock({ text, animate }: { text: string; animate: boolean }) {
  const [displayText, setDisplayText] = useState(text);
  const [showCursor, setShowCursor] = useState(true);
  const hasAnimated = useRef(false);

  useEffect(() => {
    if (!animate || hasAnimated.current) return;
    hasAnimated.current = true;
    setDisplayText('');
    let i = 0;
    const interval = setInterval(() => {
      i++;
      setDisplayText(text.slice(0, i));
      if (i >= text.length) {
        clearInterval(interval);
      }
    }, 50);
    return () => clearInterval(interval);
  }, [animate, text]);

  return (
    <div className="bg-cream-secondary text-charcoal mb-4 rounded-lg px-4 py-3 font-mono text-sm">
      <span>{displayText}</span>
      {showCursor && <span className="cursor-blink" aria-hidden="true" />}
    </div>
  );
}

export function HowItWorksSection() {
  const sectionRef = useRef<HTMLElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.3 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <section ref={sectionRef} className="bg-cream-primary px-8 py-40">
      <span className="text-2xs text-brand-orange mb-20 block text-center font-mono tracking-[0.15em] uppercase">
        How It Works
      </span>

      <div className="mx-auto grid max-w-5xl grid-cols-1 gap-12 lg:grid-cols-3">
        {steps.map((step, index) => (
          <div key={step.number} className="text-center">
            <span className="text-2xs text-brand-green mb-4 block font-mono tracking-[0.1em]">
              {step.number}
            </span>
            <TerminalBlock text={step.command} animate={isVisible && index < 2} />
            <p className="text-warm-gray text-sm leading-relaxed">{step.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
```

**Terminal animation spec:**

- Typing speed: ~50ms per character
- Cursor: blinking block cursor (reuse `cursor-blink` animation from globals.css)
- Trigger: Starts when section enters viewport (IntersectionObserver, threshold 0.3)
- Only animates once (no replay on re-scroll) — uses `hasAnimated` ref
- SSR-safe: renders full text on server (useState initializes with full text), animation is client-side enhancement only
- Steps 1 and 2 animate (actual commands). Step 3 does not animate (it's a description, not a command).
- No external dependency — pure React + CSS

**Acceptance criteria:**

- Three steps in a grid (3-col desktop, 1-col mobile)
- Each step has a number, code block, and description
- Terminal animation types out commands on scroll
- Animation is SSR-safe (full text rendered server-side)
- Section label "How It Works" in brand-orange
- No external terminal library dependency

---

## Phase 4: Assembly & Polish

### Task 4.1: Assemble page with new section ordering and update barrel exports

Update page.tsx with new section order, update barrel exports, update Hero call site props.

**Files:**

- `apps/web/src/app/(marketing)/page.tsx` — new section ordering + updated imports/props
- `apps/web/src/layers/features/marketing/index.ts` — add new exports, remove old ones

**Updated `page.tsx`:**

```tsx
import { siteConfig } from '@/config/site';
import {
  Hero,
  CredibilityBar,
  ProblemSection,
  HowItWorksSection,
  ProjectsGrid,
  NotSection,
  AboutSection,
  ContactSection,
  MarketingNav,
  MarketingHeader,
  MarketingFooter,
  projects,
  philosophyItems,
} from '@/layers/features/marketing';

const navLinks = [
  { label: 'features', href: '#features' },
  { label: 'about', href: '#about' },
  { label: 'contact', href: '#contact' },
  { label: 'docs', href: '/docs' },
];

const socialLinks = [
  {
    name: 'GitHub',
    href: siteConfig.github,
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
      </svg>
    ),
  },
  {
    name: 'npm',
    href: siteConfig.npm,
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M1.763 0C.786 0 0 .786 0 1.763v20.474C0 23.214.786 24 1.763 24h20.474c.977 0 1.763-.786 1.763-1.763V1.763C24 .786 23.214 0 22.237 0zM5.13 5.323l13.837.019-.009 13.836h-3.464l.01-10.382h-3.456L12.04 19.17H5.113z" />
      </svg>
    ),
  },
];

export default function HomePage() {
  return (
    <>
      <MarketingHeader />

      <main>
        <Hero
          label="Open Source"
          headline="Own Your AI."
          subhead="Remote access to Claude Code from any browser. One npm install. Runs on your machine. No cloud. No middleman."
          ctaText="npm install -g dorkos"
          ctaHref={siteConfig.npm}
        />

        <CredibilityBar />

        <ProblemSection />

        <HowItWorksSection />

        <ProjectsGrid projects={projects} />

        <NotSection />

        <AboutSection
          description="DorkOS exists because Claude Code deserved a browser interface. Built on the Agent SDK, it reads the same JSONL session files as the CLI. No separate backend. No data duplication. One source of truth."
          philosophyItems={philosophyItems}
        />

        <ContactSection email={siteConfig.contactEmail} />
      </main>

      <MarketingFooter email={siteConfig.contactEmail} socialLinks={socialLinks} />

      <MarketingNav links={navLinks} />
    </>
  );
}
```

**Updated `index.ts` barrel:**

```typescript
// UI components
export { Hero } from './ui/Hero';
export { CredibilityBar } from './ui/CredibilityBar';
export { ProblemSection } from './ui/ProblemSection';
export { HowItWorksSection } from './ui/HowItWorksSection';
export { ProjectCard } from './ui/ProjectCard';
export { ProjectsGrid } from './ui/ProjectsGrid';
export { NotSection } from './ui/NotSection';
export { PhilosophyCard } from './ui/PhilosophyCard';
export { PhilosophyGrid } from './ui/PhilosophyGrid';
export { AboutSection } from './ui/AboutSection';
export { ContactSection } from './ui/ContactSection';
export { MarketingNav } from './ui/MarketingNav';
export { MarketingHeader } from './ui/MarketingHeader';
export { MarketingFooter } from './ui/MarketingFooter';

// Data
export { projects } from './lib/projects';
export { philosophyItems } from './lib/philosophy';

// Types
export type { Project, PhilosophyItem, NavLink } from './lib/types';
```

**Acceptance criteria:**

- All 8 sections render in correct order: Hero, CredibilityBar, ProblemSection, HowItWorksSection, ProjectsGrid, NotSection, AboutSection, ContactSection
- OriginSection is completely removed from page and barrel
- New components are exported from barrel
- TypeScript compiles without errors
- `npm run build` succeeds for @dorkos/web

---

### Task 4.2: Visual QA and final verification

Manual verification checklist. No code changes — this is a verification-only task.

**Verification checklist:**

- [ ] All 8 sections render in correct order
- [ ] Hero headline is "Own Your AI."
- [ ] Terminal animation plays on scroll
- [ ] Terminal animation degrades gracefully (SSR, no-JS)
- [ ] 4 feature cards in 2x2 grid (desktop)
- [ ] No status/type badges on feature cards
- [ ] Footer shows real version number
- [ ] Mobile responsive (all sections stack correctly)
- [ ] OG meta description matches new site description ("Remote access to Claude Code. On your machine.")
- [ ] No banned words on page (powerful, seamless, robust, next-generation, cutting-edge, innovative, intuitive, comprehensive, enterprise-grade, revolutionary, easy-to-use, simple, AI assistant)
- [ ] All links work (npm, docs, GitHub)
- [ ] PostHog tracking still works on contact email reveal
- [ ] `npm run build` succeeds
- [ ] `npm run typecheck` passes
- [ ] No console errors in browser

**Build verification commands:**

```bash
npm run build
npm run typecheck
```

**Acceptance criteria:**

- All items on checklist pass
- Build succeeds
- Typecheck passes
