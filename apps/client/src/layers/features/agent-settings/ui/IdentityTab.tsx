import { useState, useCallback, useMemo, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import {
  cn,
  EMOJI_SET,
  getAgentDisplayName,
  hashToHslColor,
  hashToEmoji,
  formatRelativeTime,
} from '@/layers/shared/lib';
import { useDebouncedInput } from '@/layers/shared/model';
import { AgentIdentity, resolveAgentVisual } from '@/layers/entities/agent';
import {
  Badge,
  CollapsibleFieldCard,
  FieldCard,
  FieldCardContent,
  Input,
  Label,
  ResponsivePopover,
  ResponsivePopoverTrigger,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/layers/shared/ui';
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

interface IdentityTabProps {
  agent: AgentManifest;
  onUpdate: (updates: Partial<AgentManifest>) => void;
}

/**
 * Identity profile with hero preview, name/description fields, color picker,
 * and emoji icon popover. System agents have name and description disabled.
 */
export function IdentityTab({ agent, onUpdate }: IdentityTabProps) {
  const isSystem = agent.isSystem === true;
  const visual = resolveAgentVisual(agent);

  // Compute the deterministic defaults from the agent's ID
  const autoColor = useMemo(() => hashToHslColor(agent.id), [agent.id]);
  const autoEmoji = useMemo(() => hashToEmoji(agent.id), [agent.id]);

  // Tag (capabilities) input state
  const [tagInput, setTagInput] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const hasColorOverride = agent.color != null;
  const hasIconOverride = agent.icon != null;
  const hasAnyOverride = hasColorOverride || hasIconOverride;

  // Debounced namespace (project group) input
  const ns = useDebouncedInput(agent.namespace ?? '', agent.id, (v) => {
    onUpdate({ namespace: v || undefined });
  });

  // Popover open states — close on selection
  const [colorOpen, setColorOpen] = useState(false);
  const [iconOpen, setIconOpen] = useState(false);

  // Debounced display name — clearing reverts to showing the slug
  const name = useDebouncedInput(agent.displayName ?? agent.name, agent.id, (v) => {
    const trimmed = v.trim();
    onUpdate({ displayName: trimmed || undefined });
  });
  const nameEmpty = name.value.trim().length === 0;

  // Debounced description
  const desc = useDebouncedInput(agent.description, agent.id, (v) => {
    onUpdate({ description: v });
  });

  const handleColorSelect = useCallback(
    (hex: string | undefined) => {
      onUpdate({ color: hex });
      setColorOpen(false);
    },
    [onUpdate]
  );

  const handleIconSelect = useCallback(
    (emoji: string) => {
      // Selecting the auto-derived emoji clears the override
      onUpdate({ icon: emoji === autoEmoji ? undefined : emoji });
      setIconOpen(false);
    },
    [onUpdate, autoEmoji]
  );

  const handleResetAppearance = useCallback(() => {
    onUpdate({ color: undefined, icon: undefined });
  }, [onUpdate]);

  // Tag (capabilities) handlers
  const addTag = useCallback(
    (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed || agent.capabilities.includes(trimmed)) return;
      onUpdate({ capabilities: [...agent.capabilities, trimmed] });
      setTagInput('');
    },
    [agent.capabilities, onUpdate]
  );

  const removeTag = useCallback(
    (tag: string) => {
      onUpdate({ capabilities: agent.capabilities.filter((c) => c !== tag) });
    },
    [agent.capabilities, onUpdate]
  );

  const handleTagKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        addTag(tagInput);
      }
    },
    [tagInput, addTag]
  );

  // --- Render helpers for system agent tooltip wrapping ---

  const nameInput = (
    <Input
      id="agent-name"
      value={name.value}
      onChange={(e) => name.onChange(e.target.value)}
      onBlur={name.onBlur}
      disabled={isSystem}
      aria-invalid={nameEmpty || undefined}
      placeholder="My Cool Agent"
    />
  );

  const descriptionTextarea = (
    <textarea
      id="agent-description"
      value={desc.value}
      onChange={(e) => desc.onChange(e.target.value)}
      onBlur={desc.onBlur}
      disabled={isSystem}
      rows={3}
      className={cn(
        'border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 w-full resize-none rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50'
      )}
      placeholder="What does this agent do?"
    />
  );

  // The emoji that should show as "active" in the picker — either the override or the auto-derived
  const activeEmoji = agent.icon ?? autoEmoji;

  return (
    <div className="space-y-6">
      {/* Hero preview */}
      <div className="flex justify-center py-2">
        <AgentIdentity
          color={visual.color}
          emoji={visual.emoji}
          name={name.value || getAgentDisplayName(agent)}
          detail={`Registered ${formatRelativeTime(agent.registeredAt)}`}
          size="lg"
        />
      </div>

      {/* Details */}
      <FieldCard>
        <FieldCardContent>
          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="agent-name" className="text-sm font-medium">
              Name
            </Label>
            {isSystem ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div>{nameInput}</div>
                </TooltipTrigger>
                <TooltipContent>System agents cannot be renamed</TooltipContent>
              </Tooltip>
            ) : (
              nameInput
            )}
            {nameEmpty && !isSystem && <p className="text-destructive text-xs">Name is required</p>}
          </div>

          {/* Slug (read-only) */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Slug</Label>
            <Input value={agent.name} disabled className="font-mono text-sm opacity-70" />
            <p className="text-muted-foreground text-xs">Filesystem identifier — set at creation</p>
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="agent-description" className="text-sm font-medium">
              Description
            </Label>
            {isSystem ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div>{descriptionTextarea}</div>
                </TooltipTrigger>
                <TooltipContent>System agent description cannot be modified</TooltipContent>
              </Tooltip>
            ) : (
              descriptionTextarea
            )}
            {!isSystem && (
              <p className="text-muted-foreground text-xs">
                Helps other agents and humans understand what this agent does
              </p>
            )}
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

      {/* Appearance */}
      <FieldCard>
        <FieldCardContent>
          {/* Color */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">Color</Label>
              {hasAnyOverride && (
                <button
                  onClick={handleResetAppearance}
                  className="text-muted-foreground hover:text-foreground text-xs transition-colors duration-150"
                >
                  Reset to defaults
                </button>
              )}
            </div>
            <ResponsivePopover open={colorOpen} onOpenChange={setColorOpen}>
              <ResponsivePopoverTrigger asChild>
                <button
                  className="border-input hover:bg-accent/50 inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors"
                  aria-label="Choose color"
                >
                  <span
                    className="size-4 shrink-0 rounded-full"
                    style={{ backgroundColor: visual.color }}
                  />
                  <span className="text-muted-foreground">
                    {hasColorOverride ? 'Custom' : 'Default'}
                  </span>
                </button>
              </ResponsivePopoverTrigger>
              <ResponsivePopoverContent className="w-auto p-3" align="start">
                <ResponsivePopoverTitle>Choose Color</ResponsivePopoverTitle>
                <div className="flex flex-wrap items-center gap-2">
                  {/* Auto-derived color */}
                  <button
                    onClick={() => handleColorSelect(undefined)}
                    className={cn(
                      'relative size-7 rounded-full transition-all duration-150',
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

                  {/* Presets */}
                  {COLOR_PRESETS.map((c) => (
                    <button
                      key={c.hex}
                      onClick={() => handleColorSelect(c.hex)}
                      className={cn(
                        'size-7 rounded-full transition-all duration-150',
                        agent.color === c.hex
                          ? 'ring-foreground ring-2 ring-offset-2'
                          : 'hover:scale-110'
                      )}
                      style={{ backgroundColor: c.hex }}
                      aria-label={`Select ${c.name}`}
                    />
                  ))}
                </div>
              </ResponsivePopoverContent>
            </ResponsivePopover>
          </div>

          {/* Icon */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Icon</Label>
            <ResponsivePopover open={iconOpen} onOpenChange={setIconOpen}>
              <ResponsivePopoverTrigger asChild>
                <button
                  className="border-input hover:bg-accent/50 inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors"
                  aria-label="Choose icon"
                >
                  <span className="text-base leading-none">{visual.emoji}</span>
                  <span className="text-muted-foreground">
                    {hasIconOverride ? 'Custom' : 'Default'}
                  </span>
                </button>
              </ResponsivePopoverTrigger>
              <ResponsivePopoverContent className="w-64 p-3" align="start">
                <ResponsivePopoverTitle>Choose Icon</ResponsivePopoverTitle>
                <div className="grid grid-cols-6 gap-1">
                  {EMOJI_SET.map((emoji) => {
                    const isActive = emoji === activeEmoji;
                    const isAutoDefault = emoji === autoEmoji && !hasIconOverride;
                    return (
                      <button
                        key={emoji}
                        onClick={() => handleIconSelect(emoji)}
                        className={cn(
                          'flex size-8 items-center justify-center rounded-md text-base transition-all duration-150',
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
              </ResponsivePopoverContent>
            </ResponsivePopover>
          </div>
        </FieldCardContent>
      </FieldCard>

      {/* Tags (discovery capabilities) */}
      <FieldCard>
        <FieldCardContent>
          <div className="space-y-2">
            <Label htmlFor="tag-input" className="text-sm font-medium">
              Tags
            </Label>
            {agent.capabilities.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {agent.capabilities.map((tag) => (
                  <Badge key={tag} variant="secondary" className="gap-1 pr-1">
                    {tag}
                    <button
                      onClick={() => removeTag(tag)}
                      className="hover:bg-muted rounded-sm p-0.5 transition-colors duration-150"
                      aria-label={`Remove ${tag}`}
                    >
                      <X className="size-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">
                Tags help other agents find this one. Examples: code-review, devops, frontend
              </p>
            )}
            <Input
              id="tag-input"
              type="text"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={handleTagKeyDown}
              placeholder="Add tag and press Enter"
            />
          </div>
        </FieldCardContent>
      </FieldCard>

      {/* Advanced — Project Group (namespace) */}
      <CollapsibleFieldCard open={advancedOpen} onOpenChange={setAdvancedOpen} trigger="Advanced">
        <div className="space-y-2">
          <Label htmlFor="project-group" className="text-sm font-medium">
            Project Group
          </Label>
          <p className="text-muted-foreground text-xs">
            Agents in the same group can message each other freely. Cross-group messaging requires
            explicit access rules. Auto-derived from the project directory.
          </p>
          <Input
            id="project-group"
            type="text"
            value={ns.value}
            onChange={(e) => ns.onChange(e.target.value)}
            onBlur={ns.onBlur}
            placeholder="e.g. backend-services"
          />
        </div>
      </CollapsibleFieldCard>
    </div>
  );
}
