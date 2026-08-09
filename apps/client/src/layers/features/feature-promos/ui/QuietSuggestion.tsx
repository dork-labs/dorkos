import { useAppStore } from '@/layers/shared/model';
import type { SuggestingPromo } from '../model/use-quiet-suggestion';
import { useQuietSuggestion } from '../model/use-quiet-suggestion';
import { QuietSuggestionView } from './QuietSuggestionView';
import { usePromoActivation } from './use-promo-activation';

/** The chosen suggestion, wired to its action and its dismissal. */
function WiredSuggestion({ promo }: { promo: SuggestingPromo }) {
  const dismissPromo = useAppStore((s) => s.dismissPromo);
  const { activate, dialog } = usePromoActivation(promo);

  return (
    <>
      <QuietSuggestionView
        suggestion={promo.content.suggestion}
        promoTitle={promo.content.title}
        onAccept={activate}
        onDismiss={() => dismissPromo(promo.id)}
      />
      {dialog}
    </>
  );
}

/**
 * DorkBot's single suggestion in a quiet room — the promo grid's successor.
 *
 * The retired dashboard promo grid asked four questions at once, on a surface
 * somebody had opened to do something else. This asks one, in the one place
 * where there is genuinely nothing else to read (team-room-home spec D5.3), and
 * only when the reader qualifies for it — see {@link useQuietSuggestion}.
 *
 * **Zero DOM when it has nothing to say**, including no wrapper: most mornings
 * the quiet state is one line, and an empty second line would put a gap under it
 * for no reason. The wiring sits in an inner component so that "nothing to say"
 * is a plain `null` rather than a hook called with a promo that does not exist.
 *
 * **Dismissal is the promo dismissal**, so waving it away here also takes the
 * matching card out of the sidebar. Saying no once should mean no everywhere,
 * and it is remembered across pages and restarts.
 *
 * It inherits the quiet state's own gates by living inside it: the host only
 * mounts this when the room is quiet, the reader is caught up, and the pinned
 * triage header has nothing waiting.
 */
export function QuietSuggestion() {
  const promo = useQuietSuggestion();
  if (promo === null) return null;
  return <WiredSuggestion key={promo.id} promo={promo} />;
}
