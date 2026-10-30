import { useState } from 'react';
import { OwnerSigninAction, useSigninPolicy } from '@/layers/entities/runtime';
import {
  Input,
  Label,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/layers/shared/ui';
import { shortenHomePath } from '@/layers/shared/lib';

/** Owner-managed exclusions. No automatic discovery or lookup of excluded sign-ins. */
export function SigninPolicySection() {
  const policy = useSigninPolicy();
  const [orgId, setOrgId] = useState('');
  const [label, setLabel] = useState('');
  const [accountId, setAccountId] = useState('');
  if (policy.isPending) return null;
  if (!policy.data)
    return (
      <p className="text-muted-foreground text-xs">Only you can manage sign-ins, in the app.</p>
    );
  const { deniedOrganizations, folders, accounts } = policy.data;
  return (
    <section className="mt-6 space-y-3" aria-label="Never use">
      <h3 className="text-sm font-medium">Never use</h3>
      <p className="text-muted-foreground text-xs">DorkOS won’t run agents on these.</p>
      {deniedOrganizations.length === 0 && folders.length === 0 && (
        <p className="text-muted-foreground text-xs">Nothing here yet.</p>
      )}
      {folders.map((folder) => (
        <div key={folder.accountId} className="flex items-center justify-between gap-2 text-xs">
          <span className="min-w-0 truncate" title={folder.path}>
            {shortenHomePath(folder.path)} · DorkOS never opens this folder.
          </span>
          <OwnerSigninAction
            label="Remove folder"
            title="Remove this folder from Never use?"
            description="DorkOS can open and use it again."
            change={{ action: 'allow-folder', accountId: folder.accountId }}
          />
        </div>
      ))}
      {deniedOrganizations.map((org) => (
        <div key={org.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span>
            {org.label} · org {org.id.slice(0, 4)}…
          </span>
          <OwnerSigninAction
            label="Remove sign-in"
            title="Remove this organization from Never use?"
            description="Its sign-ins can run agents again."
            change={{ action: 'remove-org', orgId: org.id }}
          />
        </div>
      ))}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="excluded-folder">Folder</Label>
          <Select value={accountId} onValueChange={setAccountId}>
            <SelectTrigger id="excluded-folder">
              <SelectValue placeholder="Choose a folder" />
            </SelectTrigger>
            <SelectContent>
              {accounts
                .filter(
                  (account) =>
                    account.identity.state !== 'never-use' &&
                    !folders.some((folder) => folder.accountId === account.accountId)
                )
                .map((account) => (
                  <SelectItem key={account.accountId} value={account.accountId}>
                    {account.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <OwnerSigninAction
            label="Add a folder"
            title="Never use this folder?"
            description="DorkOS won’t open it or run agents on it, even at Full."
            change={{ action: 'exclude-folder', accountId }}
            disabled={!accountId}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="excluded-org-label">Label</Label>
          <Input
            id="excluded-org-label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
          <Label htmlFor="excluded-org-id">Organization ID</Label>
          <Input
            id="excluded-org-id"
            className="font-mono"
            aria-describedby="excluded-org-id-hint"
            value={orgId}
            onChange={(event) => setOrgId(event.target.value)}
          />
          <p id="excluded-org-id-hint" className="text-muted-foreground text-xs">
            From Anthropic’s account settings. DorkOS won’t look it up.
          </p>
          <OwnerSigninAction
            label="Add a sign-in"
            title="Never use this organization?"
            description="Sign-ins in it won’t run agents, even at Full."
            change={{ action: 'add-org', orgId, label }}
            disabled={!label.trim() || !orgId.trim()}
          />
        </div>
      </div>
    </section>
  );
}
