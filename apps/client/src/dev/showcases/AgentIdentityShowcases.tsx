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
import { IDENTITY_STATUSES, MOCK_IDENTITIES, type MockIdentity } from '../mock-samples';

const AUTO_COLOR = 'hsl(255, 70%, 55%)';
const AUTO_EMOJI = '🤖';
/** Matches `AvatarPickerPanel`'s own burst duration (`showCheckmark`). */
const JUST_SELECTED_MS = 600;

/**
 * Demo state for one `AvatarColorGrid` + `AvatarEmojiGrid` pair — enough to
 * drive the grids without the real `IdentityTab` / `AvatarPickerPanel`
 * data context they normally sit inside. `justSelected` mirrors
 * `AvatarPickerPanel`'s own `showCheckmark`: a momentary key, not one
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

/**
 * One cast member, as the agent-entity components take it.
 *
 * `AgentAvatar` asks for a colour and an emoji outright, because those two ARE
 * an agent's identity language — so the two fallbacks here stand in for the
 * auto-generated pair a real agent gets on registration, not for anything the
 * product leaves blank.
 */
function agentFace(identity: MockIdentity): { color: string; emoji: string; name: string } {
  return {
    color: identity.color ?? AUTO_COLOR,
    emoji: identity.emoji ?? AUTO_EMOJI,
    name: identity.displayName,
  };
}

/** The one agent most demos below draw. */
const WARDEN = agentFace(MOCK_IDENTITIES.warden);

/** Four of them, for the rows that need more than one face at a time. */
const CAST = [
  MOCK_IDENTITIES.warden,
  MOCK_IDENTITIES.scout,
  MOCK_IDENTITIES.courier,
  MOCK_IDENTITIES.externalFlag,
].map(agentFace);

/**
 * Agent identity primitive showcases: AgentAvatar, AgentIdentity, AvatarPickerGrid.
 *
 * Every face here comes from `MOCK_IDENTITIES` — the same cast the mention pill,
 * the hover card and the shape matrix draw — so an identity state is defined
 * once and the showcases cannot disagree about what an agent looks like.
 */
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
                <AgentAvatar {...WARDEN} size={size} />
                <span className="text-muted-foreground text-3xs">{size}</span>
              </div>
            ))}
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Multiple agents</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex gap-3">
            {CAST.map((a) => (
              <AgentAvatar key={a.name} {...a} size="md" />
            ))}
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>
          Status — the top-right corner, and the only thing that goes there
        </ShowcaseLabel>
        <ShowcaseDemo>
          {/* Mesh health is NOT here, and that is the point: the disc used to
              wear a coloured ring keyed on "seen within the last hour" and a
              pulsing dot lit from the same fact. The corner reports what the
              agent is doing right now; health is said in words, on the two
              surfaces that need it (the profile header, the topology page). */}
          <div className="flex items-center gap-6">
            {IDENTITY_STATUSES.map(({ status, label }) => (
              <div key={status} className="flex flex-col items-center gap-2">
                <AgentAvatar {...WARDEN} size="md" status={status} />
                <span className="text-muted-foreground text-3xs">{label}</span>
              </div>
            ))}
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
                <span className="text-muted-foreground text-3xs w-6">{size}</span>
                <AgentIdentity {...WARDEN} size={size} />
              </div>
            ))}
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Sizes (with detail)</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-col gap-4">
            {(['xs', 'sm', 'md', 'lg'] as const).map((size) => (
              <div key={size} className="flex items-center gap-4">
                <span className="text-muted-foreground text-3xs w-6">{size}</span>
                <AgentIdentity
                  {...WARDEN}
                  size={size}
                  detail={
                    <span className="flex items-center gap-1">
                      <Badge size="xs" variant="secondary">
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

        <ShowcaseLabel>With live status</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-col gap-3">
            <AgentIdentity {...CAST[0]} size="sm" status="working" detail="mid-turn, 2m 14s" />
            <AgentIdentity {...CAST[1]} size="sm" status="needs-you" detail="waiting on approval" />
            <AgentIdentity {...CAST[2]} size="sm" status="error" detail="last turn failed" />
            <AgentIdentity {...CAST[3]} size="sm" detail="nothing to report" />
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Edge cases</ShowcaseLabel>
        <ShowcaseDemo>
          {/* The pale-fill case (`noEmojiFill`, where the fallback letter has to
              pick its own contrast) is deliberately NOT here: `AgentAvatar` has
              no fallback slot at all — an agent's identity language is its emoji
              and its colour — so this row would substitute the auto emoji and
              show a case it cannot actually reach. It is drawn where it is real,
              on IdentityAvatar's fill-variant row. */}
          <div className="flex flex-col gap-3">
            {/* Width-constrained on purpose, and `w-full` is load-bearing.
                A long name in a full-width demo simply fits — measured at 471px
                of text in 471px of box — so the row that exists to prove
                truncation proved nothing. A narrow box alone is still not
                enough: `AgentIdentity`'s root is `inline-flex`, so it sizes to
                its content and overflows a narrower parent instead of shrinking
                into it. The `min-w-0` truncation inside it only engages once the
                root has a width of its own, which is the usage note a caller
                needs and the reason this row is shaped like this. */}
            <div className="w-64 rounded-md border p-2">
              <AgentIdentity
                {...agentFace(MOCK_IDENTITIES.longHandle)}
                size="sm"
                detail="very long detail text that should also truncate nicely"
                className="w-full"
              />
            </div>
            <AgentIdentity {...agentFace(MOCK_IDENTITIES.courier)} size="sm" />
            <AgentIdentity
              {...agentFace(MOCK_IDENTITIES.multiCodepointEmoji)}
              size="sm"
              detail="a ZWJ emoji, and an HSL colour behind it"
              color="hsl(280, 60%, 55%)"
            />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="AvatarPickerGrid"
        description="The color-swatch and emoji grids shared by every avatar picker (IdentityTab, AvatarPickerPanel) — collapsed to one implementation in DOR-970. The two containers around it stay different: a plain settings-form popover vs. a celebratory panel with hover preview and a selection burst."
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

        <ShowcaseLabel>Celebratory container (the AvatarPickerPanel)</ShowcaseLabel>
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
