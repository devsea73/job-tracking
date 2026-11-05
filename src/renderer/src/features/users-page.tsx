import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Activity, CalendarPlus, ImageOff, KeyRound, MoreHorizontal, Pencil, Send, Shield, Trash2, User, UserCheck, UserPlus, UserX } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import type { AdminUser, CurrentUser } from '@shared/api';
import { PASSWORD_MIN_LENGTH } from '@shared/constants';
import { asUserSubject, Avatar, userLabel } from '@/components/job-bits';
import { Symbol } from '@/components/symbols';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { Notice, Skeleton, Tooltip } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { call, errorMessage, useUsers } from '@/lib/api';
import { formatDate } from '@/lib/utils';

function useUserMutation<Input>(run: (input: Input) => Promise<unknown>, onDone: () => void, success?: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: run,
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      onDone();
      if (success) toast.show(success);
    }
  });
}

function AddUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [mustChange, setMustChange] = useState(false);
  useEffect(() => {
    if (open) {
      setUsername('');
      setDisplayName('');
      setPassword('');
      setMustChange(false);
    }
  }, [open]);
  const create = useUserMutation(
    () => call('POST', '/api/admin/users', { username, password, displayName: displayName.trim() || null, mustChangePassword: mustChange }),
    () => onOpenChange(false),
    `Created ${username}.`
  );
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      className="max-w-md"
      title="Add user"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="add-user-form" loading={create.isPending} disabled={!username.trim() || password.length < PASSWORD_MIN_LENGTH}>
            Add user
          </Button>
        </>
      }
    >
      <form
        id="add-user-form"
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate(undefined);
        }}
      >
        <Field label="Username" htmlFor="new-username">
          <Input id="new-username" autoFocus value={username} onChange={(event) => setUsername(event.target.value)} placeholder="tyler" />
        </Field>
        <Field label="Display name (optional)" htmlFor="new-display-name" hint="Used for their initials: Tyler Morgan shows as TM.">
          <Input id="new-display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Tyler Morgan" />
        </Field>
        <Field label="Password" htmlFor="new-user-password" hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}>
          <Input id="new-user-password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-ink-2">
          <input type="checkbox" checked={mustChange} onChange={(event) => setMustChange(event.target.checked)} />
          Require a new password at first sign-in
        </label>
        {create.isError ? <Notice kind="error">{errorMessage(create.error)}</Notice> : null}
      </form>
    </Dialog>
  );
}

