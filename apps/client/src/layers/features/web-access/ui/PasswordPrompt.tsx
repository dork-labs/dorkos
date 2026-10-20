import { useId, useState } from 'react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Label,
  PasswordInput,
} from '@/layers/shared/ui';

/** What a password prompt is open for. */
export type Prompt = { title: string; confirm: string; run: (password: string) => void } | null;

/** Ask for the owner's password before a change that opens access wider, or removes a passkey. */
export function PasswordPrompt({ prompt, onClose }: { prompt: Prompt; onClose: () => void }) {
  const id = useId();
  const [password, setPassword] = useState('');
  const close = () => {
    setPassword('');
    onClose();
  };
  return (
    <AlertDialog open={prompt !== null} onOpenChange={(open) => !open && close()}>
      <AlertDialogContent>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            prompt?.run(password);
            close();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{prompt?.title}</AlertDialogTitle>
            <AlertDialogDescription>Enter your password for this computer.</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor={id}>Password</Label>
            <PasswordInput
              id={id}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
            <Button type="submit" disabled={!password}>
              {prompt?.confirm}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
