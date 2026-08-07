import { useCallback, useRef, useState } from 'react';
import { Wand2 } from 'lucide-react';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import {
  AgentAvatar,
  AgentIdentity,
  AvatarColorGrid,
  AvatarEmojiGrid,
} from '@/layers/entities/agent';
import { Badge } from '@/layers/shared/ui/badge';

const AUTO_COLOR = 'hsl(255, 70%, 55%)';
const AUTO_EMOJI = '🤖';
/** Matches `AvatarPickerPopover`'s own burst duration (`showCheckmark`). */
const JUST_SELECTED_MS = 600;

/**
 * Demo state for one `AvatarColorGrid` + `AvatarEmojiGrid` pair — enough to
 * drive the grids without the real `IdentityTab` / `AvatarPickerPopover`
 * data context they normally sit inside. `justSelected` mirrors
 * `AvatarPickerPopover`'s own `showCheckmark`: a momentary key, not one
 * bound to the current selection, so the checkmark burst fires once and
 * clears rather than sitting lit forever on whatever is picked.
 */
function useAvatarPickerDemoState() {
  const [color, setColor] = useState<string | null>(null);
  const [icon, setIcon] = useState<string | null>(null);
  const [justSelected, setJustSelected] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showCheckmark = useCallback((key: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setJustSelected(key);
    timerRef.current = setTimeout(() => setJustSelected(null), JUST_SELECTED_MS);
  }, []);

  return {
    color,
    icon,
    justSelected,
    activeEmoji: icon ?? AUTO_EMOJI,
    onSelectColor: (hex: string | null) => {
      setColor(hex);
      showCheckmark(hex ?? 'auto');
    },
    onSelectIcon: (emoji: string) => {
      const value = emoji === AUTO_EMOJI ? null : emoji;
      setIcon(value);
      showCheckmark(`emoji-${emoji}`);
    },
  };
}

const SAMPLE = {
  color: '#6366f1',
  emoji: '🔍',
  name: 'code-reviewer',
} as const;

const AGENTS = [
  { color: '#6366f1', emoji: '🔍', name: 'code-reviewer' },
  { color: '#f59e0b', emoji: '🚀', name: 'deploy-bot' },
  { color: '#10b981', emoji: '🧪', name: 'test-runner' },
  { color: '#ef4444', emoji: '🔥', name: 'incident-responder' },
] as const;

