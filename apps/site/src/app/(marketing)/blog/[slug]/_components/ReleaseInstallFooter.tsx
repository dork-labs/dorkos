import Link from 'next/link';
import { CommandChip } from '@/layers/shared/ui/command-chip';
import { releaseVersion } from '@/lib/blog-order';

/**
 * Install / Update footer appended to every release post by the blog
 * template. Release posts used to hand-write this section in MDX, which
 * drifted as install options grew; rendering it here keeps all posts
 * current and consistent. Shows the version-pinned command for the release
 * the post announces, plus the canonical `/install` page for everything
 * else (desktop apps, one-liner, Docker).
 *
 * @param props - The post's title and slug, used to pin the version.
 */
export function ReleaseInstallFooter({ title, slug }: { title: string; slug: string }) {
  const version = releaseVersion(title, slug);
  const command = version ? `npm install -g dorkos@${version}` : 'npm install -g dorkos@latest';

  return (
    <aside className="border-warm-gray-light/30 mt-16 rounded-xl border p-6">
      <h2 className="text-charcoal mb-3 font-mono text-sm font-bold tracking-tight">
        Install / Update
      </h2>
      <CommandChip command={command} />
      <p className="text-warm-gray-light mt-3 text-sm">
        Already running DorkOS? This one command updates it. The desktop app can update itself:
        choose Check for Updates from the app menu.
      </p>
      <p className="text-warm-gray-light mt-1 text-sm">
        New here? See{' '}
        <Link href="/install" className="text-charcoal hover:text-brand-orange underline">
          every way to install
        </Link>
        .
      </p>
    </aside>
  );
}
