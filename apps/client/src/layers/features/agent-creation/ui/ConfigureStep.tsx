import { useEffect, useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import {
  Input,
  Label,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  PathInput,
} from '@/layers/shared/ui';
import type { useConfigureForm } from '../model/use-configure-form';
import type { CreationMode } from '../lib/wizard-types';

interface ConfigureStepProps {
  form: ReturnType<typeof useConfigureForm>;
  creationMode: CreationMode;
  template: { source: string | null; name: string | null };
  onChangeTemplate: () => void;
  onImportInstead: () => void;
}

/** Name + directory configuration step with conflict detection. */
export function ConfigureStep({
  form,
  creationMode,
  template,
  onChangeTemplate,
  onImportInstead,
}: ConfigureStepProps) {
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Auto-focus after AnimatePresence transition completes
  useEffect(() => {
    const timer = setTimeout(() => nameInputRef.current?.focus(), 160);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="space-y-4">
      {/* Template indicator chip */}
      {creationMode === 'template' && template.source && (
        <div className="bg-muted/50 flex items-center gap-2 rounded-lg border px-3 py-2">
          <span className="text-sm">📦</span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{template.name ?? template.source}</p>
            <p className="text-muted-foreground text-[11px]">Template selected</p>
          </div>
          <button
            type="button"
            onClick={onChangeTemplate}
            className="text-primary text-xs hover:underline"
            data-testid="change-template"
          >
            Change
          </button>
        </div>
      )}

      {/* Name input */}
      <div className="space-y-2">
        <Label htmlFor="agent-name">Name</Label>
        <Input
          ref={nameInputRef}
          id="agent-name"
          placeholder="My Cool Agent"
          value={form.displayName}
          onChange={(e) => form.handleNameChange(e.target.value)}
          aria-invalid={form.showSlugError}
          aria-describedby={
            form.showSlugError
              ? 'agent-name-error'
              : form.nameAutoFilled
                ? 'agent-name-hint'
                : undefined
          }
        />
        {form.displayName && form.slug && !form.showSlugError && (
          <p className="text-muted-foreground text-xs">
            Slug:{' '}
            <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">{form.slug}</code>
          </p>
        )}
        {form.showSlugError && (
          <p id="agent-name-error" className="text-destructive text-xs" role="alert">
            {form.slugValidation.error}
          </p>
        )}
        {form.nameAutoFilled && !form.showSlugError && (
          <p
            id="agent-name-hint"
            className="text-muted-foreground text-xs"
            data-testid="auto-fill-hint"
          >
            Pre-filled from template — edit freely
          </p>
        )}

        {/* Surface "existing project" warning outside the collapsible — it's actionable */}
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

      {/* Directory — collapsible with integrated path input */}
      <Collapsible open={form.directoryOpen} onOpenChange={form.setDirectoryOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1 text-sm transition-colors"
            data-testid="directory-advanced-toggle"
          >
            <ChevronDown
              className={cn('size-4 transition-transform', form.directoryOpen && 'rotate-180')}
            />
            Directory
            {form.directoryOverride && (
              <span className="bg-primary/10 text-primary ml-1 rounded px-1.5 py-0.5 text-xs">
                custom
              </span>
            )}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-1.5 pt-2">
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
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
