import { useState, useCallback, useRef, useEffect } from 'react';
import { cn, EMOJI_SET } from '@/layers/shared/lib';
import {
  FieldCard,
  FieldCardContent,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/layers/shared/ui';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

const COLOR_PRESETS = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#06b6d4',
  '#3b82f6',
  '#6366f1',
  '#a855f7',
  '#ec4899',
  '#78716c',
];

const DEBOUNCE_MS = 500;

interface IdentityTabProps {
  agent: AgentManifest;
  projectPath: string;
  onUpdate: (updates: Partial<AgentManifest>) => void;
}

/**
 * Identity form with name, description, color picker, emoji picker, and runtime dropdown.
 */
export function IdentityTab({ agent, projectPath: _projectPath, onUpdate }: IdentityTabProps) {
  // Debounced name input
  const [nameValue, setNameValue] = useState(agent.name);
  const nameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync local state only when a different agent is loaded (not on every server confirmation)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting local input state when a different agent is loaded
    setNameValue(agent.name);
  }, [agent.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleNameChange = useCallback(
    (value: string) => {
      setNameValue(value);
      if (nameTimerRef.current) clearTimeout(nameTimerRef.current);
      nameTimerRef.current = setTimeout(() => {
        if (value.trim()) {
          onUpdate({ name: value.trim() });
        }
      }, DEBOUNCE_MS);
    },
    [onUpdate]
  );

  const handleNameBlur = useCallback(() => {
    if (nameTimerRef.current) clearTimeout(nameTimerRef.current);
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== agent.name) {
      onUpdate({ name: trimmed });
    }
  }, [nameValue, agent.name, onUpdate]);

  // Debounced description input
  const [descValue, setDescValue] = useState(agent.description);
  const descTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting local input state when a different agent is loaded
    setDescValue(agent.description);
  }, [agent.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDescChange = useCallback(
    (value: string) => {
      setDescValue(value);
      if (descTimerRef.current) clearTimeout(descTimerRef.current);
      descTimerRef.current = setTimeout(() => {
        onUpdate({ description: value });
      }, DEBOUNCE_MS);
    },
    [onUpdate]
  );

  const handleDescBlur = useCallback(() => {
    if (descTimerRef.current) clearTimeout(descTimerRef.current);
    if (descValue !== agent.description) {
      onUpdate({ description: descValue });
    }
  }, [descValue, agent.description, onUpdate]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (nameTimerRef.current) clearTimeout(nameTimerRef.current);
      if (descTimerRef.current) clearTimeout(descTimerRef.current);
    };
  }, []);

  return (
    <div className="space-y-6">
      <FieldCard>
        <FieldCardContent>
          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="agent-name" className="text-sm font-medium">
              Name
            </Label>
            <input
              id="agent-name"
              type="text"
              value={nameValue}
              onChange={(e) => handleNameChange(e.target.value)}
              onBlur={handleNameBlur}
              className="border-border bg-background text-foreground placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              placeholder="Agent name"
            />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="agent-description" className="text-sm font-medium">
              Description
            </Label>
            <textarea
              id="agent-description"
              value={descValue}
              onChange={(e) => handleDescChange(e.target.value)}
              onBlur={handleDescBlur}
              rows={3}
              className="border-border bg-background text-foreground placeholder:text-muted-foreground focus-visible:ring-ring w-full resize-none rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              placeholder="What does this agent do?"
            />
          </div>

          {/* Runtime */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Runtime</Label>
            <Select
              value={agent.runtime}
              onValueChange={(v) => onUpdate({ runtime: v as AgentManifest['runtime'] })}
            >
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude-code">Claude Code</SelectItem>
                <SelectItem value="cursor">Cursor</SelectItem>
                <SelectItem value="codex">Codex</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </FieldCardContent>
      </FieldCard>

      {/* Color */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">Color</Label>
          {agent.color && (
            <button
              onClick={() => onUpdate({ color: undefined })}
              className="text-muted-foreground hover:text-foreground text-xs transition-colors duration-150"
            >
              Reset
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {COLOR_PRESETS.map((c) => (
            <button
              key={c}
              onClick={() => onUpdate({ color: c })}
              className={cn(
                'size-7 rounded-full transition-all duration-150',
                agent.color === c ? 'ring-foreground ring-2 ring-offset-2' : 'hover:scale-110'
              )}
              style={{ backgroundColor: c }}
              aria-label={`Select color ${c}`}
            />
          ))}
        </div>
      </div>

      {/* Emoji */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">Icon</Label>
          {agent.icon && (
            <button
              onClick={() => onUpdate({ icon: undefined })}
              className="text-muted-foreground hover:text-foreground text-xs transition-colors duration-150"
            >
              Reset
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1">
          {EMOJI_SET.map((emoji) => (
            <button
              key={emoji}
              onClick={() => onUpdate({ icon: emoji })}
              className={cn(
                'flex size-8 items-center justify-center rounded-md text-base transition-all duration-150',
                agent.icon === emoji ? 'bg-accent ring-foreground ring-1' : 'hover:bg-accent/50'
              )}
              aria-label={`Select icon ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
