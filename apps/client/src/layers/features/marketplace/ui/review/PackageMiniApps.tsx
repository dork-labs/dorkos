import type { PermissionPreview } from '@dorkos/shared/marketplace-schemas';
import { ExtensionPermissionLines } from '@/layers/entities/extension';
import { useState } from 'react';
import { Badge, CollapsibleFieldCard } from '@/layers/shared/ui';

/** The declarations of each bundled app, never secret values or granted access. */
export function PackageMiniApps({
  extensions,
}: {
  extensions: PermissionPreview['extensions'] | undefined;
}) {
  const [open, setOpen] = useState(true);
  if (extensions === undefined) {
    return <p className="text-muted-foreground text-xs">Mini app details weren’t included.</p>;
  }
  if (extensions.length === 0) return null;
  return (
    <CollapsibleFieldCard
      open={open}
      onOpenChange={setOpen}
      trigger={
        <span className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
          Mini apps
        </span>
      }
      badge={
        <Badge variant="secondary" className="text-xs">
          {extensions.length}
        </Badge>
      }
    >
      <ul className="space-y-3" data-testid="preview-extension-reach">
        {extensions.map((ext) => (
          <li key={ext.id} className="min-w-0 space-y-1 text-xs break-words">
            <p className="font-medium">
              <bdi>{ext.id}</bdi>
            </p>
            <p className="text-muted-foreground">
              Shows in: {ext.slots.length ? ext.slots.join(', ') : 'no places declared'}
            </p>
            {ext.hasServer === false ? (
              <p className="text-muted-foreground">Only screens; no server code.</p>
            ) : ext.isolation ? (
              <ExtensionPermissionLines
                permissions={{
                  ...ext.isolation,
                  run: ext.isolation.run.map((name) => ({ name })),
                  ...(ext.hasServer !== undefined ? { hasServer: ext.hasServer } : {}),
                }}
                data-testid={`preview-extension-reach-${ext.id}`}
              />
            ) : (
              <p className="text-muted-foreground">Server permissions weren’t included.</p>
            )}
            {ext.secrets === undefined ? (
              <p className="text-muted-foreground">Secret declarations weren’t included.</p>
            ) : ext.secrets.length === 0 ? (
              <p className="text-muted-foreground">No secrets declared.</p>
            ) : (
              <ul className="space-y-1" aria-label={`Secrets for ${ext.id}`}>
                {ext.secrets.map((secret) => (
                  <li key={secret.key}>
                    Secrets: <bdi>{secret.key}</bdi> ({secret.required ? 'required' : 'optional'})
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </CollapsibleFieldCard>
  );
}
