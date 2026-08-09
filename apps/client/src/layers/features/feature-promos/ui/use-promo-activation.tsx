import { useCallback, useState, type ReactNode } from 'react';
import { openLink } from '@/layers/shared/lib';
import type { PromoDefinition } from '../model/promo-types';
import { PromoDialog } from './PromoDialog';

/** What a surface needs to make a promo's CTA do its thing. */
export interface PromoActivation {
  /** Run the promo's action — open its dialog, follow its link, call its handler. */
  activate: () => void;
  /** The dialog this promo opens, mounted alongside whatever the surface drew. */
  dialog: ReactNode;
}

/**
 * The promo action, wired: press it, and the right thing happens.
 *
 * Two surfaces press the same four kinds of action — the card in a promo slot
 * and the one line in the quiet state on home — and neither should own its own
 * copy of the switch. A promo that changes from a dialog to a link changes in
 * one place, and both surfaces follow.
 *
 * @param promo - The promo whose action is being offered.
 * @returns Its {@link PromoActivation}.
 */
export function usePromoActivation(promo: PromoDefinition): PromoActivation {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { action } = promo;

  const activate = useCallback(() => {
    switch (action.type) {
      case 'dialog':
      case 'open-dialog':
        setDialogOpen(true);
        return;
      case 'navigate':
        openLink(action.to);
        return;
      case 'action':
        action.handler();
        return;
      default: {
        // A fifth PromoAction member becomes a type error here rather than a
        // press that silently does nothing.
        const exhaustive: never = action;
        throw new Error(`Unhandled promo action: ${JSON.stringify(exhaustive)}`);
      }
    }
  }, [action]);

  const dialog =
    action.type === 'dialog' ? (
      <PromoDialog promo={promo} open={dialogOpen} onOpenChange={setDialogOpen} />
    ) : action.type === 'open-dialog' ? (
      <action.component open={dialogOpen} onOpenChange={setDialogOpen} />
    ) : null;

  return { activate, dialog };
}
