'use client';

import type { ReactNode } from 'react';
import { Download } from 'lucide-react';
import { CommandChip } from '@/layers/shared/ui/command-chip';
import {
  trackHeroDownload,
  trackHeroInstallCopy,
  type DownloadPlacement,
  type InstallMethod,
} from '@/lib/analytics';

/**
 * Desktop download button for the install page; reports the click to
 * analytics. Client component so the server-rendered page can keep its
 * static content while clicks are still measured.
 *
 * @param props - Target href, analytics placement, and button content.
 */
export function DownloadButton({
  href,
  placement,
  children,
}: {
  href: string;
  placement: DownloadPlacement;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      onClick={() => trackHeroDownload(placement)}
      className="marketing-btn bg-brand-orange text-cream-white inline-flex items-center gap-2.5"
    >
      <Download size={18} aria-hidden="true" />
      {children}
    </a>
  );
}

/**
 * Copyable install command for the install page; reports copies to analytics.
 *
 * @param props - The shell command and which install method it represents.
 */
export function InstallCommand({ command, method }: { command: string; method: InstallMethod }) {
  return <CommandChip command={command} onCopied={() => trackHeroInstallCopy(method)} />;
}
