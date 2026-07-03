import { cn } from '@/layers/shared/lib';
import { getRuntimeDescriptor } from '../config/runtime-descriptors';
import { formatRuntimeIdentity } from '../lib/runtime-identity';

interface RuntimeIdentityProps {
  /** Runtime type identifier, e.g. `'opencode'`. Unknown types degrade to the neutral fallback. */
  runtime: string;
  /** The session's resolved model id, or nullish to show the runtime alone. */
  model?: string | null;
  /** Icon size in pixels. Ignored when `iconClassName` sets the size via CSS. */
  size?: number;
  className?: string;
  /** Classes for the icon — pass a `size-*` token to control sizing via CSS instead of `size`. */
  iconClassName?: string;
}

/**
 * Inline runtime + model identity: the descriptor icon followed by
 * "<runtime> · <model>" (or just the runtime when no model is resolved).
 *
 * The one shared presentation for a session's spelled-out identity, so the
 * status chip and any other surface read identically — the label text comes from
 * {@link formatRuntimeIdentity}, the icon from {@link getRuntimeDescriptor}.
 * Dense session-LIST rows use {@link RuntimeMark} instead (icon-only, with the
 * identity in its tooltip) so the list stays calm.
 */
export function RuntimeIdentity({
  runtime,
  model,
  size = 12,
  className,
  iconClassName,
}: RuntimeIdentityProps) {
  const Icon = getRuntimeDescriptor(runtime).icon;
  const { text } = formatRuntimeIdentity({ runtime, model });

  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      <Icon {...(iconClassName ? { className: iconClassName } : { size })} />
      <span>{text}</span>
    </span>
  );
}
