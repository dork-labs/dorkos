import { useId, useState, type FormEvent } from 'react';
import { useUpdateCommunityTeammates } from '@/layers/entities/community';
import { Button, Input, Label } from '@/layers/shared/ui';

/**
 * The one folder a space shares with teammates' turns (DOR-2956): none by default, said plainly.
 * The folder is checked on this computer when saved; a refusal says why.
 */
export function SharedFolderField({
  community,
  online,
  saved,
}: {
  community: string;
  online: boolean;
  /** The folder shared now, or `null` for none. */
  saved: string | null;
}) {
  const id = useId();
  const update = useUpdateCommunityTeammates(community);
  // What the person typed, or `null` while the field shows the saved folder.
  const [draft, setDraft] = useState<string | null>(null);
  const folder = draft ?? saved ?? '';
  const typed = folder.trim() === '' ? null : folder.trim();
  const changed = typed !== saved;
  function save(event: FormEvent) {
    event.preventDefault();
    if (!changed || update.isPending) return;
    update.mutate({ sharedFolder: typed }, { onSuccess: () => setDraft(null) });
  }
  return (
    <form onSubmit={save} className="space-y-1">
      <Label htmlFor={`${id}-folder`}>Shared folder</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={`${id}-folder`}
          value={folder}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="No folder shared"
          disabled={!online || update.isPending}
          className="min-w-48 flex-1"
        />
        <Button
          type="submit"
          size="sm"
          aria-label="Save folder"
          disabled={!online || !changed || update.isPending}
        >
          Save
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        {saved === null
          ? 'Teammates’ turns read no files.'
          : 'Teammates’ turns can read files here, never .env files, .git or .dork.'}
      </p>
      {update.isError && (
        <p role="alert" className="text-destructive text-xs">
          {update.error instanceof Error ? update.error.message : 'Couldn’t save. Try again.'}
        </p>
      )}
    </form>
  );
}
