import { useState, type ComponentProps } from 'react';
import { AnimatePresence } from 'motion/react';
import { Bot, Radio } from 'lucide-react';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { MOCK_IDENTITIES } from '../mock-samples';
import {
  PathBreadcrumb,
  ScanLine,
  MarkdownContent,
  LinkifiedText,
  FeatureDisabledState,
  IdentityAvatar,
  ScrollArea,
  ScrollBar,
  Switch,
  Label,
  Input,
} from '@/layers/shared/ui';

/** Identities the avatar showcase draws: one with an emoji, one without. */
const IDENTITIES = [
  { color: '#6366f1', emoji: '🔍', name: 'code-reviewer' },
  { color: '#f59e0b', emoji: '🚀', name: 'deploy-bot' },
  { color: '#10b981', name: 'Priya' },
  { color: '#ef4444', name: 'You' },
] as const;

/**
 * One identity per `kind`, including the two a `human` can be — here and
 * bridged in from somewhere else. Every visible difference below comes from
 * `kind` and `origin`; no showcase row sets `shape`, `variant` or `badge`.
 */
const KIND_MATRIX: {
  label: string;
  kind: ComponentProps<typeof IdentityAvatar>['kind'];
  color: string;
  emoji?: string;
  fallback?: string;
  origin?: ComponentProps<typeof IdentityAvatar>['origin'];
}[] = [
  { label: 'agent', kind: 'agent', color: '#6366f1', emoji: '🔍' },
  { label: 'human · here', kind: 'human', color: '#10b981', fallback: 'P', origin: 'local' },
  {
    label: 'human · Telegram',
    kind: 'human',
    color: '#0ea5e9',
    fallback: 'M',
    origin: { platform: 'telegram' },
  },
  {
    label: 'human · elsewhere',
    kind: 'human',
    color: '#a855f7',
    fallback: 'J',
    origin: { platform: 'matrix' },
  },
  { label: 'system', kind: 'system', color: '#71717a', fallback: 'G' },
];

const SAMPLE_MARKDOWN = `## Agent Report

The deployment completed **successfully** across all environments.

### Key Metrics

- Sessions created: \`142\`
- Average latency: \`48ms\`
- Error rate: \`0.02%\`

\`\`\`typescript
const agent = await runtime.spawn({
  model: 'claude-opus-4-6',
  tools: ['bash', 'read', 'write'],
});
\`\`\`

> DorkOS coordinates. Agents deliver.
`;

/**
 * Strings for the {@link LinkifiedText} showcase — each one a shape the
 * component exists to handle, not decoration. The homograph and userinfo rows
 * are the anti-spoofing cases: they must render as a visibly different host
 * than the source string reads, or as no link at all.
 */
const LINKIFIED_SAMPLES = {
  provider:
    'This request requires more credits. Add credits at https://openrouter.ai/settings/credits and try again.',
  notMarkdown:
    'Parse failed at **line 12**: unexpected `}` in {"model": "gpt-5"} — see https://dorkos.ai/docs/errors',
  // U+043E CYRILLIC SMALL LETTER O in place of the Latin "o".
  homograph: 'Session expired. Sign in again at https://d\u043erkos.ai/settings',
  userinfo: 'Upload failed. Retry against https://dorkos.ai@evil.example/settings',
} as const;

/**
 * Data display component showcases: PathBreadcrumb, ScanLine, MarkdownContent,
 * LinkifiedText, FeatureDisabledState, ScrollArea, and {@link IdentityAvatarShowcase}.
 */
