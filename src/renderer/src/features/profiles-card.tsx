import { useEffect, useState, type FormEvent } from 'react';
import { Archive, ArchiveRestore, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CurrentUser, MyProfile } from '@shared/api';
import { PROFILE_NAME_MAX } from '@shared/constants';
import { AvatarEditor } from '@/components/avatar-upload';
import { asUserSubject, userLabel } from '@/components/job-bits';
import { HelpTip } from '@/components/symbols';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { Card, Notice, Skeleton, Tooltip } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { call, errorMessage, useProfiles } from '@/lib/api';

export function PhotoCard({ user }: { user: CurrentUser }) {
  return (
    <Card className="p-5">
      <h2 className="mb-3 text-[14.5px] font-semibold">Your photo</h2>
      <AvatarEditor subject={asUserSubject(user)} label={userLabel(user)} path="/api/me/avatar" size="lg" />
    </Card>
  );
}

function ProfileNameDialog({ open, profile, onOpenChange }: { open: boolean; profile: MyProfile | null; onOpenChange: (open: boolean) => void }) {
  const [name, setName] = useState('');
  const queryClient = useQueryClient();
  const toast = useToast();
  useEffect(() => {
    if (open) setName(profile?.name ?? '');
  }, [open, profile]);
  const save = useMutation({
    mutationFn: () => (profile ? call('PATCH', `/api/profiles/${profile.id}`, { name }) : call('POST', '/api/profiles', { name })),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      onOpenChange(false);
      toast.show(profile ? 'Profile renamed.' : `Created ${name.trim()}.`);
    }
  });
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (name.trim() && !save.isPending) save.mutate();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      className="max-w-md"
      title={profile ? `Rename ${profile.name}` : 'New profile'}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="profile-name-form" loading={save.isPending} disabled={!name.trim()}>
            {profile ? 'Save' : 'Create profile'}
          </Button>
        </>
      }
    >
      <form id="profile-name-form" className="space-y-3" onSubmit={submit}>
        <Field label="Profile name" htmlFor="profile-name">
          <Input id="profile-name" autoFocus maxLength={PROFILE_NAME_MAX} value={name} onChange={(event) => setName(event.target.value)} placeholder="Data Engineer" />
        </Field>
        {save.isError ? <Notice kind="error">{errorMessage(save.error)}</Notice> : null}
      </form>
    </Dialog>
  );
}

export function ProfilesCard() {
  const profiles = useProfiles();
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<MyProfile | null>(null);
  const [removing, setRemoving] = useState<MyProfile | null>(null);
  const queryClient = useQueryClient();
  const toast = useToast();

  const setArchived = useMutation({
    mutationFn: ({ profile, isArchived }: { profile: MyProfile; isArchived: boolean }) => call('PATCH', `/api/profiles/${profile.id}`, { isArchived }),
    onSuccess: () => queryClient.invalidateQueries(),
    onError: (error) => toast.show(errorMessage(error), 'error')
  });
  const remove = useMutation({
    mutationFn: (profile: MyProfile) => call<{ outcome: 'deleted' | 'archived' }>('DELETE', `/api/profiles/${profile.id}`),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries();
      setRemoving(null);
      toast.show(result.outcome === 'archived' ? 'Profile archived. Its applications stay in place.' : 'Profile deleted.');
    },
    onError: (error) => {
      setRemoving(null);
      toast.show(errorMessage(error), 'error');
    }
  });

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <h2 className="flex items-center gap-1.5 text-[14.5px] font-semibold">
          My profiles <HelpTip>Choose a profile each time you add a job. A profile applies to a job once.</HelpTip>
        </h2>
        <Tooltip content="New profile">
          <Button size="icon-sm" aria-label="New profile" onClick={() => setCreating(true)}>
            <Plus />
          </Button>
        </Tooltip>
      </div>

      {profiles.isError ? <Notice kind="error">{errorMessage(profiles.error)}</Notice> : null}
      {profiles.isPending ? (
        <Skeleton className="h-12" />
      ) : (
        <ul className="divide-y divide-border">
          {profiles.data?.profiles.map((profile) => (
            <li key={profile.id} className="flex flex-wrap items-center gap-3 py-2.5">
              <AvatarEditor subject={profile} label={profile.name} path={`/api/profiles/${profile.id}/avatar`} compact />
              <div className="min-w-[120px] flex-1">
                <p className="truncate font-medium">
                  {profile.name}
                  {profile.isArchived ? <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] font-normal text-ink-2">Archived</span> : null}
                </p>
                <p className="inline-flex items-center gap-1 text-[12px] tabular-nums text-ink-3" title={`${profile.applicationCount} applications`}>
                  <Send className="size-3" aria-hidden /> {profile.applicationCount}
                </p>
              </div>
              <div className="flex gap-1">
                <Button size="icon-sm" variant="ghost" title="Rename" aria-label={`Rename ${profile.name}`} onClick={() => setRenaming(profile)}>
                  <Pencil />
                </Button>
                {profile.isArchived ? (
                  <Button size="icon-sm" variant="ghost" title="Restore" aria-label={`Restore ${profile.name}`} onClick={() => setArchived.mutate({ profile, isArchived: false })}>
                    <ArchiveRestore />
                  </Button>
                ) : profile.applicationCount > 0 ? (
                  <Button size="icon-sm" variant="ghost" title="Archive" aria-label={`Archive ${profile.name}`} onClick={() => setRemoving(profile)}>
                    <Archive />
                  </Button>
                ) : (
                  <Button size="icon-sm" variant="danger-ghost" title="Delete" aria-label={`Delete ${profile.name}`} onClick={() => setRemoving(profile)}>
                    <Trash2 />
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <ProfileNameDialog open={creating} profile={null} onOpenChange={setCreating} />
      <ProfileNameDialog
        open={renaming !== null}
        profile={renaming}
        onOpenChange={(open) => {
          if (!open) setRenaming(null);
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={removing?.applicationCount ? `Archive ${removing.name}?` : `Delete ${removing?.name ?? 'this profile'}?`}
        confirmLabel={removing?.applicationCount ? 'Archive' : 'Delete'}
        danger={!removing?.applicationCount}
        loading={remove.isPending}
        onConfirm={() => {
          if (removing) remove.mutate(removing);
        }}
      >
        {removing?.applicationCount
          ? 'Its applications, interviews and history stay visible to everyone, but you can no longer choose it for new jobs. You can restore it later.'
          : 'This profile has no applications, so nothing else changes.'}
      </ConfirmDialog>
    </Card>
  );
}
