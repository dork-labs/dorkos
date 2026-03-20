import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Switch, Label, Field, FieldCard, FieldCardContent, FieldLabel } from '@/layers/shared/ui';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

const DEBOUNCE_MS = 500;
const MAX_CHARS = 4000;

interface PersonaTabProps {
  agent: AgentManifest;
  onUpdate: (updates: Partial<AgentManifest>) => void;
}

/**
 * Persona configuration tab — toggle persona injection and edit the persona text
 * that gets appended to Claude Code's system prompt.
 */
export function PersonaTab({ agent, onUpdate }: PersonaTabProps) {
  // Zod v4 + openapi extension drops persona fields from inferred type
  const agentAny = agent as { persona?: string; personaEnabled?: boolean };
  const isEnabled = agentAny.personaEnabled !== false;

  const [personaValue, setPersonaValue] = useState(agentAny.persona ?? '');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync local state only when a different agent is loaded (not on every server confirmation)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting local input state when a different agent is loaded
    setPersonaValue(agentAny.persona ?? '');
  }, [agent.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleToggle = useCallback(
    (checked: boolean) => {
      onUpdate({ personaEnabled: checked } as Partial<AgentManifest>);
    },
    [onUpdate]
  );

  const handlePersonaChange = useCallback(
    (value: string) => {
      setPersonaValue(value);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        onUpdate({ persona: value } as Partial<AgentManifest>);
      }, DEBOUNCE_MS);
    },
    [onUpdate]
  );

  const handlePersonaBlur = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (personaValue !== (agentAny.persona ?? '')) {
      onUpdate({ persona: personaValue } as Partial<AgentManifest>);
    }
  }, [personaValue, agentAny.persona, onUpdate]);

  const preview = useMemo(() => {
    const identityLines = [
      `Name: ${agent.name}`,
      `ID: ${agent.id}`,
      agent.description && `Description: ${agent.description}`,
      agent.capabilities.length > 0 && `Capabilities: ${agent.capabilities.join(', ')}`,
    ].filter(Boolean);

    let xml = `<agent_identity>\n${identityLines.join('\n')}\n</agent_identity>`;

    if (isEnabled && personaValue.trim()) {
      xml += `\n\n<agent_persona>\n${personaValue}\n</agent_persona>`;
    }

    return xml;
  }, [agent.name, agent.id, agent.description, agent.capabilities, isEnabled, personaValue]);

  return (
    <div className="space-y-6">
      {/* Guidance */}
      <p className="text-muted-foreground text-sm">
        This text is appended to Claude Code&apos;s system prompt for every session in this
        directory. Use it to define the agent&apos;s expertise, constraints, and personality.
      </p>

      <FieldCard>
        <FieldCardContent>
          {/* Toggle */}
          <Field orientation="horizontal" className="items-center justify-between">
            <FieldLabel htmlFor="persona-toggle" className="text-sm font-medium">
              Inject persona into sessions
            </FieldLabel>
            <Switch id="persona-toggle" checked={isEnabled} onCheckedChange={handleToggle} />
          </Field>

          {/* Textarea */}
          <div className="space-y-2">
            <textarea
              id="persona-text"
              value={personaValue}
              onChange={(e) => handlePersonaChange(e.target.value)}
              onBlur={handlePersonaBlur}
              rows={8}
              maxLength={MAX_CHARS}
              disabled={!isEnabled}
              className="border-border bg-background text-foreground placeholder:text-muted-foreground focus-visible:ring-ring w-full resize-none rounded-md border px-3 py-2 font-mono text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              placeholder="You are backend-bot, an expert in REST API design..."
            />
            <p className="text-muted-foreground text-right text-xs">
              {personaValue.length} / {MAX_CHARS.toLocaleString()}
            </p>
          </div>
        </FieldCardContent>
      </FieldCard>

      {/* Preview */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">Preview (injected into system prompt)</Label>
        <pre className="bg-muted max-h-48 overflow-auto rounded-md p-3">
          <code className="text-xs">{preview}</code>
        </pre>
      </div>
    </div>
  );
}
