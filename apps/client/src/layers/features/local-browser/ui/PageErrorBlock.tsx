import {
  Ban,
  Bug,
  Repeat,
  SearchX,
  ShieldAlert,
  ShieldX,
  Unplug,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import type { PageErrorKind } from '@dorkos/shared/local-browser-page-error';
import { Button } from '@/layers/shared/ui';
import type { PageErrorAction, PageErrorBlockCopy } from '../lib/page-error';

const ICONS: Record<PageErrorKind, LucideIcon> = {
  'name-not-found': SearchX,
  'no-response': Unplug,
  offline: WifiOff,
  certificate: ShieldAlert,
  'blocked-by-dorkos': Ban,
  'blocked-by-policy': ShieldX,
  'too-many-redirects': Repeat,
  crashed: Bug,
};

/** Props for {@link PageErrorBlock}. */
interface PageErrorBlockProps {
  /** The block to draw, from `pageErrorBlock`. */
  block: PageErrorBlockCopy;
  /** Runs a button's action. */
  onAction: (action: PageErrorAction) => void;
  /** Disables the buttons while the page is busy elsewhere. */
  disabled?: boolean;
}

/**
 * A failed page load, drawn by DorkOS in the page area (DOR-4430, spec DOR-4420 §8): centred,
 * at most 320px, a muted icon, the title, one muted line, one main button and at most one more.
 */
export function PageErrorBlock({ block, onAction, disabled = false }: PageErrorBlockProps) {
  const Icon = ICONS[block.kind];
  return (
    <div
      role="alert"
      data-slot="browser-page-error"
      data-kind={block.kind}
      className="m-auto flex w-full max-w-80 flex-col items-center gap-2 text-center"
    >
      <Icon aria-hidden className="text-muted-foreground size-5" />
      <p className="text-sm font-medium break-words">{block.title}</p>
      <p className="text-muted-foreground text-sm">{block.line}</p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
        <Button size="sm" disabled={disabled} onClick={() => onAction(block.primary.action)}>
          {block.primary.label}
        </Button>
        {block.secondary && (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onAction(block.secondary!.action)}
          >
            {block.secondary.label}
          </Button>
        )}
      </div>
    </div>
  );
}
