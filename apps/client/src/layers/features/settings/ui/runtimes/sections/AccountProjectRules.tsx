/**
 * Where each Claude account may work (spec `flow-multiproject` §8.5): the
 * "Only for client-app" line on an account's row, the "Limit to projects"
 * dialog that sets it, and the "Project limits" list that shows and removes
 * each project's own account list.
 *
 * Core owns all three, so a person can always see and undo a rule without the
 * flow extension installed. Every write is one of the two person-only routes
 * (`PUT /api/runtimes/claude-code/...`); a refusal shows the server's sentence.
 *
 * @module features/settings/ui/runtimes/sections/AccountProjectRules
 */

import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert } from 'lucide-react';
import type { ProjectRef } from '@dorkos/shared/project-schemas';
import {
  Button,
  Checkbox,
  Label,
  RadioGroup,
  RadioGroupItem,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/layers/shared/ui';
import {
  accountKeys,
  configKeys,
  NOT_USED_IN_ANY_PROJECT,
  useTransport,
} from '@/layers/shared/model';

/** Names joined for a sentence: `a`, `a and b`, `a, b and c`. */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The server's sentence for a refused write, else a plain fallback. */
function messageOf(err: unknown): string {
  return (err instanceof Error && err.message) || 'Couldn’t save that. Try again.';
}

/** After a rule changes: the config block, every eligibility read and the pickers. */
function useInvalidateRules() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: configKeys.all });
    void queryClient.invalidateQueries({ queryKey: accountKeys.all });
  };
}

/**
 * The muted line under an account kept to some projects: "Only for client-app"
 * (names joined: "Only for client-app and client-api"). Nothing for an account
 * that may work anywhere.
 *
 * @param props.onlyProjects - The projects the account is kept to, or null.
 */
export function OnlyForLine({ onlyProjects }: { onlyProjects: readonly ProjectRef[] | null }) {
  if (onlyProjects === null) return null;
  return (
    <p className="text-muted-foreground text-xs" data-testid="claude-account-only-for">
      {onlyProjects.length === 0
        ? NOT_USED_IN_ANY_PROJECT
        : `Only for ${joinNames(onlyProjects.map((p) => p.name))}`}
    </p>
  );
}

/** Props for {@link LimitToProjectsDialog}. */
export interface LimitToProjectsDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Called when it opens or closes. */
  onOpenChange: (open: boolean) => void;
  /** The account's registry id, or `default` for Main. */
  accountId: string;
  /** What the person calls the account. */
  accountName: string;
  /** The projects it is kept to now, or null for any project. */
  current: readonly ProjectRef[] | null;
}

/**
 * Choose the projects one account may work in, or "Any project". Lists every
 * project this machine knows (`GET /api/projects`); saving writes the account's
 * own rule and closes.
 */
