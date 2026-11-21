import { BrowserHandoffCard } from '@/layers/features/browser-handoff';
import { LocalBrowserContent } from '@/layers/features/local-browser';

const handoffCard = (sessionId: string) => <BrowserHandoffCard sessionId={sessionId} />;

/**
 * The Browser right panel. While this chat's agent waits on a person, it shows the chat's
 * own handoff card, so the panel never gives an instruction the card doesn't (DOR-4731).
 */
export function BrowserPanel() {
  return <LocalBrowserContent renderHandoff={handoffCard} />;
}
