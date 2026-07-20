import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import {
  Input,
  Label,
  Button,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  PathInput,
} from '@/layers/shared/ui';
import type { useConfigureForm } from '../model/use-configure-form';
import { DEFAULT_AGENT_FACE } from '../lib/agent-faces';
import { suggestionWindow } from '../lib/name-suggestions';
import { FacePicker } from './FacePicker';
import { RuntimePicker } from './RuntimePicker';
import { AgentPreviewCard } from './AgentPreviewCard';

/** How many name suggestions to show per reroll. */
const SUGGESTION_WINDOW = 4;

/** Props for {@link NamingStep}. */
export interface NamingStepProps {
  form: ReturnType<typeof useConfigureForm>;
  /** Resolved themed pool of name suggestions. */
  suggestionPool: readonly string[];
  /** Honest one-line description of the job, for the preview. */
  jobLine: string;
  /** Capability chips for the preview. */
  previewCapabilities: string[];
  /** Return to the gallery (or the arrival card). */
  onBack: () => void;
  /** Hand off to import when the chosen folder already holds a project. */
  onImportInstead: () => void;
  /** Create the agent. */
  onCreate: () => void;
  /** True while the create request is in flight. */
  isCreating: boolean;
}

/**
 * The naming step (M3): the birth. Left column names and dresses the agent
 * (big name field, themed suggestions with a reroll, a face picker, and a
 * folded Details row for directory + runtime + folder name); the right column
 * previews the agent taking shape and holds the "Bring {name} to life" button.
 *
 * Validation (slug derivation, live conflict states, Import-instead hand-off)
 * carries over from the form hook unchanged.
 *
 * @param props - The form, preview inputs, suggestion pool, and step actions.
 */
export function NamingStep({
  form,
  suggestionPool,
  jobLine,
  previewCapabilities,
  onBack,
  onImportInstead,
  onCreate,
  isCreating,
}: NamingStepProps) {
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [rerollOffset, setRerollOffset] = useState(0);
  const suggestions = suggestionWindow(suggestionPool, rerollOffset, SUGGESTION_WINDOW);

  // Auto-focus the name after the step transition settles.
  useEffect(() => {
    const timer = setTimeout(() => nameInputRef.current?.focus(), 160);
    return () => clearTimeout(timer);
  }, []);

  const previewName = form.displayName.trim();
  const createLabel = isCreating
    ? `Bringing ${previewName || 'your agent'} to life…`
    : `Bring ${previewName || 'your agent'} to life`;

  return (
    <div className="grid gap-6 md:grid-cols-2">
      {/* Left — name, suggestions, face, details */}
      <div className="space-y-5">
        <button
          type="button"
          onClick={onBack}
          className="text-muted-foreground hover:text-foreground -ml-1 inline-flex items-center gap-1 text-xs transition-colors"
          data-testid="naming-back"
        >
          <ArrowLeft className="size-3.5" />
          Choose a different agent
        </button>

        {/* Name */}
        <div className="space-y-2">
          <Label htmlFor="agent-name" className="text-sm">
            Name
          </Label>
          <Input
            ref={nameInputRef}
            id="agent-name"
            placeholder="Name your agent"
            value={form.displayName}
            onChange={(e) => form.handleNameChange(e.target.value)}
            aria-invalid={form.showSlugError}
            aria-describedby={form.showSlugError ? 'agent-name-error' : undefined}
            className="h-11 text-base"
          />
          {form.showSlugError && (
            <p id="agent-name-error" className="text-destructive text-xs" role="alert">
              {form.slugValidation.error}
            </p>
          )}
          {form.conflictStatus === 'exists-has-dork' && (
            <div data-testid="conflict-status">
              <p className="text-warning text-xs font-medium">Existing project detected</p>
              <button
                type="button"
                className="text-primary text-xs hover:underline"
                onClick={onImportInstead}
                data-testid="import-instead-link"
              >
                Import instead?
              </button>
            </div>
          )}
        </div>

        {/* Name suggestions */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-xs">Need a name?</span>
            <button
              type="button"
              onClick={() => setRerollOffset((o) => o + SUGGESTION_WINDOW)}
              aria-label="Show other names"
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
              data-testid="suggestion-reroll"
            >
              <span aria-hidden>🎲</span>
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5" data-testid="name-suggestions">
            {suggestions.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => form.handleNameChange(name)}
                className="bg-muted hover:bg-accent focus-visible:ring-ring rounded-full px-2.5 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:outline-none"
                data-testid={`suggestion-${name}`}
              >
                {name}
              </button>
            ))}
          </div>
        </div>

        {/* Face */}
        <div className="space-y-2">
          <Label className="text-sm">Face</Label>
          <FacePicker value={form.icon || DEFAULT_AGENT_FACE} onChange={form.setIcon} />
        </div>

        {/* Details — directory, runtime, folder name */}
        <Collapsible open={form.directoryOpen} onOpenChange={form.setDirectoryOpen}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1 text-sm transition-colors"
              data-testid="details-toggle"
            >
              <ChevronDown
                className={cn('size-4 transition-transform', form.directoryOpen && 'rotate-180')}
              />
              Details
              {form.directoryOverride && (
                <span className="bg-primary/10 text-primary ml-1 rounded px-1.5 py-0.5 text-xs">
                  custom
                </span>
              )}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-4 pt-3">
              <div className="space-y-1.5">
                <Label className="text-muted-foreground text-xs">Runtime</Label>
                <RuntimePicker value={form.runtime} onChange={form.setRuntime} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="agent-directory" className="text-muted-foreground text-xs">
                  Directory
                </Label>
                <PathInput
                  id="agent-directory"
                  placeholder={form.slug ? form.resolvedDirectory : `${form.defaultDirectory}/...`}
                  value={form.directoryOverride}
                  onChange={form.setDirectoryOverride}
                  onBrowse={() => form.setDirectoryPickerOpen(true)}
                  browseTestId="browse-directory-button"
                  data-testid="directory-preview"
                />
                {form.conflictStatus === 'no-path' && (
                  <p className="text-muted-foreground text-xs" data-testid="conflict-status">
                    Will create new directory
                  </p>
                )}
                {form.conflictStatus === 'exists-no-dork' && (
                  <p className="text-muted-foreground text-xs" data-testid="conflict-status">
                    Directory exists — will create project inside
                  </p>
                )}
                {form.conflictStatus === 'error' && (
                  <p className="text-destructive text-xs" data-testid="conflict-status">
                    Cannot access this path
                  </p>
                )}
              </div>

              {form.slug && !form.showSlugError && (
                <p className="text-muted-foreground text-xs">
                  Folder name:{' '}
                  <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">
                    {form.slug}
                  </code>
                </p>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>

      {/* Right — live preview + create */}
      <div className="flex flex-col gap-4 self-start">
        <AgentPreviewCard
          face={form.icon || DEFAULT_AGENT_FACE}
          name={form.displayName}
          jobLine={jobLine}
          capabilities={previewCapabilities}
        />
        <Button
          size="lg"
          onClick={onCreate}
          disabled={!form.canSubmit || isCreating}
          data-testid="create-button"
        >
          {createLabel}
        </Button>
      </div>
    </div>
  );
}
