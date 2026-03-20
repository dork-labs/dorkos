import { useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { Radio } from 'lucide-react';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import {
  PathBreadcrumb,
  ScanLine,
  MarkdownContent,
  FeatureDisabledState,
  ScrollArea,
  ScrollBar,
  Switch,
  Label,
  Input,
} from '@/layers/shared/ui';

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

/** Data display component showcases: PathBreadcrumb, ScanLine, MarkdownContent, FeatureDisabledState, ScrollArea. */
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
    </>
  );
}
