'use client';

import { usePathname } from 'next/navigation';
import { ThemeProvider } from 'next-themes';
import type { ReactNode } from 'react';

import { Toaster } from '@/components/ui/sonner';

/**
 * Route prefixes that keep following the visitor's OS theme. Docs has a real
 * dark mode (Fumadocs provides the toggle); the admin console is an internal
 * tool left on the operator's preference. Everything else (marketing, blog,
 * account, legal) is designed cream/light-only, so the theme is forced to
 * light there: leaving it on `system` put `.dark` on <html> for dark-OS
 * visitors, flipping shadcn tokens and `dark:` variants underneath a light
 * design (black inline-code chips, gray inputs).
 */
const SYSTEM_THEME_PREFIXES = ['/docs', '/admin'];

interface ProvidersProps {
  children: ReactNode;
}

export function Providers({ children }: ProvidersProps) {
  const pathname = usePathname();
  const followsSystem = SYSTEM_THEME_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );

  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      forcedTheme={followsSystem ? undefined : 'light'}
    >
      {children}
      <Toaster />
    </ThemeProvider>
  );
}