export function LimitToProjectsDialog({
  open,
  onOpenChange,
  accountId,
  accountName,
  current,
}: LimitToProjectsDialogProps) {
  const transport = useTransport();
  const invalidate = useInvalidateRules();
  const modeId = useId();
  const projects = useQuery({
    queryKey: accountKeys.projects(),
    queryFn: () => transport.listProjects(),
    enabled: open,
  });
  const [mode, setMode] = useState<'any' | 'only'>(current === null ? 'any' : 'only');
  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set((current ?? []).map((p) => p.root))
  );
  // "Only these projects" with none ticked would keep the account out of every
  // project; say so rather than save a rule nobody meant.
  const [emptyChoice, setEmptyChoice] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      transport.setAccountOnlyProjects(accountId, mode === 'any' ? null : [...chosen]),
    onSuccess: () => {
      invalidate();
      onOpenChange(false);
    },
  });

  // Every project the machine knows, plus any the rule names that the list no
  // longer shows (a folder that is gone), so saving never drops one silently.
  const listed = projects.data ?? [];
  const extra = (current ?? []).filter((p) => !listed.some((known) => known.root === p.root));
  const all: ProjectRef[] = [...listed, ...extra];

  function submit() {
    if (mode === 'only' && chosen.size === 0) {
      setEmptyChoice(true);
      return;
    }
    setEmptyChoice(false);
    save.mutate();
  }

  function toggle(root: string, on: boolean) {
    setEmptyChoice(false);
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(root);
      else next.delete(root);
      return next;
    });
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="max-h-[85vh] md:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle className="text-sm font-medium">
            Where can {accountName} work?
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="text-muted-foreground text-xs">
            DorkOS never uses it anywhere else, whether you, a schedule or an agent picks it. An
            account kept to projects is not used in folders outside a project.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="space-y-3">
          <RadioGroup
            value={mode}
            onValueChange={(value) => setMode(value as 'any' | 'only')}
            aria-labelledby={modeId}
          >
            <span id={modeId} className="sr-only">
              Where {accountName} can work
            </span>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="any" id={`${modeId}-any`} />
              <Label htmlFor={`${modeId}-any`} className="text-sm font-normal">
                Any project
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="only" id={`${modeId}-only`} />
              <Label htmlFor={`${modeId}-only`} className="text-sm font-normal">
                Only these projects
              </Label>
            </div>
          </RadioGroup>
          {mode === 'only' && (
            <div className="space-y-1.5 pl-6" data-testid="limit-projects-list">
              {projects.isPending && (
                <p className="text-muted-foreground text-xs">Looking for projects…</p>
              )}
              {!projects.isPending && all.length === 0 && (
                <p className="text-muted-foreground text-xs">
                  DorkOS hasn’t seen a project yet. Start a chat in one first.
                </p>
              )}
              {all.map((project) => {
                const id = `${modeId}-${project.root}`;
                return (
                  <div key={project.root} className="flex min-h-11 items-center gap-2 md:min-h-8">
                    <Checkbox
                      id={id}
                      checked={chosen.has(project.root)}
                      onCheckedChange={(checked) => toggle(project.root, checked === true)}
                    />
                    <Label htmlFor={id} className="min-w-0 text-sm font-normal">
                      <span className="truncate">{project.name}</span>
                    </Label>
                  </div>
                );
              })}
            </div>
          )}
          {emptyChoice && (
            <p role="alert" className="text-destructive flex items-start gap-1.5 text-xs">
              <CircleAlert className="mt-px size-3 shrink-0" aria-hidden />
              <span>Tick at least one project, or choose Any project.</span>
            </p>
          )}
          {save.isError && (
            <p role="alert" className="text-destructive flex items-start gap-1.5 text-xs">
              <CircleAlert className="mt-px size-3 shrink-0" aria-hidden />
              <span>{messageOf(save.error)}</span>
            </p>
          )}
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={save.isPending}>
            Save
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/** Props for {@link ProjectLimitsList}. */
export interface ProjectLimitsListProps {
  /** Each project that limits which accounts it may use. */
  limits: readonly { project: ProjectRef; allow: readonly string[] }[];
  /** What the person calls an account, by id (`default` is Main). */
  nameForId: (accountId: string) => string;
}

/**
 * "Project limits": each project that allows only some accounts, with the
 * accounts it allows and a Remove that lets it use every account again.
 * Renders nothing when no project has a list.
 */
export function ProjectLimitsList({ limits, nameForId }: ProjectLimitsListProps) {
  const transport = useTransport();
  const invalidate = useInvalidateRules();
  const captionId = useId();
  const remove = useMutation({
    mutationFn: (root: string) => transport.setProjectAccounts(root, null),
    onSuccess: invalidate,
  });
  if (limits.length === 0) return null;
  return (
    <div
      role="group"
      aria-labelledby={captionId}
      className="rounded-md border px-3 py-1.5"
      data-testid="project-limits"
    >
      <p id={captionId} className="text-muted-foreground pt-1 text-xs">
        Project limits
      </p>
      {/* Said plainly: core shows and removes a project's list; choosing one
          is the Flow extension's (spec §8.5, V6) or a script's. */}
      <p className="text-muted-foreground pb-1 text-xs" data-testid="project-limits-note">
        Each project here uses only the accounts listed. A project’s list is set by the Flow
        extension or a script; remove it here to let the project use every account.
      </p>
      <ul className="divide-y">
        {limits.map(({ project, allow }) => (
          <li
            key={project.root}
            className="flex flex-wrap items-center gap-2 py-2"
            data-testid="project-limit-row"
          >
            <div className="min-w-40 flex-1">
              <p className="text-sm font-medium break-all">{project.name}</p>
              <p className="text-muted-foreground text-xs">
                {allow.length === 0
                  ? 'Uses no account'
                  : `Uses only ${joinNames(allow.map(nameForId))}`}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => remove.mutate(project.root)}
              disabled={remove.isPending}
              aria-label={`Let ${project.name} use every account`}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      {remove.isError && (
        <p role="alert" className="text-destructive flex items-start gap-1.5 pb-1.5 text-xs">
          <CircleAlert className="mt-px size-3 shrink-0" aria-hidden />
          <span>{messageOf(remove.error)}</span>
        </p>
      )}
    </div>
  );
}
