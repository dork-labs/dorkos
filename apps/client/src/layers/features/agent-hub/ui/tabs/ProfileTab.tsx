import { useState, useCallback } from 'react';
import { Folder, Plus, X } from 'lucide-react';
import { shortenHomePath } from '@/layers/shared/lib';
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/layers/shared/ui';
import { useSessions } from '@/layers/entities/session';
import { useRuntimeCapabilities } from '@/layers/entities/runtime';
import { useAgentHubContext } from '../../model/agent-hub-context';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

/** Display labels for known runtime types. */
const RUNTIME_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  codex: 'Codex',
  windsurf: 'Windsurf',
  gemini: 'Gemini',
  cline: 'Cline',
  'roo-code': 'Roo Code',
  copilot: 'Copilot',
  'amazon-q': 'Amazon Q',
  continue: 'Continue',
  augment: 'Augment',
  'jetbrains-ai': 'JetBrains AI',
  'kilo-code': 'Kilo Code',
  trae: 'Trae',
  other: 'Other',
  mock: 'Mock Runtime',
};

/** Retrieve agent's tags from the manifest (field is not in base schema). */
function getAgentTags(agent: AgentManifest): string[] {
  return ((agent as Record<string, unknown>).tags as string[] | undefined) ?? [];
}

/**
 * Profile tab for the Agent Hub panel.
 *
 * Renders editable agent identity fields: display name, description,
 * runtime selector, directory path, tags, and session/channel/task stats.
 */
export function ProfileTab() {
  const { agent, projectPath, onUpdate } = useAgentHubContext();
  const { sessions } = useSessions();
  const { data: capData } = useRuntimeCapabilities();
  const availableRuntimes = capData ? Object.keys(capData.capabilities) : [agent.runtime];

  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [newTag, setNewTag] = useState('');
  const [showTagInput, setShowTagInput] = useState(false);

  const agentSessions = sessions.filter((s) => s.cwd === projectPath);

  const startEditing = useCallback((field: string, currentValue: string) => {
    setEditingField(field);
    setEditValue(currentValue);
  }, []);

  const commitEdit = useCallback(
    (field: string) => {
      if (editValue.trim()) {
        onUpdate({ [field]: editValue.trim() } as Partial<AgentManifest>);
      }
      setEditingField(null);
    },
    [editValue, onUpdate]
  );

  const handleAddTag = useCallback(() => {
    const trimmed = newTag.trim();
    if (!trimmed) return;
    const currentTags = getAgentTags(agent);
    if (!currentTags.includes(trimmed)) {
      onUpdate({ tags: [...currentTags, trimmed] } as unknown as Partial<AgentManifest>);
    }
    setNewTag('');
    setShowTagInput(false);
  }, [newTag, agent, onUpdate]);

  const handleRemoveTag = useCallback(
    (tag: string) => {
      const currentTags = getAgentTags(agent);
      onUpdate({
        tags: currentTags.filter((t) => t !== tag),
      } as unknown as Partial<AgentManifest>);
    },
    [agent, onUpdate]
  );

  const displayName = agent.displayName ?? agent.name;
  const tags = getAgentTags(agent);

  return (
    <div className="space-y-4 p-4">
      {/* Display Name */}
      <div className="space-y-1">
        <div className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
          Display Name
        </div>
        {editingField === 'displayName' ? (
          <Input
            autoFocus
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={() => commitEdit('displayName')}
            onKeyDown={(e) => e.key === 'Enter' && commitEdit('displayName')}
            className="h-8 text-sm"
          />
        ) : (
          <button
            type="button"
            className="hover:bg-accent w-full rounded-md px-2 py-1 text-left text-sm transition-colors"
            onClick={() => startEditing('displayName', displayName)}
          >
            {displayName}
          </button>
        )}
      </div>

      {/* Description */}
      <div className="space-y-1">
        <div className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
          Description
        </div>
        {editingField === 'description' ? (
          <textarea
            autoFocus
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={() => commitEdit('description')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) commitEdit('description');
            }}
            className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            rows={3}
          />
        ) : (
          <button
            type="button"
            className="hover:bg-accent text-muted-foreground w-full rounded-md px-2 py-1 text-left text-sm transition-colors"
            onClick={() => startEditing('description', agent.description ?? '')}
          >
            {agent.description || 'Add a description...'}
          </button>
        )}
      </div>

      {/* Agent Runtime */}
      <div className="space-y-1">
        <div className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
          Agent Runtime
        </div>
        <Select
          value={agent.runtime ?? 'claude-code'}
          onValueChange={(v) => onUpdate({ runtime: v } as Partial<AgentManifest>)}
        >
          <SelectTrigger className="h-8 text-sm" responsive={false}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {availableRuntimes.map((type) => (
              <SelectItem key={type} value={type} responsive={false}>
                {RUNTIME_LABELS[type] ?? type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Directory */}
      <div className="space-y-1">
        <div className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
          Directory
        </div>
        <div className="text-muted-foreground flex items-center gap-1.5 rounded-md px-2 py-1">
          <Folder className="size-3.5 shrink-0" />
          <span className="font-mono text-xs">{shortenHomePath(projectPath)}</span>
        </div>
      </div>

      {/* Tags */}
      <div className="space-y-1">
        <div className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
          Tags
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {tags.map((tag) => (
            <span
              key={tag}
              className="bg-accent text-accent-foreground inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs"
            >
              {tag}
              <button
                type="button"
                onClick={() => handleRemoveTag(tag)}
                className="hover:text-destructive transition-colors"
                aria-label={`Remove tag ${tag}`}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          {showTagInput ? (
            <Input
              autoFocus
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onBlur={handleAddTag}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddTag();
                if (e.key === 'Escape') setShowTagInput(false);
              }}
              className="h-6 w-24 text-xs"
              placeholder="tag name"
            />
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowTagInput(true)}
              className="text-muted-foreground hover:text-foreground h-auto gap-0.5 px-1 py-0 text-xs"
            >
              <Plus className="size-3" /> Add
            </Button>
          )}
        </div>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-3 gap-2">
        <div className="bg-accent/50 rounded-lg p-3 text-center">
          <div className="text-lg font-semibold">{agentSessions.length}</div>
          <div className="text-muted-foreground text-[10px]">Sessions</div>
        </div>
        <div className="bg-accent/50 rounded-lg p-3 text-center">
          <div className="text-lg font-semibold">—</div>
          <div className="text-muted-foreground text-[10px]">Channels</div>
        </div>
        <div className="bg-accent/50 rounded-lg p-3 text-center">
          <div className="text-lg font-semibold">—</div>
          <div className="text-muted-foreground text-[10px]">Tasks</div>
        </div>
      </div>
    </div>
  );
}
