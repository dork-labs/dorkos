import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { AgentAvatar, AgentIdentity } from '@/layers/entities/agent';
import { Badge } from '@/layers/shared/ui/badge';

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

/** Agent identity primitive showcases: AgentAvatar, AgentIdentity. */
export function AgentIdentityShowcases() {
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
    </>
  );
}