/** Agent identity primitive showcases: AgentAvatar, AgentIdentity, AvatarPickerGrid. */
export function AgentIdentityShowcases() {
  const plainPicker = useAvatarPickerDemoState();
  const celebratoryPicker = useAvatarPickerDemoState();

  return (
    <>
      <PlaygroundSection
        title="AgentAvatar"
        description="Visual mark for an agent — colored circle with centered emoji. Sizes: xs, sm, md, lg."
      >
        <ShowcaseLabel>Sizes</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex items-end gap-4">
            {(['xs', 'sm', 'md', 'lg'] as const).map((size) => (
              <div key={size} className="flex flex-col items-center gap-2">
                <AgentAvatar {...SAMPLE} size={size} />
                <span className="text-muted-foreground text-[10px]">{size}</span>
              </div>
            ))}
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Multiple agents</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex gap-3">
            {AGENTS.map((a) => (
              <AgentAvatar key={a.name} {...a} size="md" />
            ))}
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Health status</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex items-center gap-6">
            {(['active', 'inactive', 'stale', 'unreachable'] as const).map((status) => (
              <div key={status} className="flex flex-col items-center gap-2">
                <AgentAvatar {...SAMPLE} size="md" healthStatus={status} />
                <span className="text-muted-foreground text-[10px]">{status}</span>
              </div>
            ))}
            <div className="flex flex-col items-center gap-2">
              <AgentAvatar {...SAMPLE} size="md" />
              <span className="text-muted-foreground text-[10px]">none</span>
            </div>
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="AgentIdentity"
        description="Composed agent display — avatar + name + optional detail. Analogous to a user card."
      >
        <ShowcaseLabel>Sizes (no detail)</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-col gap-4">
            {(['xs', 'sm', 'md', 'lg'] as const).map((size) => (
              <div key={size} className="flex items-center gap-4">
                <span className="text-muted-foreground w-6 text-[10px]">{size}</span>
                <AgentIdentity {...SAMPLE} size={size} />
              </div>
            ))}
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Sizes (with detail)</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-col gap-4">
            {(['xs', 'sm', 'md', 'lg'] as const).map((size) => (
              <div key={size} className="flex items-center gap-4">
                <span className="text-muted-foreground w-6 text-[10px]">{size}</span>
                <AgentIdentity
                  {...SAMPLE}
                  size={size}
                  detail={
                    <span className="flex items-center gap-1">
                      <Badge variant="secondary" className="text-[10px]">
                        claude-code
                      </Badge>
                      <span>3m ago</span>
                    </span>
                  }
                />
              </div>
            ))}
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>With health status</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-col gap-3">
            <AgentIdentity
              {...AGENTS[0]}
              size="sm"
              healthStatus="active"
              detail="3 active sessions"
            />
            <AgentIdentity {...AGENTS[1]} size="sm" healthStatus="inactive" detail="idle 2h" />
            <AgentIdentity
              {...AGENTS[2]}
              size="sm"
              healthStatus="stale"
              detail="last seen 3d ago"
            />
            <AgentIdentity
              {...AGENTS[3]}
              size="sm"
              healthStatus="unreachable"
              detail="lost contact"
            />
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Edge cases</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-col gap-3">
            <AgentIdentity
              color="#6366f1"
              emoji="🤖"
              name="extremely-long-agent-name-that-should-truncate-gracefully-in-the-ui"
              size="sm"
              detail="very long detail text that should also truncate nicely"
            />
            <AgentIdentity color="#888" emoji="❓" name="no-detail" size="sm" />
            <AgentIdentity
              color="hsl(280, 60%, 55%)"
              emoji="🎨"
              name="hsl-color"
              size="sm"
              detail="HSL color input"
            />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="AvatarPickerGrid"
        description="The color-swatch and emoji grids shared by every avatar picker (IdentityTab, AvatarPickerPopover) — collapsed to one implementation in DOR-970. The two containers around it stay different: a plain settings-form popover vs. a celebratory panel with hover preview and a selection burst."
      >
        <ShowcaseLabel>Plain container (the IdentityTab popover)</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap items-start gap-4">
            <div className="w-auto rounded-md border p-3">
              <AvatarColorGrid
                value={plainPicker.color}
                autoColor={AUTO_COLOR}
                onSelect={plainPicker.onSelectColor}
              />
            </div>
            <div className="w-64 rounded-md border p-3">
              <AvatarEmojiGrid
                value={plainPicker.activeEmoji}
                autoEmoji={AUTO_EMOJI}
                hasOverride={plainPicker.icon != null}
                onSelect={plainPicker.onSelectIcon}
              />
            </div>
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Celebratory container (the AvatarPickerPopover panel)</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap items-start gap-4">
            <div className="w-auto rounded-md border p-3">
              <AvatarColorGrid
                value={celebratoryPicker.color}
                autoColor={AUTO_COLOR}
                onSelect={celebratoryPicker.onSelectColor}
                onHoverChange={() => {}}
                justSelectedKey={celebratoryPicker.justSelected}
                celebratory
                autoIcon={<Wand2 className="size-3" />}
                autoActiveRing="ring-muted-foreground/50 ring-2 ring-offset-2"
                autoLabel="Select unique auto-generated color"
              />
            </div>
            <div className="w-64 rounded-md border p-3">
              <AvatarEmojiGrid
                value={celebratoryPicker.activeEmoji}
                autoEmoji={AUTO_EMOJI}
                hasOverride={celebratoryPicker.icon != null}
                onSelect={celebratoryPicker.onSelectIcon}
                justSelectedKey={celebratoryPicker.justSelected}
                celebratory
              />
            </div>
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}
