import { useId, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  RemoteCommunityEnrollment,
  RemoteCommunityEjectionResponse,
} from '@dorkos/shared/community-views';
import {
  communityKeys,
  isCommunityContentAuthorityCurrent,
  useCommunityContentAuthority,
  useRemoteCommunityAgents,
} from '@/layers/entities/community';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { useTransport } from '@/layers/shared/model';
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/layers/shared/ui';

/** Local manifest-backed enrollment controls; remote identities never become local runtime authority. */
export function RemoteCommunityAgents({
  community,
  roomId,
  online,
  canEnroll,
  accessFingerprint,
}: {
  community: string;
  roomId: string;
  online: boolean;
  canEnroll: boolean;
  accessFingerprint: string;
}) {
  const transport = useTransport();
  const queries = useQueryClient();
  const authority = useCommunityContentAuthority(true, accessFingerprint);
  const agents = useRemoteCommunityAgents(community, canEnroll, accessFingerprint);
  const local = useRegisteredAgents();
  const [selected, setSelected] = useState('');
  const [handle, setHandle] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const id = useId();
  const active = agents.data?.filter((agent) => agent.active) ?? [];
  const available =
    local.data?.agents.filter(
      (agent) => !active.some((enrollment) => enrollment.localAgentId === agent.id)
    ) ?? [];
  async function refresh() {
    if (authority && isCommunityContentAuthorityCurrent(authority))
      await queries.invalidateQueries({ queryKey: communityKeys.remote(authority, community) });
  }
  async function enroll(event: FormEvent) {
    event.preventDefault();
    if (!selected || pending || !online || !canEnroll) return;
    if (!authority) return;
    const captured = authority;
    setPending(true);
    setError(null);
    try {
      await transport.enrollRemoteCommunityAgent(
        community,
        selected,
        handle.trim() ? { handle: handle.trim() } : {}
      );
      if (!isCommunityContentAuthorityCurrent(captured)) return;
      setSelected('');
      setHandle('');
      await refresh();
    } catch (cause) {
      if (isCommunityContentAuthorityCurrent(captured))
        setError(
          cause instanceof Error ? cause.message : 'The agent could not join this community.'
        );
    } finally {
      if (isCommunityContentAuthorityCurrent(captured)) setPending(false);
    }
  }
  return (
    <section className="mt-3 space-y-2 border-t pt-3" aria-label="My community agents">
      <h3 className="text-sm font-medium">My agents</h3>
      <p className="text-muted-foreground text-xs">
        Add an agent from this installation, then choose whether it joins this channel. Other
        members can mention it when it has joined.
      </p>
      {agents.isError && (
        <p role="alert">
          Your community agents could not be loaded.{' '}
          <Button variant="ghost" size="sm" onClick={() => void agents.refetch()}>
            Retry
          </Button>
        </p>
      )}
      {agents.data?.map((agent) => (
        <EnrolledAgent
          key={agent.localAgentId}
          agent={agent}
          roomId={roomId}
          online={online}
          canEnroll={canEnroll}
          onChanged={refresh}
          onNotice={setNotice}
        />
      ))}
      {local.isError && <p role="alert">Local agents could not be loaded.</p>}
      {canEnroll && available.length > 0 && (
        <form onSubmit={(event) => void enroll(event)} className="flex flex-wrap items-end gap-2">
          <div className="min-w-40 flex-1 space-y-1">
            <Label htmlFor={`${id}-agent`}>Local agent</Label>
            <Select value={selected} onValueChange={setSelected} disabled={!online || pending}>
              <SelectTrigger id={`${id}-agent`}>
                <SelectValue placeholder="Choose an agent" />
              </SelectTrigger>
              <SelectContent>
                {available.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-40 flex-1 space-y-1">
            <Label htmlFor={`${id}-handle`}>Community handle (optional)</Label>
            <Input
              id={`${id}-handle`}
              value={handle}
              onChange={(event) => setHandle(event.target.value)}
              disabled={!online || pending}
              placeholder="Use the agent’s handle"
            />
          </div>
          <Button type="submit" disabled={!selected || !online || pending}>
            {pending ? 'Adding…' : 'Add to community'}
          </Button>
        </form>
      )}
      {notice && (
        <p role="status" className="text-muted-foreground text-sm">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </section>
  );
}

function EnrolledAgent({
  agent,
  roomId,
  online,
  canEnroll,
  onChanged,
  onNotice,
}: {
  agent: RemoteCommunityEnrollment;
  roomId: string;
  online: boolean;
  canEnroll: boolean;
  onChanged: () => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const transport = useTransport();
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const joined = agent.roomIds.includes(roomId);
  async function run(name: string, work: () => Promise<unknown>) {
    if (pending) return;
    setPending(name);
    setNotice(null);
    try {
      await work();
      await onChanged();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : 'The action could not be completed.');
    } finally {
      setPending(null);
    }
  }
  function cleanupNotice(result: RemoteCommunityEjectionResponse) {
    onNotice(
      result.remoteRevoked
        ? 'Participation stopped.'
        : 'Local participation stopped. Remote removal is not confirmed; retry when the community is reachable.'
    );
  }
  return (
    <div className="space-y-1 rounded-md border p-2">
      <p className="text-sm font-medium">
        {agent.displayName}
        {!agent.active && ' · locally stopped'}{' '}
        <span className="text-muted-foreground font-normal">
          · owned by {agent.ownerDisplayName}
        </span>
      </p>
      <div className="flex flex-wrap gap-1">
        <Button
          variant="outline"
          size="sm"
          disabled={pending !== null || !canEnroll || !agent.active || (!joined && !online)}
          onClick={() =>
            void run('membership', async () => {
              if (joined)
                cleanupNotice(
                  await transport.leaveRemoteCommunityAgentRoom(
                    agent.community,
                    roomId,
                    agent.localAgentId
                  )
                );
              else
                await transport.joinRemoteCommunityAgentRoom(
                  agent.community,
                  roomId,
                  agent.localAgentId
                );
            })
          }
        >
          {joined ? 'Leave channel' : 'Join channel'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending !== null || !canEnroll}
          onClick={() =>
            void run('stop', () =>
              transport.haltRemoteCommunityAgent(agent.community, roomId, agent.localAgentId)
            )
          }
        >
          Stop agent
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="sm" disabled={pending !== null || !canEnroll}>
              Remove from community
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {agent.displayName}?</AlertDialogTitle>
              <AlertDialogDescription>
                This stops its participation in every channel in this community. You can add it
                again later.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep agent</AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  void run('remove', async () =>
                    cleanupNotice(
                      await transport.ejectRemoteCommunityAgent(agent.community, agent.localAgentId)
                    )
                  )
                }
              >
                Remove agent
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      {notice && (
        <p role="status" className="text-muted-foreground text-xs">
          {notice}
        </p>
      )}
    </div>
  );
}
