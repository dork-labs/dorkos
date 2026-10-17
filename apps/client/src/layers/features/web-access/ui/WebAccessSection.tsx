import { useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { SessionRelayLevel, SessionRelayStatus } from '@dorkos/shared/session-relay-link';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Input,
  Label,
  PasswordInput,
  RadioGroup,
  RadioGroupItem,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useWebAccess, type WebAccess } from '../model/use-web-access';
import { useSeenDevices } from '../model/use-remote-presence';
import { SeenDevices } from './SeenDevices';

/** The host a hub origin names, for showing it. */
function hostOf(origin: string | null): string {
  if (!origin) return '';
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** Not linked yet: what linking allows, and the code and name to link with. */
function LinkForm({ access, status }: { access: WebAccess; status: SessionRelayStatus }) {
  const codeId = useId();
  const nameId = useId();
  const passwordId = useId();
  const [linkCode, setLinkCode] = useState('');
  const [name, setName] = useState(status.suggestedName);
  const [password, setPassword] = useState('');
  const disabled = !access.atThisComputer || access.busy;
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        access.link({ linkCode: linkCode.trim(), computerName: name.trim(), password });
        // Sent once, never kept.
        setPassword('');
      }}
    >
      <p className="text-sm">
        Your DorkOS account, or DorkOS itself, can run commands here through your agents.
      </p>
      <Collapsible>
        <CollapsibleTrigger className="text-muted-foreground hover:text-foreground group flex items-center gap-1 text-xs">
          <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />
          Learn more
        </CollapsibleTrigger>
        <CollapsibleContent>
          <p className="text-muted-foreground pt-1 text-xs">
            Chats pass through the hub that made this code. Turn this off here anytime.
          </p>
        </CollapsibleContent>
      </Collapsible>
      <div className="space-y-1.5">
        <Label htmlFor={codeId}>Link code</Label>
        <Input
          id={codeId}
          value={linkCode}
          onChange={(event) => setLinkCode(event.target.value)}
          placeholder="XXXX-XXXX-XXXX-XXXX@your-hub"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={nameId}>Name for this computer</Label>
        <Input
          id={nameId}
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={64}
          disabled={disabled}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={passwordId}>Your password for this computer</Label>
        <PasswordInput
          id={passwordId}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          disabled={disabled}
        />
      </div>
      <Button
        type="submit"
        size="sm"
        disabled={disabled || !linkCode.trim() || !name.trim() || !password}
      >
        Link
      </Button>
    </form>
  );
}

/** One level choice: its radio, its name and what it allows. */
function LevelOption({
  value,
  title,
  description,
  disabled,
  comingSoon,
}: {
  value: SessionRelayLevel;
  title: string;
  description: string;
  disabled: boolean;
  comingSoon?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <RadioGroupItem value={value} id={id} disabled={disabled} className="mt-0.5" />
      <div className="space-y-0.5">
        <Label htmlFor={id} className={cn('text-sm', disabled && 'opacity-60')}>
          {title}
          {comingSoon && (
            <Badge variant="secondary" className="ml-2">
              Coming soon
            </Badge>
          )}
        </Label>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
    </div>
  );
}

/** Where a linked computer's relay stands, in a few words. */
function stateLine(status: SessionRelayStatus): string {
  if (status.paused) return 'Paused';
  return status.connected ? 'Connected' : 'Not connected';
}

/** What a password prompt is open for. */
type Prompt = { title: string; confirm: string; run: (password: string) => void } | null;

/** Ask for the owner's password before a change that opens access wider. */
function PasswordPrompt({ prompt, onClose }: { prompt: Prompt; onClose: () => void }) {
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

/** Linked: the hub, the level, Pause or Resume, and Unlink. */
function LinkedControls({ access, status }: { access: WebAccess; status: SessionRelayStatus }) {
  const disabled = !access.atThisComputer || access.busy;
  const [prompt, setPrompt] = useState<Prompt>(null);
  return (
    <div className="space-y-3">
      <PasswordPrompt prompt={prompt} onClose={() => setPrompt(null)} />
      <div>
        <p className="truncate text-sm">{hostOf(status.hubOrigin)}</p>
        <p className="text-muted-foreground text-xs">{stateLine(status)}</p>
      </div>
      <RadioGroup
        value={status.level}
        onValueChange={(value) =>
          // Raising what the web may do asks for the password; lowering does not.
          value === 'full'
            ? setPrompt({
                title: 'Allow Full control from the web?',
                confirm: 'Allow',
                run: (password) => access.setLevel('full', password),
              })
            : access.setLevel(value as SessionRelayLevel)
        }
        aria-label="What the web can do here"
        disabled={disabled}
      >
        <LevelOption
          value="chat"
          title="Chat"
          description="Read and send messages. Questions and approvals wait for you here."
          disabled={disabled}
        />
        {/* Stored, but nothing on the relay reads it yet (B5), so it is not offered. */}
        <LevelOption
          value="full"
          title="Full control"
          description="Also open the terminal, files and settings from the web."
          disabled
          comingSoon
        />
      </RadioGroup>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() =>
            status.paused
              ? setPrompt({
                  title: 'Resume chat from the web?',
                  confirm: 'Resume',
                  run: access.resume,
                })
              : access.pause()
          }
        >
          {status.paused ? 'Resume' : 'Pause'}
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" size="sm" disabled={disabled}>
              Unlink
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Unlink from your hub?</AlertDialogTitle>
              <AlertDialogDescription>
                Chatting from the web stops now. You can link again anytime.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={access.unlink}>Unlink</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}

/**
 * Chat from the web (step B3, DOR-2946): link this computer to the owner's
 * hub with a code copied from it, then choose what the web may do here, pause
 * it, or unlink. Every change happens only at this computer; anywhere else the
 * controls show but stay disabled, with a line saying where to go. Renders
 * nothing on a hub or while the experiment is off.
 */
export function WebAccessSection({ className }: { className?: string }) {
  const access = useWebAccess();
  const status = access.status;
  const devices = useSeenDevices(status?.linked === true);
  if (!access.available || !status) return null;

  return (
    <section
      aria-labelledby="web-access-title"
      className={cn('border-border bg-muted/30 space-y-3 rounded-lg border p-4', className)}
    >
      <p id="web-access-title" className="text-sm font-medium">
        Chat from the web
      </p>
      {!access.atThisComputer && (
        <p className="text-muted-foreground text-xs">Change this on the computer DorkOS runs on.</p>
      )}
      {status.linked ? (
        <>
          <LinkedControls access={access} status={status} />
          <SeenDevices devices={devices} />
        </>
      ) : (
        <LinkForm access={access} status={status} />
      )}
      {access.error && (
        <p className="text-destructive text-xs" role="alert">
          {access.error}
        </p>
      )}
    </section>
  );
}
