import { cn } from '@/layers/shared/lib';
import { ContributedIcon, IdentityAvatar } from '@/layers/shared/ui';
import type { TabIcon } from '../lib/tab-identity';

interface TabIdentityIconProps {
  /** The glyph to draw, from the tab's identity. */
  icon: TabIcon;
  /** Extra classes for the glyph. */
  className?: string;
}

/**
 * A page's glyph: an agent's emoji, a person or agent disc, an extension's own
 * icon, or the route's icon. Shared by the tab strip, its hover card and the
 * History menu, so a page looks the same in all three. Decoration only: the
 * name beside it is what a screen reader reads.
 */
export function TabIdentityIcon({ icon, className }: TabIdentityIconProps) {
  switch (icon.kind) {
    case 'emoji':
      return (
        <span aria-hidden="true" className={cn('shrink-0 text-sm leading-none', className)}>
          {icon.emoji}
        </span>
      );
    case 'face':
      return (
        <IdentityAvatar
          aria-hidden="true"
          size="xs"
          kind={icon.face.kind}
          color={icon.face.color}
          emoji={icon.face.emoji}
          imageUrl={icon.face.imageUrl}
          fallback={icon.face.fallback}
          badge={null}
          className={cn('size-4 shrink-0 text-[10px]', className)}
        />
      );
    case 'extension':
      // An extension's icon, guarded: a bad one costs the glyph, not the tab.
      return <ContributedIcon icon={icon.icon} className={cn('size-3.5 shrink-0', className)} />;
    case 'route': {
      const { Icon } = icon;
      return <Icon aria-hidden="true" className={cn('size-3.5 shrink-0', className)} />;
    }
  }
}
