import { useEffect, useState } from 'react';
import type { SmartGroupRules } from '@dorkos/shared/config-schema';
import type { AttentionState } from '@/layers/entities/session';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/layers/shared/ui';
import { STATUS_LABELS, describeRules } from '../model/evaluate-smart-group';

/** Selectable activity-window presets (spec §4) — `'none'` means no constraint. */
const ACTIVITY_WINDOW_OPTIONS = [
  { value: 'none', label: 'No limit' },
  { value: String(60 * 60 * 1000), label: 'Last hour' },
  { value: String(24 * 60 * 60 * 1000), label: 'Last day' },
  { value: String(7 * 24 * 60 * 60 * 1000), label: 'Last week' },
] as const;

const STATUS_ORDER: AttentionState[] = ['needs-attention', 'active', 'idle', 'inactive'];

/** One runtime checkbox option. */
export interface RuntimeOption {
  /** The runtime id stored in `rules.runtimes` (e.g. `'codex'`). */
  value: string;
  /** Display label (e.g. `'Codex'`). */
  label: string;
}

interface SmartGroupRuleDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Called when the dialog should close (Cancel, Esc, overlay click, or a successful submit). */
  onOpenChange: (open: boolean) => void;
  /** `'create'` shows a name field; `'edit'` edits an existing group's rules only (rename lives in the header menu). */
  mode: 'create' | 'edit';
  /** Prefilled name — a preset label in create mode, or the group's current name in edit mode (read-only there). */
  initialName?: string;
  /** Prefilled rules — the preset's rules in create mode, or the group's current rules in edit mode. */
  initialRules?: SmartGroupRules;
  /** Runtimes present in the fleet, for the runtime checkbox set. */
  runtimeOptions: RuntimeOption[];
  /** Distinct namespaces present in the fleet (rendered only when there's more than one). */
  namespaceOptions: string[];
  /** Called with the finished name (create mode only) and rules on submit. */
  onSubmit: (input: { name: string; rules: SmartGroupRules }) => void;
}

/**
 * The smart-group rule form (spec §4): runtime checkboxes, a namespace
 * checkbox set (only when the fleet has more than one), a status checkbox
 * set, an activity-window select, and a path-prefix input. Shared by group
 * creation (with a name field) and "Edit rules" from the header menu (name
 * stays fixed — renaming is a separate action). A live summary line
 * (`describeRules`) mirrors exactly what the group will show once saved —
 * the same honesty contract as the header menu. The submit button disables
 * until at least one constraint is set (mirrors the schema refine — a smart
 * group can never be created with empty rules).
 */
export function SmartGroupRuleDialog({
  open,
  onOpenChange,
  mode,
  initialName,
  initialRules,
  runtimeOptions,
  namespaceOptions,
  onSubmit,
}: SmartGroupRuleDialogProps) {
  const [name, setName] = useState(initialName ?? '');
  const [runtimes, setRuntimes] = useState<Set<string>>(new Set(initialRules?.runtimes));
  const [namespaces, setNamespaces] = useState<Set<string>>(new Set(initialRules?.namespaces));
  const [statuses, setStatuses] = useState<Set<AttentionState>>(
    new Set(initialRules?.statuses as AttentionState[] | undefined)
  );
  const [activityWindow, setActivityWindow] = useState(
    initialRules?.lastActiveWithinMs !== undefined
      ? String(initialRules.lastActiveWithinMs)
      : 'none'
  );
  const [pathPrefix, setPathPrefix] = useState(initialRules?.pathPrefix ?? '');

  // Re-seed local state whenever the dialog opens with a (possibly different)
  // initial group — otherwise a second "Edit rules" open would show stale
  // state from whichever group was edited first.
  useEffect(() => {
    if (!open) return;
    setName(initialName ?? '');
    setRuntimes(new Set(initialRules?.runtimes));
    setNamespaces(new Set(initialRules?.namespaces));
    setStatuses(new Set(initialRules?.statuses as AttentionState[] | undefined));
    setActivityWindow(
      initialRules?.lastActiveWithinMs !== undefined
        ? String(initialRules.lastActiveWithinMs)
        : 'none'
    );
    setPathPrefix(initialRules?.pathPrefix ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-seed only on open, not on every keystroke
  }, [open]);

  const toggleSetValue = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  const rules: SmartGroupRules = {
    ...(runtimes.size > 0 && { runtimes: Array.from(runtimes) }),
    ...(namespaces.size > 0 && { namespaces: Array.from(namespaces) }),
    ...(statuses.size > 0 && { statuses: Array.from(statuses) }),
    ...(activityWindow !== 'none' && { lastActiveWithinMs: Number(activityWindow) }),
    ...(pathPrefix.trim().length > 0 && { pathPrefix: pathPrefix.trim() }),
  };
  const hasConstraint = Object.keys(rules).length > 0;
  const trimmedName = name.trim();
  const canSubmit = hasConstraint && (mode === 'edit' || trimmedName.length > 0);

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit({ name: mode === 'create' ? trimmedName : (initialName ?? ''), rules });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'New smart group' : 'Edit rules'}</DialogTitle>
          <DialogDescription>
            Membership is derived from these rules and updates on its own — no dragging agents in or
            out.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {mode === 'create' && (
            <div className="space-y-1.5">
              <Label htmlFor="smart-group-name">Name</Label>
              <Input
                id="smart-group-name"
                value={name}
                maxLength={40}
                onChange={(e) => setName(e.target.value)}
                placeholder="Group name"
              />
            </div>
          )}

          {runtimeOptions.length > 0 && (
            <div className="space-y-1.5">
              <Label>Runtime</Label>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {runtimeOptions.map((opt) => (
                  <label key={opt.value} className="flex items-center gap-1.5 text-sm">
                    <Checkbox
                      checked={runtimes.has(opt.value)}
                      onCheckedChange={() => setRuntimes((prev) => toggleSetValue(prev, opt.value))}
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
            </div>
          )}

          {namespaceOptions.length > 1 && (
            <div className="space-y-1.5">
              <Label>Namespace</Label>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {namespaceOptions.map((ns) => (
                  <label key={ns} className="flex items-center gap-1.5 text-sm">
                    <Checkbox
                      checked={namespaces.has(ns)}
                      onCheckedChange={() => setNamespaces((prev) => toggleSetValue(prev, ns))}
                    />
                    {ns}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Status</Label>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {STATUS_ORDER.map((status) => (
                <label key={status} className="flex items-center gap-1.5 text-sm">
                  <Checkbox
                    checked={statuses.has(status)}
                    onCheckedChange={() => setStatuses((prev) => toggleSetValue(prev, status))}
                  />
                  {STATUS_LABELS[status]}
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="smart-group-activity-window">Activity</Label>
            <Select value={activityWindow} onValueChange={setActivityWindow}>
              <SelectTrigger id="smart-group-activity-window" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACTIVITY_WINDOW_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="smart-group-path-prefix">Path starts with</Label>
            <Input
              id="smart-group-path-prefix"
              value={pathPrefix}
              onChange={(e) => setPathPrefix(e.target.value)}
              placeholder="/Users/you/work"
            />
          </div>

          <p className="text-muted-foreground text-xs">
            {hasConstraint ? describeRules(rules) : 'Set at least one rule to preview matches.'}
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {mode === 'create' ? 'Create' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