export function DataDisplayShowcases() {
  const [isStreaming, setIsStreaming] = useState(true);
  const [scanColor, setScanColor] = useState('#3b82f6');
  const [scanVisible, setScanVisible] = useState(true);
  const [scanFadeEdges, setScanFadeEdges] = useState(true);

  return (
    <>
      <PlaygroundSection
        title="PathBreadcrumb"
        description="Filesystem path displayed as clickable breadcrumb segments."
      >
        <ShowcaseLabel>Full path</ShowcaseLabel>
        <ShowcaseDemo>
          <PathBreadcrumb path="/Users/kai/projects/dork-os/apps/client" />
        </ShowcaseDemo>

        <ShowcaseLabel>Truncated (max 3 segments)</ShowcaseLabel>
        <ShowcaseDemo>
          <PathBreadcrumb
            path="/Users/kai/projects/dork-os/apps/client/src/layers"
            maxSegments={3}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Clickable segments</ShowcaseLabel>
        <ShowcaseDemo>
          <PathBreadcrumb path="/Users/kai/projects/dork-os" onSegmentClick={() => {}} />
        </ShowcaseDemo>

        <ShowcaseLabel>Small size</ShowcaseLabel>
        <ShowcaseDemo>
          <PathBreadcrumb path="/home/agent/.dork/sessions" size="sm" />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="ScanLine"
        description="Three-layer composited light scanner for agent streaming state."
      >
        <ShowcaseDemo>
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <Switch id="scan-visible" checked={scanVisible} onCheckedChange={setScanVisible} />
                <Label htmlFor="scan-visible">Visible</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="scan-streaming"
                  checked={isStreaming}
                  onCheckedChange={setIsStreaming}
                />
                <Label htmlFor="scan-streaming">Streaming</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="scan-fade-edges"
                  checked={scanFadeEdges}
                  onCheckedChange={setScanFadeEdges}
                />
                <Label htmlFor="scan-fade-edges">Fade edges</Label>
              </div>
              <div className="flex items-center gap-2">
                <Label htmlFor="scan-color">Color</Label>
                <Input
                  id="scan-color"
                  type="color"
                  value={scanColor}
                  onChange={(e) => setScanColor(e.target.value)}
                  className="h-8 w-12 cursor-pointer p-0.5"
                />
              </div>
            </div>
            <div className="bg-card relative h-12 overflow-hidden rounded-lg border">
              <div className="text-muted-foreground flex h-full items-center px-4 text-sm">
                Agent header area
              </div>
              <AnimatePresence>
                {scanVisible && (
                  <ScanLine
                    color={scanColor}
                    isTextStreaming={isStreaming}
                    fadeEdges={scanFadeEdges}
                  />
                )}
              </AnimatePresence>
            </div>
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="MarkdownContent"
        description="Static markdown rendering for non-chat content."
      >
        <ShowcaseDemo>
          <MarkdownContent content={SAMPLE_MARKDOWN} />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="LinkifiedText"
        description="Untrusted machine output — error messages — with bare http(s) URLs as real links, and nothing else interpreted."
      >
        <ShowcaseLabel>What it is for: a provider error whose one remedy is a URL</ShowcaseLabel>
        <ShowcaseDemo>
          <p className="text-muted-foreground text-sm">
            <LinkifiedText text={LINKIFIED_SAMPLES.provider} />
          </p>
        </ShowcaseDemo>

        <ShowcaseLabel>Markdown is NOT interpreted — the text is shown literally</ShowcaseLabel>
        <ShowcaseDemo>
          <p className="text-muted-foreground text-sm">
            <LinkifiedText text={LINKIFIED_SAMPLES.notMarkdown} />
          </p>
        </ShowcaseDemo>

        <ShowcaseLabel>
          Anti-spoofing: the label is the NORMALIZED destination. The host below reads
          &quot;dorkos.ai&quot; in the source string; a Cyrillic о makes it something else, and the
          link says so.
        </ShowcaseLabel>
        <ShowcaseDemo>
          <p className="text-muted-foreground text-sm">
            <LinkifiedText text={LINKIFIED_SAMPLES.homograph} />
          </p>
        </ShowcaseDemo>

        <ShowcaseLabel>
          A URL carrying credentials resolves to its LAST host, so it is refused and stays plain
          text
        </ShowcaseLabel>
        <ShowcaseDemo>
          <p className="text-muted-foreground text-sm">
            <LinkifiedText text={LINKIFIED_SAMPLES.userinfo} />
          </p>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="FeatureDisabledState"
        description="Empty state card shown when a subsystem is not enabled."
      >
        <ShowcaseDemo>
          <FeatureDisabledState
            icon={Radio}
            name="Relay"
            description="Inter-agent messaging requires the relay subsystem to be running."
            command="dorkos relay start"
          />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="ScrollArea"
        description="Custom scrollbar container for overflowing content."
      >
        <ShowcaseLabel>Vertical</ShowcaseLabel>
        <ShowcaseDemo>
          <ScrollArea className="h-48 w-full rounded-md border">
            <div className="p-4">
              {Array.from({ length: 20 }, (_, i) => (
                <div key={i} className="border-b py-2 text-sm">
                  Session {i + 1} — agent-{String(i + 1).padStart(3, '0')}
                </div>
              ))}
            </div>
          </ScrollArea>
        </ShowcaseDemo>

        <ShowcaseLabel>Horizontal</ShowcaseLabel>
        <ShowcaseDemo>
          <ScrollArea className="w-full rounded-md border whitespace-nowrap">
            <div className="flex gap-4 p-4">
              {Array.from({ length: 12 }, (_, i) => (
                <div
                  key={i}
                  className="bg-muted flex h-20 w-36 shrink-0 items-center justify-center rounded-md border text-sm"
                >
                  Agent {i + 1}
                </div>
              ))}
            </div>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        </ShowcaseDemo>
      </PlaygroundSection>

      <IdentityAvatarShowcase />
    </>
  );
}

