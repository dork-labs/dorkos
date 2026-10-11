import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import {
  Button,
  Input,
  Label,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/layers/shared/ui';
import { communityKeys, useCommunityContentAuthority } from '@/layers/entities/community';
import type { UseRemoteCommunityConduct } from '../../model/use-remote-community-conduct';

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/**
 * What the composer needs beside its own reason line: the way to the rules when they hold the
 * post, and a quiet note that the channel is in slow mode. The hold itself (a mute and when it
 * ends, the rules, slow mode's seconds left) is the composer's reason line, said once.
 */
export function RemoteCommunityConductNotice({
  conduct,
  onReadRules,
}: {
  conduct: UseRemoteCommunityConduct;
  onReadRules: () => void;
}) {
  const { hold, standing } = conduct;
  if (hold?.kind === 'rules')
    return (
      <div className="px-1 pb-1">
        <Button size="sm" variant="outline" onClick={onReadRules}>
          Read the rules
        </Button>
      </div>
    );
  if (hold || !standing?.slowModeSeconds) return null;
  return (
    <p className="text-muted-foreground px-1 pb-1 text-xs">
      Slow mode: one message every {standing.slowModeSeconds}s.
    </p>
  );
}

/** The space's rules, to read and accept in the version shown. */
export function RemoteCommunityRulesDialog({
  conduct,
  open,
  onOpenChange,
}: {
  conduct: UseRemoteCommunityConduct;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const rules = conduct.standing?.rules;
  const accepted = rules ? rules.acceptedVersion >= rules.version : false;
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-lg">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Space rules</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {accepted ? 'You accepted these rules.' : 'Accept these rules to post here.'}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody>
          <div className="max-h-[50vh] overflow-y-auto rounded-md border p-3 text-sm leading-relaxed whitespace-pre-wrap">
            {rules?.text ?? 'This space has no rules.'}
          </div>
          {conduct.accept.error && (
            <p role="alert" className="text-destructive mt-2 text-sm">
              {message(conduct.accept.error, 'Couldn’t accept the rules. Try again.')}
            </p>
          )}
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {rules?.text && !accepted && (
            <Button
              disabled={conduct.accept.isPending}
              onClick={() =>
                conduct.accept.mutate(rules.version, { onSuccess: () => onOpenChange(false) })
              }
            >
              {conduct.accept.isPending ? 'Accepting…' : 'Accept rules'}
            </Button>
          )}
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/** Pick the name this space shows for you. Other spaces keep theirs. */
export function RemoteCommunityNameDialog({
  community,
  accessFingerprint,
  currentName,
  open,
  onOpenChange,
}: {
  community: string;
  accessFingerprint: string;
  currentName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        {open && (
          <NameForm
            community={community}
            accessFingerprint={accessFingerprint}
            currentName={currentName}
            onDone={() => onOpenChange(false)}
          />
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function NameForm({
  community,
  accessFingerprint,
  currentName,
  onDone,
}: {
  community: string;
  accessFingerprint: string;
  currentName: string;
  onDone: () => void;
}) {
  const transport = useTransport();
  const queries = useQueryClient();
  const authority = useCommunityContentAuthority(true, accessFingerprint, community);
  const [name, setName] = useState(currentName);
  const rename = useMutation({
    mutationFn: (displayName: string) =>
      transport.setRemoteCommunityDisplayName(community, displayName),
    onSuccess: async () => {
      // Rosters and messages show the new name once they are read again.
      if (authority)
        await queries.invalidateQueries({ queryKey: communityKeys.content(authority, community) });
      onDone();
    },
  });
  const trimmed = name.trim();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed && trimmed !== currentName) rename.mutate(trimmed);
      }}
    >
      <ResponsiveDialogHeader>
        <ResponsiveDialogTitle>Your name in this space</ResponsiveDialogTitle>
        <ResponsiveDialogDescription>
          Other spaces keep the name they show.
        </ResponsiveDialogDescription>
      </ResponsiveDialogHeader>
      <ResponsiveDialogBody className="space-y-2">
        <Label htmlFor="remote-community-display-name">Name</Label>
        <Input
          id="remote-community-display-name"
          value={name}
          maxLength={128}
          autoComplete="nickname"
          onChange={(event) => setName(event.target.value)}
        />
        {rename.error && (
          <p role="alert" className="text-destructive text-sm">
            {message(rename.error, 'Couldn’t change your name. Try again.')}
          </p>
        )}
      </ResponsiveDialogBody>
      <ResponsiveDialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!trimmed || trimmed === currentName || rename.isPending}>
          {rename.isPending ? 'Saving…' : 'Save name'}
        </Button>
      </ResponsiveDialogFooter>
    </form>
  );
}
