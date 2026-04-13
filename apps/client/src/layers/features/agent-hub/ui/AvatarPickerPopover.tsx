import { useCallback, useMemo } from 'react';
import { X } from 'lucide-react';
import { cn, EMOJI_SET, hashToHslColor, hashToEmoji } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';
import { useAgentHubContext } from '../model/agent-hub-context';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

/** Maps each color preset to a human-readable name for accessibility. */
const COLOR_PRESETS: { hex: string; name: string }[] = [
  { hex: '#ef4444', name: 'Red' },
  { hex: '#f97316', name: 'Orange' },
  { hex: '#eab308', name: 'Yellow' },
  { hex: '#22c55e', name: 'Green' },
  { hex: '#06b6d4', name: 'Cyan' },
  { hex: '#3b82f6', name: 'Blue' },
  { hex: '#6366f1', name: 'Indigo' },
  { hex: '#a855f7', name: 'Purple' },
  { hex: '#ec4899', name: 'Pink' },
  { hex: '#78716c', name: 'Stone' },
];

interface AvatarPickerPanelProps {
  onClose: () => void;
}

/**
 * Full-width inline panel for picking agent color and emoji icon.
 * Rendered in the tab content area when the avatar is clicked.
 */
export function AvatarPickerPanel({ onClose }: AvatarPickerPanelProps) {
  const { agent, onUpdate } = useAgentHubContext();

  const autoColor = useMemo(() => hashToHslColor(agent.id), [agent.id]);
  const autoEmoji = useMemo(() => hashToEmoji(agent.id), [agent.id]);
  const activeEmoji = agent.icon ?? autoEmoji;
  const hasColorOverride = agent.color != null;
  const hasIconOverride = agent.icon != null;
  const hasAnyOverride = hasColorOverride || hasIconOverride;

  const handleResetDefaults = useCallback(() => {
    onUpdate({ color: null, icon: null } as unknown as Partial<AgentManifest>);
  }, [onUpdate]);

  const handleColorSelect = useCallback(
    (hex: string | null) => {
      onUpdate({ color: hex } as unknown as Partial<AgentManifest>);
    },
    [onUpdate]
  );

  const handleIconSelect = useCallback(
    (emoji: string) => {
      onUpdate({ icon: emoji === autoEmoji ? null : emoji } as unknown as Partial<AgentManifest>);
    },
    [onUpdate, autoEmoji]
  );

  return (
    <div className="flex flex-1 flex-col overflow-auto" data-testid="avatar-picker-panel">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-2">
        <span className="text-xs font-semibold">Appearance</span>
        <div className="flex items-center gap-1">
          {hasAnyOverride && (
            <button
              type="button"
              onClick={handleResetDefaults}
              className="text-muted-foreground hover:text-foreground text-[10px] transition-colors"
            >
              Reset to defaults
            </button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={onClose}
            aria-label="Close appearance picker"
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="space-y-5 p-4">
        {/* Color swatches */}
        <div>
          <div className="text-muted-foreground mb-2 text-[10px] font-medium tracking-wider uppercase">
            Color
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Auto-derived color */}
            <button
              type="button"
              onClick={() => handleColorSelect(null)}
              className={cn(
                'relative size-8 rounded-full transition-all duration-150',
                !hasColorOverride
                  ? 'ring-muted-foreground/50 ring-dashed ring-2 ring-offset-2'
                  : 'hover:scale-110'
              )}
              style={{ backgroundColor: autoColor }}
              aria-label="Select default color"
            >
              <span className="bg-background/80 text-foreground absolute inset-0 flex items-center justify-center rounded-full text-[9px] leading-none font-bold">
                A
              </span>
            </button>

            <div className="bg-border mx-0.5 h-5 w-px" />

            {COLOR_PRESETS.map((c) => (
              <button
                key={c.hex}
                type="button"
                onClick={() => handleColorSelect(c.hex)}
                className={cn(
                  'size-8 rounded-full transition-all duration-150',
                  agent.color === c.hex ? 'ring-foreground ring-2 ring-offset-2' : 'hover:scale-110'
                )}
                style={{ backgroundColor: c.hex }}
                aria-label={`Select ${c.name}`}
              />
            ))}
          </div>
        </div>

        {/* Emoji grid */}
        <div>
          <div className="text-muted-foreground mb-2 text-[10px] font-medium tracking-wider uppercase">
            Icon
          </div>
          <div className="grid grid-cols-6 gap-1.5">
            {EMOJI_SET.map((emoji) => {
              const isActive = emoji === activeEmoji;
              const isAutoDefault = emoji === autoEmoji && !agent.icon;
              return (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => handleIconSelect(emoji)}
                  className={cn(
                    'flex size-9 items-center justify-center rounded-md text-lg transition-all duration-150',
                    isActive
                      ? isAutoDefault
                        ? 'bg-accent ring-muted-foreground/50 ring-dashed ring-1'
                        : 'bg-accent ring-foreground ring-1'
                      : 'hover:bg-accent/50'
                  )}
                  aria-label={`Select icon ${emoji}`}
                >
                  {emoji}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