/**
 * The one disc every identity is drawn as, in every state it has.
 *
 * Its own exported component because the Identity page renders it too — it is a
 * shared primitive first, so its registry entry stays on Components and its
 * `/dev/components#identityavatar` anchor with it (spec `identity-consistency`
 * §W4.2).
 */
export function IdentityAvatarShowcase() {
  return (
    <PlaygroundSection
      title="IdentityAvatar"
      description="The one disc every identity is drawn as — an agent, a person, whoever a direct message is with. Shows its emoji when it has one, its initial when it does not; circle or square, tinted or filled."
    >
      <ShowcaseLabel>Sizes</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex items-end gap-4">
          {(['xs', 'sm', 'md', 'lg'] as const).map((size) => (
            <div key={size} className="flex flex-col items-center gap-2">
              <IdentityAvatar color="#6366f1" emoji="🔍" size={size} />
              <IdentityAvatar color="#6366f1" fallback="R" size={size} />
              <span className="text-muted-foreground text-3xs">{size}</span>
            </div>
          ))}
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Badge — agents get the glyph, people get nothing</ShowcaseLabel>
      <ShowcaseDemo>
        {/* Every size, because the badge has to survive the smallest one:
              `xs` is a 20px disc and it is where most of these end up — a
              picker row, a sidebar line. If the mark is a smudge here it is
              unusable, whatever it looks like at `lg`. */}
        <div className="flex items-end gap-4">
          {(['xs', 'sm', 'md', 'lg'] as const).map((size) => (
            <div key={size} className="flex flex-col items-center gap-2">
              <IdentityAvatar color="#6366f1" emoji="🔍" size={size} badge={<Bot />} />
              <IdentityAvatar color="#10b981" fallback="P" size={size} />
              <span className="text-muted-foreground text-3xs">{size}</span>
            </div>
          ))}
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Both faces, side by side</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex items-center gap-3">
          {IDENTITIES.map((identity) => (
            <IdentityAvatar
              key={identity.name}
              color={identity.color}
              emoji={'emoji' in identity ? identity.emoji : undefined}
              fallback={identity.name[0]}
              size="md"
            />
          ))}
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Overlapping, as a room roster draws them</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex items-center -space-x-1.5">
          {IDENTITIES.map((identity) => (
            <IdentityAvatar
              key={identity.name}
              color={identity.color}
              emoji={'emoji' in identity ? identity.emoji : undefined}
              fallback={identity.name[0]}
              size="xs"
              className="border-background size-6 border"
            />
          ))}
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Three faces, in order — a photo, then an emoji, then a letter</ShowcaseLabel>
      <ShowcaseDemo>
        {/* The middle disc carries a photo AND an emoji, which is the case
              worth seeing: they are alternatives, not layers, and the photo
              wins. The right-hand pair shows the same identity as a person and
              as an agent, so the photo can be checked for inheriting the disc's
              radius rather than rounding a square back into a circle. */}
        <div className="flex items-end gap-4">
          {(
            [
              { label: 'photo', imageUrl: MOCK_IDENTITIES.photographed.imageUrl },
              {
                label: 'photo + emoji',
                imageUrl: MOCK_IDENTITIES.photographed.imageUrl,
                emoji: '🐙',
              },
              { label: 'emoji', emoji: '🐙' },
              { label: 'letter' },
              {
                label: 'photo, agent',
                imageUrl: MOCK_IDENTITIES.photographed.imageUrl,
                kind: 'agent' as const,
              },
              { label: 'photo gone', imageUrl: '/this-photo-is-not-there.png', emoji: '🐙' },
            ] as const
          ).map(({ label, ...identity }) => (
            <div key={label} className="flex flex-col items-center gap-2">
              <IdentityAvatar color="#0ea5e9" fallback="D" size="lg" {...identity} />
              <span className="text-muted-foreground text-3xs">{label}</span>
            </div>
          ))}
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Kind — one prop decides shape, fill and badge together</ShowcaseLabel>
      <ShowcaseDemo>
        {/* The four kinds as a caller writes them: `kind` and nothing else.
              Square is the agent shape, circle the person shape — a
              colourblind-safe distinction that survives without the badge. */}
        <div className="flex items-end gap-4">
          {KIND_MATRIX.map(({ label, ...identity }) => (
            <div key={label} className="flex flex-col items-center gap-2">
              <IdentityAvatar
                color={identity.color}
                emoji={identity.emoji}
                fallback={identity.fallback}
                kind={identity.kind}
                origin={identity.origin}
                size="md"
              />
              <span className="text-muted-foreground text-3xs">{label}</span>
            </div>
          ))}
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Kind at every size — the badge has to survive a 20px disc</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex items-end gap-4">
          {(['xs', 'sm', 'md', 'lg'] as const).map((size) => (
            <div key={size} className="flex flex-col items-center gap-2">
              {KIND_MATRIX.map(({ label, ...identity }) => (
                <IdentityAvatar
                  key={label}
                  color={identity.color}
                  emoji={identity.emoji}
                  fallback={identity.fallback}
                  kind={identity.kind}
                  origin={identity.origin}
                  size={size}
                />
              ))}
              <span className="text-muted-foreground text-3xs">{size}</span>
            </div>
          ))}
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Explicit props override the derivation, one axis at a time</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex items-end gap-4">
          <div className="flex flex-col items-center gap-2">
            <IdentityAvatar color="#6366f1" emoji="🔍" kind="agent" size="md" />
            <span className="text-muted-foreground text-3xs">kind only</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <IdentityAvatar color="#6366f1" emoji="🔍" kind="agent" shape="circle" size="md" />
            <span className="text-muted-foreground text-3xs">shape=&quot;circle&quot;</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <IdentityAvatar color="#6366f1" emoji="🔍" kind="agent" variant="tint" size="md" />
            <span className="text-muted-foreground text-3xs">variant=&quot;tint&quot;</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <IdentityAvatar color="#6366f1" emoji="🔍" kind="agent" badge={null} size="md" />
            <span className="text-muted-foreground text-3xs">badge={'{null}'}</span>
          </div>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Status — one corner, four states, and only one of them moves</ShowcaseLabel>
      <ShowcaseDemo>
        {/* Kind-agnostic on purpose: an agent mid-turn and a person mid-task
              are the same fact to a roster. The full state matrix lives on the
              Identity page; this row is the primitive's own corner. */}
        <div className="flex items-end gap-4">
          <div className="flex flex-col items-center gap-2">
            <IdentityAvatar color="#6366f1" emoji="🔍" kind="agent" status="working" size="md" />
            <span className="text-muted-foreground text-3xs">agent, working</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <IdentityAvatar color="#10b981" fallback="P" kind="human" status="working" size="md" />
            <span className="text-muted-foreground text-3xs">person, working</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <IdentityAvatar color="#6366f1" emoji="🔍" kind="agent" status="needs-you" size="md" />
            <span className="text-muted-foreground text-3xs">needs you</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <IdentityAvatar color="#6366f1" emoji="🔍" kind="agent" status="error" size="md" />
            <span className="text-muted-foreground text-3xs">error</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <IdentityAvatar color="#6366f1" emoji="🔍" kind="agent" status="working" size="xs" />
            <span className="text-muted-foreground text-3xs">xs</span>
          </div>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Square at every size — the radius steps with the diameter so it never clamps to a circle at
        xs/sm
      </ShowcaseLabel>
      <ShowcaseDemo>
        {/* The compound-variant radius table only earns its keep at xs/sm: a
              fixed radius sized for `lg` clamps to a full circle on a 20px `xs`
              disc, erasing the shape distinction exactly where the design calls
              it dominant. Circle sits alongside square at every size so the
              difference stays visible, not just present. */}
        <div className="flex items-end gap-4">
          {(['xs', 'sm', 'md', 'lg'] as const).map((size) => (
            <div key={size} className="flex flex-col items-center gap-2">
              <div className="flex items-end gap-2">
                <IdentityAvatar
                  color="#6366f1"
                  emoji="🔍"
                  shape="square"
                  size={size}
                  badge={<Bot />}
                />
                <IdentityAvatar color="#10b981" fallback="P" shape="circle" size={size} />
              </div>
              <span className="text-muted-foreground text-3xs">{size}</span>
            </div>
          ))}
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Fill variant — the solid disc, and the fallback letter picking its own contrast
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex items-end gap-4">
          <div className="flex flex-col items-center gap-2">
            <IdentityAvatar color="#6366f1" emoji="🔍" variant="fill" shape="square" size="lg" />
            <span className="text-muted-foreground text-3xs">emoji fill</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <IdentityAvatar color="#fde68a" fallback="R" variant="fill" shape="square" size="lg" />
            <span className="text-muted-foreground text-3xs">light fill → dark letter</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <IdentityAvatar color="#1e1b4b" fallback="R" variant="fill" shape="square" size="lg" />
            <span className="text-muted-foreground text-3xs">dark fill → light letter</span>
          </div>
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
