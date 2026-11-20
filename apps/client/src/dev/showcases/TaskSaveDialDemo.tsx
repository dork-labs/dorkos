/**
 * A new schedule's Permissions field and its Create button, for the Trust Dial
 * showcases (DOR-3841).
 *
 * @module dev/showcases/TaskSaveDialDemo
 */
import { useState } from 'react';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import type { PermissionMode } from '@dorkos/shared/types';
import { autonomyToConfirm, TaskAutonomyConfirm, TaskAutonomyField } from '@/layers/features/tasks';
import { Button } from '@/layers/shared/ui';

/**
 * The real field and the real confirm: a stop that acts without asking takes
 * one confirm on save, never on the pick. Cancel saves nothing.
 *
 * @param props - The declared modes of the runtime the demo stands for.
 */
export function TaskSaveDial({ descriptors }: { descriptors: PermissionModeDescriptor[] }) {
  const [mode, setMode] = useState<PermissionMode>('bypassPermissions');
  const [pending, setPending] = useState<PermissionModeDescriptor | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  return (
    <div className="w-80 space-y-3">
      <TaskAutonomyField mode={mode} descriptors={descriptors} onChange={setMode} />
      <Button
        size="sm"
        onClick={() => {
          // The form's own rule, so the demo cannot drift from it.
          const descriptor = autonomyToConfirm({
            value: { permissionMode: mode, runtime: '' },
            descriptors,
          });
          if (descriptor) setPending(descriptor);
          else setSaved(mode);
        }}
      >
        Create task
      </Button>
      <p className="text-muted-foreground text-xs">Saved: {saved ?? 'nothing yet'}</p>
      <TaskAutonomyConfirm
        descriptor={pending}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          setSaved(mode);
          setPending(null);
        }}
      />
    </div>
  );
}
