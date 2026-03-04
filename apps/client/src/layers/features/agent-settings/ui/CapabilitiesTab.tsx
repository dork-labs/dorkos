import { useState, useCallback, useRef, useEffect, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import {
  Badge,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/layers/shared/ui';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

interface CapabilitiesTabProps {
  agent: AgentManifest;
  onUpdate: (updates: Partial<AgentManifest>) => void;
}

const INPUT_CLASSES =
  'border-border bg-background text-foreground placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2';

const DEBOUNCE_MS = 500;

/**
 * Capabilities tab for agent configuration: tag-based capabilities,
 * namespace, response mode, and budget fields.
 */
export function CapabilitiesTab({ agent, onUpdate }: CapabilitiesTabProps) {
  const [capInput, setCapInput] = useState('');

  // Debounced namespace input (same pattern as IdentityTab)
  const [nsValue, setNsValue] = useState(agent.namespace ?? '');
  const nsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setNsValue(agent.namespace ?? '');
  }, [agent.namespace]);

  const handleNsChange = useCallback(
    (value: string) => {
      setNsValue(value);
      if (nsTimerRef.current) clearTimeout(nsTimerRef.current);
      nsTimerRef.current = setTimeout(() => {
        onUpdate({ namespace: value || undefined });
      }, DEBOUNCE_MS);
    },
    [onUpdate]
  );

  const handleNsBlur = useCallback(() => {
    if (nsTimerRef.current) clearTimeout(nsTimerRef.current);
    const current = nsValue || undefined;
    if (current !== agent.namespace) {
      onUpdate({ namespace: current });
    }
  }, [nsValue, agent.namespace, onUpdate]);

  useEffect(() => {
    return () => {
      if (nsTimerRef.current) clearTimeout(nsTimerRef.current);
    };
  }, []);

  const addCapability = useCallback(
    (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed || agent.capabilities.includes(trimmed)) return;
      onUpdate({ capabilities: [...agent.capabilities, trimmed] });
      setCapInput('');
    },
    [agent.capabilities, onUpdate]
  );

  const removeCapability = useCallback(
    (cap: string) => {
      onUpdate({ capabilities: agent.capabilities.filter((c) => c !== cap) });
    },
    [agent.capabilities, onUpdate]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        addCapability(capInput);
      }
    },
    [capInput, addCapability]
  );

  return (
    <div className="space-y-6">
      {/* Capabilities tags */}
      <div className="space-y-2">
        <Label htmlFor="cap-input" className="text-sm font-medium">
          Capabilities
        </Label>
        <div className="flex flex-wrap gap-1.5">
          {agent.capabilities.map((cap) => (
            <Badge key={cap} variant="secondary" className="gap-1 pr-1">
              {cap}
              <button
                onClick={() => removeCapability(cap)}
                className="hover:bg-muted rounded-sm p-0.5 transition-colors duration-150"
                aria-label={`Remove ${cap}`}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
        <input
          id="cap-input"
          type="text"
          value={capInput}
          onChange={(e) => setCapInput(e.target.value)}
          onKeyDown={handleKeyDown}
          className={INPUT_CLASSES}
          placeholder="Add capability and press Enter"
        />
      </div>

      {/* Namespace */}
      <div className="space-y-2">
        <Label htmlFor="agent-namespace" className="text-sm font-medium">
          Namespace
        </Label>
        <input
          id="agent-namespace"
          type="text"
          value={nsValue}
          onChange={(e) => handleNsChange(e.target.value)}
          onBlur={handleNsBlur}
          className={INPUT_CLASSES}
          placeholder="Optional grouping namespace"
        />
      </div>

      {/* Response Mode */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">Response Mode</Label>
        <Select
          value={agent.behavior?.responseMode ?? 'always'}
          onValueChange={(v) =>
            onUpdate({
              behavior: {
                ...agent.behavior,
                responseMode: v as AgentManifest['behavior']['responseMode'],
              },
            })
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="always">Always respond</SelectItem>
            <SelectItem value="direct-only">Direct messages only</SelectItem>
            <SelectItem value="mention-only">Mentions only</SelectItem>
            <SelectItem value="silent">Silent</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Budget */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">Budget</Label>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label htmlFor="max-hops" className="text-muted-foreground text-xs">
              Max Hops / Message
            </label>
            <input
              id="max-hops"
              type="number"
              min={1}
              value={agent.budget?.maxHopsPerMessage ?? 5}
              onChange={(e) =>
                onUpdate({
                  budget: {
                    ...agent.budget,
                    maxHopsPerMessage: parseInt(e.target.value) || 5,
                  },
                })
              }
              className={INPUT_CLASSES}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="max-calls" className="text-muted-foreground text-xs">
              Max Calls / Hour
            </label>
            <input
              id="max-calls"
              type="number"
              min={1}
              value={agent.budget?.maxCallsPerHour ?? 100}
              onChange={(e) =>
                onUpdate({
                  budget: {
                    ...agent.budget,
                    maxCallsPerHour: parseInt(e.target.value) || 100,
                  },
                })
              }
              className={INPUT_CLASSES}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
