import { ContributedIcon } from '@/layers/shared/ui';
import type { TabTargetView } from '../model/use-tab-target';

interface TabTargetIconProps {
  /** The resolved page, from `useTabTarget`. */
  view: TabTargetView;
}

/**
 * The glyph for a page: its agent's emoji, an extension's own icon, or the
 * route's icon — in that order. Shared by the tab strip and the History menu so
 * a page looks the same in both.
 */
export function TabTargetIcon({ view }: TabTargetIconProps) {
  if (view.emoji !== null) {
    return (
      <span aria-hidden="true" className="shrink-0 text-sm leading-none">
        {view.emoji}
      </span>
    );
  }
  if (view.extensionIcon !== null) {
    // An extension's icon, guarded: a bad one costs the glyph, not the row.
    return <ContributedIcon icon={view.extensionIcon} className="size-3.5 shrink-0" />;
  }
  const { Icon } = view;
  return <Icon className="size-3.5 shrink-0" />;
}