function EditUserDialog({ user, onClose }: { user: AdminUser | null; onClose: () => void }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  useEffect(() => {
    if (user) {
      setUsername(user.username);
      setDisplayName(user.displayName ?? '');
    }
  }, [user]);
  const save = useUserMutation(() => call('PATCH', `/api/admin/users/${user?.id}`, { username, displayName: displayName.trim() || null }), onClose, 'Saved.');
  return (
    <Dialog
      open={user !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className="max-w-md"
      title={`Edit ${user?.username ?? 'user'}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!username.trim()} onClick={() => save.mutate(undefined)}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Username" htmlFor="edit-username">
          <Input id="edit-username" value={username} onChange={(event) => setUsername(event.target.value)} />
        </Field>
        <Field label="Display name" htmlFor="edit-display-name">
          <Input id="edit-display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
        </Field>
        {save.isError ? <Notice kind="error">{errorMessage(save.error)}</Notice> : null}
      </div>
    </Dialog>
  );
}

function ResetPasswordDialog({ user, onClose }: { user: AdminUser | null; onClose: () => void }) {
  const [password, setPassword] = useState('');
  useEffect(() => {
    if (user) setPassword('');
  }, [user]);
  const reset = useUserMutation(() => call('POST', `/api/admin/users/${user?.id}/reset-password`, { password }), onClose, `Password reset for ${user?.username}.`);
  return (
    <Dialog
      open={user !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className="max-w-md"
      title={`Reset password for ${user?.username ?? 'user'}`}
      description="They will be signed out everywhere, and asked to choose a new password next time they sign in."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={reset.isPending} disabled={password.length < PASSWORD_MIN_LENGTH} onClick={() => reset.mutate(undefined)}>
            Reset password
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Temporary password" htmlFor="reset-password" hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}>
          <Input id="reset-password" type="password" autoFocus autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </Field>
        {reset.isError ? <Notice kind="error">{errorMessage(reset.error)}</Notice> : null}
      </div>
    </Dialog>
  );
}

function MenuItem({ icon: Icon, children, danger, onSelect, disabled }: { icon: typeof Pencil; children: React.ReactNode; danger?: boolean; onSelect: () => void; disabled?: boolean }) {
  return (
    <DropdownMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={`flex h-8 cursor-default select-none items-center gap-2 rounded-md px-2.5 outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-2 ${danger ? 'text-danger-ink' : 'text-ink'}`}
    >
      <Icon className="size-4" aria-hidden />
      {children}
    </DropdownMenu.Item>
  );
}

export function UsersPage({ currentUser }: { currentUser: CurrentUser }) {
  const users = useUsers();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [resetting, setResetting] = useState<AdminUser | null>(null);
  const [deleting, setDeleting] = useState<AdminUser | null>(null);

  const setActive = useMutation({
    mutationFn: ({ user, isActive }: { user: AdminUser; isActive: boolean }) => call('PATCH', `/api/admin/users/${user.id}`, { isActive }),
    onSuccess: () => queryClient.invalidateQueries(),
    onError: (error) => toast.show(errorMessage(error), 'error')
  });
  const removePhoto = useMutation({
    mutationFn: (user: AdminUser) => call('DELETE', `/api/admin/users/${user.id}/avatar`),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      toast.show('Photo removed.');
    },
    onError: (error) => toast.show(errorMessage(error), 'error')
  });
  const remove = useUserMutation(
    (user: AdminUser) => call('DELETE', `/api/admin/users/${user.id}`),
    () => setDeleting(null),
    'User deleted.'
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-4 px-5 pb-2.5 pt-4">
        <h1 className="text-[17px] font-semibold leading-tight">Users</h1>
        <Tooltip content="Add user">
          <Button variant="primary" size="icon" aria-label="Add user" onClick={() => setAdding(true)}>
            <UserPlus />
          </Button>
        </Tooltip>
      </header>
      <div className="min-h-0 flex-1 overflow-auto border-t border-border bg-surface">
        {users.isError ? (
          <div className="p-5">
            <Notice kind="error">{errorMessage(users.error)}</Notice>
          </div>
        ) : users.isPending ? (
          <div className="space-y-3 p-5">
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
          </div>
        ) : (
          <table className="w-full border-collapse">
            <thead className="sticky top-0 z-10 bg-surface">
              <tr className="border-b border-border text-left text-ink-3 [&>th]:font-normal">
                <th className="py-1.5 pl-5 pr-3">
                  <Symbol icon={User} label="User" />
                </th>
                <th className="py-1.5 pr-3">
                  <Symbol icon={Shield} label="Role" />
                </th>
                <th className="py-1.5 pr-3">
                  <Symbol icon={Activity} label="Status" />
                </th>
                <th className="py-1.5 pr-3 text-right">
                  <Symbol icon={Send} label="Applications" />
                </th>
                <th className="py-1.5 pr-3">
                  <Symbol icon={CalendarPlus} label="Added" />
                </th>
                <th className="w-12 py-1.5 pr-4" />
              </tr>
            </thead>
            <tbody>
              {users.data?.map((user) => (
                <tr key={user.id} className="border-b border-border last:border-b-0">
                  <td className="py-2 pl-5 pr-3">
                    <div className="flex items-center gap-2.5">
                      <Avatar subject={asUserSubject(user)} label={userLabel(user)} size="md" ring={false} />
                      <div className="min-w-0">
                        <p className="truncate font-medium">{user.username}</p>
                        {user.displayName ? <p className="truncate text-[12.5px] text-ink-2">{user.displayName}</p> : null}
                      </div>
                    </div>
                  </td>
                  <td className="py-2 pr-3 text-ink-2">{user.role === 'admin' ? <Symbol icon={Shield} label="Administrator" /> : <Symbol icon={User} label="User" className="text-ink-3" />}</td>
                  <td className="py-2 pr-3">
                    {user.isActive ? (
                      <span className="inline-flex size-4 items-center justify-center" title="Active" aria-label="Active">
                        <span className="size-2 rounded-full bg-success-ink" aria-hidden />
                      </span>
                    ) : (
                      <span className="inline-flex size-4 items-center justify-center" title="Disabled" aria-label="Disabled">
                        <span className="size-2 rounded-full bg-ink-3" aria-hidden />
                      </span>
                    )}
                    {user.mustChangePassword ? <Symbol icon={KeyRound} label="Temporary password" className="ml-1.5 text-warning-ink" size="size-3.5" /> : null}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-ink-2">{user.applicationCount}</td>
                  <td className="py-2 pr-3 text-ink-2">{formatDate(user.createdAt)}</td>
                  <td className="py-2 pr-4">
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${user.username}`}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content align="end" sideOffset={4} className="z-50 min-w-44 rounded-lg border border-border bg-surface p-1 shadow-panel">
                          <MenuItem icon={Pencil} onSelect={() => setEditing(user)}>
                            Edit
                          </MenuItem>
                          <MenuItem icon={KeyRound} onSelect={() => setResetting(user)}>
                            Reset password
                          </MenuItem>
                          {user.avatarVersion ? (
                            <MenuItem icon={ImageOff} onSelect={() => removePhoto.mutate(user)}>
                              Remove photo
                            </MenuItem>
                          ) : null}
                          {user.role !== 'admin' && user.id !== currentUser.id ? (
                            <>
                              <MenuItem icon={user.isActive ? UserX : UserCheck} onSelect={() => setActive.mutate({ user, isActive: !user.isActive })}>
                                {user.isActive ? 'Disable' : 'Enable'}
                              </MenuItem>
                              <DropdownMenu.Separator className="my-1 h-px bg-border" />
                              <MenuItem icon={Trash2} danger onSelect={() => setDeleting(user)}>
                                Delete
                              </MenuItem>
                            </>
                          ) : null}
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <AddUserDialog open={adding} onOpenChange={setAdding} />
      <EditUserDialog user={editing} onClose={() => setEditing(null)} />
      <ResetPasswordDialog user={resetting} onClose={() => setResetting(null)} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Delete ${deleting?.username ?? 'this user'}?`}
        confirmLabel="Delete user"
        danger
        loading={remove.isPending}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting);
        }}
      >
        <p>
          This also deletes their {deleting?.applicationCount ?? 0} application(s), including memos and interviews. Shared jobs stay in the list. To keep their records, disable the account instead.
        </p>
        {remove.isError ? (
          <Notice kind="error" className="mt-3">
            {errorMessage(remove.error)}
          </Notice>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
