import Link from 'next/link';
import { AppleLogo } from './AppleLogo';

/**
 * The page's primary call to action: get the Mac app. Downloading the signed
 * app is the shortest path for most people, so the terminal install sits
 * underneath it as the alternative rather than the default.
 */
export function DownloadMacButton() {
  return (
    <Link
      href="/download/mac"
      className="inline-flex items-center gap-2.5 rounded-full bg-(--ember) px-7 py-3.5 text-base font-semibold text-[#131110] transition-transform hover:scale-[1.03] focus-visible:ring-2 focus-visible:ring-(--cream) focus-visible:ring-offset-2 focus-visible:ring-offset-(--pitch) focus-visible:outline-none active:scale-100 sm:text-lg"
    >
      <AppleLogo size={20} />
      Download for Mac
    </Link>
  );
}
