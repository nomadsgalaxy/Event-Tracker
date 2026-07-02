'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Search,
  Users as UsersIcon,
  Loader2,
  Lock,
  UserPlus,
  KeyRound,
  ShieldOff,
  Trash2,
  Printer,
  HeartPulse,
  MoreHorizontal,
  Globe,
  UserMinus,
  UserCheck,
} from 'lucide-react';
import { toast } from 'sonner';

import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RoleBadge } from './role-badge';
import { changeUserRoleAction } from './actions';
import {
  addUserAction,
  renameUserAction,
  deleteUserAction,
  offboardUserAction,
  reactivateUserAction,
  resetPasswordAction,
  convertToOauthAction,
  clear2faAction,
  getUserAccommodationsAction,
  saveUserAccommodationsAction,
} from './admin-actions';
import { AccommodationsEditor } from '@/components/account/accommodations-editor';
import type { AccommodationsProfile } from '@/lib/types/types';

// users-table.tsx — the Config > Users directory manager. The interactive admin surface over the
// server-read directory rows. The role <Select> still drives the SEPARATELY red-teamed
// changeUserRoleAction (role-raise-guarded + refuse-own-role — NOT re-implemented here). Layered on
// top: Add user (+ optional local account w/ temp pw), inline-edit display name, password reset / set
// + clear-2FA, per-user accommodations (PII), print-others itinerary, and delete (self-delete locked).
// Every mutating control calls a gated Server Action; on success we router.refresh() (the live-DB read
// is the source of truth — no local row mutation).

export interface RoleOption {
  id: string;
  label: string;
  rank: number;
  hidden: boolean;
}

export interface UserRow {
  email: string;
  name: string;
  preferredName: string;
  role: string;
  source: string;
  /** Friendly sign-in method for display ("Google" / "GitHub" / "Local" / a provider name). */
  sourceLabel: string;
  picture: string;
  lastLoginAt: number | null;
  /** ms epoch when offboarded (access revoked, record kept), else null. */
  offboardedAt: number | null;
  isSelf: boolean;
  hasLocalAccount: boolean;
  hasPassword: boolean;
  twofaEnrolled: boolean;
  locked: boolean;
}

function initials(name: string, email: string): string {
  const base = (name || email || '?').trim();
  const parts = base.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return base.slice(0, 2).toUpperCase();
}

function fmtLastLogin(ts: number | null): string {
  if (!ts) return 'Never';
  try {
    return new Date(ts).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

function roleLabel(roleId: string, options: RoleOption[]): string {
  return options.find((o) => o.id === roleId)?.label ?? roleId;
}

export function UsersTable({
  rows,
  roleOptions,
  adminEmail,
  canManageLocal,
  canViewAccommodations,
  canEditAccommodations,
  canPrintOthers,
}: {
  rows: UserRow[];
  roleOptions: RoleOption[];
  adminEmail: string;
  canManageLocal: boolean;
  canViewAccommodations: boolean;
  canEditAccommodations: boolean;
  canPrintOthers: boolean;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [pendingChange, setPendingChange] = useState<{ row: UserRow; nextRole: string } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<UserRow | null>(null);
  const [convertTarget, setConvertTarget] = useState<UserRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserRow | null>(null);
  const [offboardTarget, setOffboardTarget] = useState<UserRow | null>(null);
  const [accTarget, setAccTarget] = useState<UserRow | null>(null);
  const [editingNameFor, setEditingNameFor] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      `${r.email} ${r.name} ${r.preferredName} ${r.role} ${r.source} ${r.sourceLabel}`.toLowerCase().includes(q)
    );
  }, [rows, query]);

  function requestChange(row: UserRow, nextRole: string) {
    if (nextRole === row.role) return;
    setPendingChange({ row, nextRole });
  }

  function confirmChange() {
    if (!pendingChange) return;
    const { row, nextRole } = pendingChange;
    startTransition(async () => {
      const res = await changeUserRoleAction(row.email, nextRole);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(`${row.email} is now ${roleLabel(nextRole, roleOptions)}.`);
      setPendingChange(null);
      router.refresh();
    });
  }

  function commitRename(row: UserRow, name: string) {
    setEditingNameFor(null);
    if (name.trim() === row.name) return;
    startTransition(async () => {
      const res = await renameUserAction(row.email, name);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      router.refresh();
    });
  }

  function runDelete() {
    if (!deleteTarget) return;
    const email = deleteTarget.email;
    startTransition(async () => {
      const res = await deleteUserAction(email);
      setDeleteTarget(null);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(`${email} removed.`);
      router.refresh();
    });
  }

  function runOffboard() {
    if (!offboardTarget) return;
    const email = offboardTarget.email;
    startTransition(async () => {
      const res = await offboardUserAction(email);
      setOffboardTarget(null);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(`${email} offboarded — access revoked, account kept.`);
      router.refresh();
    });
  }

  function runReactivate(row: UserRow) {
    startTransition(async () => {
      const res = await reactivateUserAction(row.email);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(`${row.email} reactivated.`);
      router.refresh();
    });
  }

  function runClear2fa(row: UserRow) {
    startTransition(async () => {
      const res = await clear2faAction(row.email);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(`Cleared 2FA for ${row.email}.`);
      router.refresh();
    });
  }

  function runConvertOauth() {
    if (!convertTarget) return;
    const row = convertTarget;
    startTransition(async () => {
      const res = await convertToOauthAction(row.email);
      setConvertTarget(null);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(`${row.name || row.email} now signs in with Google (OAuth-only).`);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          {rows.length} {rows.length === 1 ? 'user' : 'users'} in the directory. Change a role from the
          menu — your own role is locked.
        </p>
        <div className="flex items-center gap-2">
          <div className="relative w-full sm:w-64">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search email, name, role…"
              aria-label="Search users"
              className="pl-8"
            />
          </div>
          {canManageLocal && (
            <Button onClick={() => setAddOpen(true)} className="shrink-0">
              <UserPlus className="size-4" aria-hidden /> Add user
            </Button>
          )}
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-10 text-center">
          <UsersIcon className="size-6 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium">No users match</p>
          <p className="text-xs text-muted-foreground">
            {rows.length === 0 ? 'The directory is empty.' : 'Adjust the search to see users.'}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="bg-card hover:bg-card">
                <TableHead>User</TableHead>
                <TableHead className="hidden md:table-cell">Source / 2FA</TableHead>
                <TableHead className="hidden md:table-cell">Last sign-in</TableHead>
                <TableHead className="hidden w-px md:table-cell">Current</TableHead>
                <TableHead className="w-px text-right">Role</TableHead>
                <TableHead className="w-px text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((r) => (
                <UserRowView
                  key={r.email}
                  row={r}
                  roleOptions={roleOptions}
                  busy={isPending && pendingChange?.row.email === r.email}
                  editingName={editingNameFor === r.email}
                  canManageLocal={canManageLocal}
                  canViewAccommodations={canViewAccommodations}
                  canPrintOthers={canPrintOthers}
                  onRequestChange={requestChange}
                  onStartRename={() => setEditingNameFor(r.email)}
                  onCommitRename={(name) => commitRename(r, name)}
                  onCancelRename={() => setEditingNameFor(null)}
                  onReset={() => setResetTarget(r)}
                  onConvertOauth={() => setConvertTarget(r)}
                  onClear2fa={() => runClear2fa(r)}
                  onAccommodations={() => setAccTarget(r)}
                  onDelete={() => setDeleteTarget(r)}
                  onOffboard={() => setOffboardTarget(r)}
                  onReactivate={() => runReactivate(r)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <ConfirmRoleChange
        change={pendingChange}
        adminEmail={adminEmail}
        roleOptions={roleOptions}
        pending={isPending}
        onCancel={() => !isPending && setPendingChange(null)}
        onConfirm={confirmChange}
      />

      <AddUserDialog
        open={addOpen}
        roleOptions={roleOptions}
        onOpenChange={setAddOpen}
        onDone={() => {
          setAddOpen(false);
          router.refresh();
        }}
      />

      <ResetPasswordDialog
        target={resetTarget}
        onOpenChange={(v) => !v && setResetTarget(null)}
        onDone={() => {
          setResetTarget(null);
          router.refresh();
        }}
      />

      <ConvertOauthDialog
        target={convertTarget}
        pending={isPending}
        onCancel={() => !isPending && setConvertTarget(null)}
        onConfirm={runConvertOauth}
      />

      <DeleteUserDialog
        target={deleteTarget}
        pending={isPending}
        onCancel={() => !isPending && setDeleteTarget(null)}
        onConfirm={runDelete}
      />

      <OffboardUserDialog
        target={offboardTarget}
        pending={isPending}
        onCancel={() => !isPending && setOffboardTarget(null)}
        onConfirm={runOffboard}
      />

      {canViewAccommodations && (
        <AccommodationsDialog
          target={accTarget}
          canEdit={canEditAccommodations}
          onOpenChange={(v) => !v && setAccTarget(null)}
        />
      )}
    </div>
  );
}

function UserRowView({
  row: r,
  roleOptions,
  busy,
  editingName,
  canManageLocal,
  canViewAccommodations,
  canPrintOthers,
  onRequestChange,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onReset,
  onConvertOauth,
  onClear2fa,
  onAccommodations,
  onDelete,
  onOffboard,
  onReactivate,
}: {
  row: UserRow;
  roleOptions: RoleOption[];
  busy: boolean;
  editingName: boolean;
  canManageLocal: boolean;
  canViewAccommodations: boolean;
  canPrintOthers: boolean;
  onRequestChange: (row: UserRow, nextRole: string) => void;
  onStartRename: () => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
  onReset: () => void;
  onConvertOauth: () => void;
  onClear2fa: () => void;
  onAccommodations: () => void;
  onDelete: () => void;
  onOffboard: () => void;
  onReactivate: () => void;
}) {
  const displayName = r.preferredName || r.name || r.email;
  return (
    <TableRow>
      <TableCell className="max-w-0">
        <div className="flex items-center gap-3">
          <Avatar size="sm">
            {r.picture ? <AvatarImage src={r.picture} alt="" /> : null}
            <AvatarFallback>{initials(displayName, r.email)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            {editingName ? (
              <Input
                autoFocus
                defaultValue={r.name}
                onBlur={(e) => onCommitRename(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  else if (e.key === 'Escape') {
                    (e.target as HTMLInputElement).value = r.name;
                    onCancelRename();
                  }
                }}
                className="h-7 w-44"
                aria-label={`Edit name for ${r.email}`}
              />
            ) : (
              <button
                type="button"
                onClick={canManageLocal ? onStartRename : undefined}
                disabled={!canManageLocal}
                title={canManageLocal ? 'Click to edit the directory name' : undefined}
                className="block max-w-full truncate text-left font-medium text-foreground outline-none focus-visible:underline disabled:cursor-default"
              >
                {displayName}
                {r.isSelf && (
                  <span className="ml-2 align-middle text-xs font-normal text-muted-foreground">(you)</span>
                )}
              </button>
            )}
            <span className="block truncate font-mono text-xs text-muted-foreground">{r.email}</span>
            {r.offboardedAt ? (
              <Badge
                variant="outline"
                className="mt-1 gap-1 text-[10px] text-warning"
                style={{ color: 'var(--warning)', borderColor: 'var(--warning)' }}
              >
                <UserMinus className="size-2.5" aria-hidden /> Offboarded
              </Badge>
            ) : null}
          </div>
        </div>
      </TableCell>

      <TableCell className="hidden text-sm md:table-cell">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground">{r.sourceLabel || '—'}</span>
          {r.twofaEnrolled && (
            <Badge variant="secondary" className="text-[10px]">
              2FA
            </Badge>
          )}
          {/* "No password" is implied for an OIDC/OAuth account — only flag it on a local account. */}
          {!/^(oidc|oauth|github|google)/i.test(String(r.source || '')) && r.hasLocalAccount && !r.hasPassword && (
            <Badge variant="outline" className="text-[10px] text-muted-foreground">
              no password
            </Badge>
          )}
          {r.locked && (
            <Badge variant="outline" className="gap-1 text-[10px] text-warning" style={{ color: 'var(--warning)', borderColor: 'var(--warning)' }}>
              <Lock className="size-2.5" aria-hidden /> locked
            </Badge>
          )}
        </div>
      </TableCell>

      <TableCell className="hidden text-sm text-muted-foreground tabular-nums md:table-cell">{fmtLastLogin(r.lastLoginAt)}</TableCell>

      <TableCell className="hidden md:table-cell">
        <RoleBadge role={r.role} />
      </TableCell>

      <TableCell className="text-right">
        {r.isSelf ? (
          <span
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground"
            title="You can't change your own role"
          >
            <Lock className="size-3.5" aria-hidden /> Locked
          </span>
        ) : (
          <Select value={r.role} disabled={busy} onValueChange={(next) => onRequestChange(r, next)}>
            <SelectTrigger className="ml-auto w-36" aria-label={`Change role for ${r.email}`}>
              {busy ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden /> Saving…
                </span>
              ) : (
                <SelectValue />
              )}
            </SelectTrigger>
            <SelectContent>
              {roleOptions.map((o) => (
                <SelectItem key={o.id} value={o.id}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </TableCell>

      <TableCell className="text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={`Actions for ${r.email}`}>
              <MoreHorizontal className="size-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {canManageLocal && (
              <DropdownMenuItem onSelect={onReset}>
                <KeyRound className="size-4" aria-hidden />
                {r.hasPassword ? 'Reset password…' : 'Set local password…'}
              </DropdownMenuItem>
            )}
            {canManageLocal && r.hasPassword && (
              <DropdownMenuItem onSelect={onConvertOauth}>
                <Globe className="size-4" aria-hidden /> Convert to OAuth-only…
              </DropdownMenuItem>
            )}
            {canManageLocal && r.twofaEnrolled && (
              <DropdownMenuItem onSelect={onClear2fa}>
                <ShieldOff className="size-4" aria-hidden /> Clear 2FA
              </DropdownMenuItem>
            )}
            {canViewAccommodations && (
              <DropdownMenuItem onSelect={onAccommodations}>
                <HeartPulse className="size-4" aria-hidden /> Accommodations…
              </DropdownMenuItem>
            )}
            {canPrintOthers && (
              <DropdownMenuItem asChild>
                <a
                  href={`/config/users/itinerary/print?email=${encodeURIComponent(r.email)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Printer className="size-4" aria-hidden /> Print itinerary
                </a>
              </DropdownMenuItem>
            )}
            {canManageLocal && !r.isSelf && (
              <>
                <DropdownMenuSeparator />
                {r.offboardedAt ? (
                  <DropdownMenuItem onSelect={onReactivate}>
                    <UserCheck className="size-4" aria-hidden /> Reactivate
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onSelect={onOffboard}>
                    <UserMinus className="size-4" aria-hidden /> Offboard…
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                  <Trash2 className="size-4" aria-hidden /> Delete user
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

function ConfirmRoleChange({
  change,
  adminEmail,
  roleOptions,
  pending,
  onCancel,
  onConfirm,
}: {
  change: { row: UserRow; nextRole: string } | null;
  adminEmail: string;
  roleOptions: RoleOption[];
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const open = change !== null;
  const fromLabel = change ? roleLabel(change.row.role, roleOptions) : '';
  const toLabel = change ? roleLabel(change.nextRole, roleOptions) : '';
  const toRank = change ? roleOptions.find((o) => o.id === change.nextRole)?.rank ?? 0 : 0;
  const fromRank = change ? roleOptions.find((o) => o.id === change.row.role)?.rank ?? 0 : 0;
  const isPromotion = toRank > fromRank;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isPromotion ? 'Promote user?' : 'Change user role?'}</DialogTitle>
          <DialogDescription>
            {change && (
              <>
                Change <strong className="text-foreground">{change.row.email}</strong> from{' '}
                <strong className="text-foreground">{fromLabel}</strong> to{' '}
                <strong className="text-foreground">{toLabel}</strong>?
                {isPromotion && (
                  <span className="mt-2 block text-warning">
                    This grants more access. You ({adminEmail}) are doing this as an admin — it&apos;s
                    recorded in the audit log.
                  </span>
                )}
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" autoFocus disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button onClick={onConfirm} disabled={pending}>
            {pending && <Loader2 className="animate-spin" aria-hidden />}
            {pending ? 'Saving…' : isPromotion ? 'Promote' : 'Change role'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Add user ────────────────────────────────────────────────────────────────────────────────────
function AddUserDialog({
  open,
  roleOptions,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  roleOptions: RoleOption[];
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('read-only');
  const [createLocal, setCreateLocal] = useState(false);
  const [tempPassword, setTempPassword] = useState('');
  const [pending, startTransition] = useTransition();

  function reset() {
    setEmail('');
    setName('');
    setRole('read-only');
    setCreateLocal(false);
    setTempPassword('');
  }

  function submit() {
    const e = email.trim().toLowerCase();
    if (!e || !e.includes('@')) {
      toast.error('Enter a valid email.');
      return;
    }
    if (createLocal && tempPassword.length < 8) {
      toast.error('The temporary password must be at least 8 characters.');
      return;
    }
    startTransition(async () => {
      const res = await addUserAction({ email: e, name, role, createLocal, tempPassword });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(createLocal ? `Created a local account for ${e}.` : `Added ${e} as an OAuth-only (Google) user.`);
      reset();
      onDone();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add user</DialogTitle>
          <DialogDescription>
            By default the user signs in with Google (OAuth-only) — no password. Tick the box below to
            make it a local password account instead.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="add-email">Email</Label>
            <Input
              id="add-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="add-name">Display name</Label>
            <Input id="add-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name (optional)" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="add-role">Role</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger id="add-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roleOptions.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <label className="flex items-center gap-2.5 rounded-md border border-border p-3 text-sm">
            <Checkbox checked={createLocal} onCheckedChange={(v) => setCreateLocal(v === true)} />
            <span>
              Make it a local password account instead
              <span className="block text-xs text-muted-foreground">
                A temporary password the user must change. Mandatory 2FA on first sign-in. Leave
                unticked for Google (OAuth) sign-in.
              </span>
            </span>
          </label>
          {createLocal && (
            <div className="space-y-1.5">
              <Label htmlFor="add-temp">Temporary password</Label>
              <Input
                id="add-temp"
                type="text"
                value={tempPassword}
                onChange={(e) => setTempPassword(e.target.value)}
                placeholder="At least 8 characters"
                autoComplete="new-password"
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button onClick={submit} disabled={pending}>
            {pending && <Loader2 className="animate-spin" aria-hidden />}
            Add user
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Reset / set local password (+ clear 2FA) ─────────────────────────────────────────────────────
function ResetPasswordDialog({
  target,
  onOpenChange,
  onDone,
}: {
  target: UserRow | null;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}) {
  const [tempPassword, setTempPassword] = useState('');
  const [clear2fa, setClear2fa] = useState(true);
  const [pending, startTransition] = useTransition();
  const open = target !== null;
  const isSet = target ? !target.hasPassword : false;

  function submit() {
    if (!target) return;
    if (tempPassword.length < 8) {
      toast.error('The temporary password must be at least 8 characters.');
      return;
    }
    startTransition(async () => {
      const res = await resetPasswordAction(target.email, tempPassword, clear2fa);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(`${isSet ? 'Set a local password' : 'Reset the password'} for ${target.email}.`);
      setTempPassword('');
      setClear2fa(true);
      onDone();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setTempPassword('');
          setClear2fa(true);
        }
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isSet ? 'Set local password' : 'Reset password'}</DialogTitle>
          <DialogDescription>
            {target && (
              <>
                {isSet ? 'Set an initial' : 'Reset the'} local password for{' '}
                <strong className="text-foreground">{target.email}</strong>. It&apos;s a temporary
                credential — the user must change it at next sign-in.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="reset-temp">Temporary password</Label>
            <Input
              id="reset-temp"
              type="text"
              value={tempPassword}
              onChange={(e) => setTempPassword(e.target.value)}
              placeholder="At least 8 characters"
              autoComplete="new-password"
            />
          </div>
          <label className="flex items-center gap-2.5 text-sm">
            <Checkbox checked={clear2fa} onCheckedChange={(v) => setClear2fa(v === true)} />
            Also clear two-factor (the user re-enrolls an authenticator)
          </label>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button onClick={submit} disabled={pending}>
            {pending && <Loader2 className="animate-spin" aria-hidden />}
            {isSet ? 'Set password' : 'Reset password'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConvertOauthDialog({
  target,
  pending,
  onCancel,
  onConfirm,
}: {
  target: UserRow | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Convert to OAuth-only?</DialogTitle>
          <DialogDescription>
            {target && (
              <>
                Set <strong className="text-foreground">{target.email}</strong> to sign in with Google
                only. Their password is removed (the sign-in page will offer Google), and their passkeys
                stay. Use &ldquo;Set local password&rdquo; later to switch them back to a local account.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" autoFocus disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button onClick={onConfirm} disabled={pending}>
            {pending && <Loader2 className="animate-spin" aria-hidden />}
            Convert to OAuth-only
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteUserDialog({
  target,
  pending,
  onCancel,
  onConfirm,
}: {
  target: UserRow | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete user?</DialogTitle>
          <DialogDescription>
            {target && (
              <>
                Remove <strong className="text-foreground">{target.email}</strong> from the directory
                and delete any local sign-in account. Their live session ends on its next request and
                sign-in is refused. Use this for a mistaken or duplicate entry — to end a departing
                employee&apos;s access while keeping their record and event history, choose{' '}
                <strong className="text-foreground">Offboard</strong> instead.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" autoFocus disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button variant="destructive" onClick={onConfirm} disabled={pending}>
            {pending && <Loader2 className="animate-spin" aria-hidden />}
            Delete user
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Offboard (terminated employee — revoke access, keep the record) ──────────────────────────────
function OffboardUserDialog({
  target,
  pending,
  onCancel,
  onConfirm,
}: {
  target: UserRow | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Offboard user?</DialogTitle>
          <DialogDescription>
            {target && (
              <>
                Revoke all access for <strong className="text-foreground">{target.email}</strong>. Every
                sign-in (password, SSO, passkey) is refused, any live session ends on its next request,
                and their API keys and calendar feeds stop working. Their account, event rosters, and
                travel history are <strong className="text-foreground">kept</strong>; they&apos;re
                removed from staffing pickers going forward. Reassign them as lead on any active events.
                Reversible any time with Reactivate.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" autoFocus disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button onClick={onConfirm} disabled={pending}>
            {pending && <Loader2 className="animate-spin" aria-hidden />}
            Offboard
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Per-user accommodations (PII) ────────────────────────────────────────────────────────────────
function AccommodationsDialog({
  target,
  canEdit,
  onOpenChange,
}: {
  target: UserRow | null;
  canEdit: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [profile, setProfile] = useState<AccommodationsProfile | null>(null);
  const [draft, setDraft] = useState<AccommodationsProfile | null>(null);
  const [pending, startTransition] = useTransition();
  const open = target !== null;
  const targetEmail = target?.email ?? null;

  // Load the subject's accommodations when the dialog opens for a target (effect, not render-time —
  // a Server Action must never fire from the render body). Re-runs whenever the target changes; a
  // cancellation flag drops a stale response if the dialog re-targets/closes mid-flight.
  useEffect(() => {
    if (!targetEmail) return;
    let cancelled = false;
    setLoading(true);
    setProfile(null);
    setDraft(null);
    getUserAccommodationsAction(targetEmail).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (res.error) {
        toast.error(res.error);
        setProfile(null);
        return;
      }
      setProfile(res.accommodations ?? null);
      setDraft(res.accommodations ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [targetEmail]);

  function save() {
    if (!target || !draft) return;
    startTransition(async () => {
      const res = await saveUserAccommodationsAction(target.email, draft);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(`Saved accommodations for ${target.email}.`);
      onOpenChange(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setProfile(null);
          setDraft(null);
        }
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Accommodations</DialogTitle>
          <DialogDescription>
            {target && (
              <>
                Sensitive personal data for <strong className="text-foreground">{target.email}</strong> —
                dietary, accessibility, medical context, and emergency contacts. Handle carefully.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
          </div>
        ) : canEdit ? (
          <AccommodationsEditor value={profile} readOnly={pending} onChange={(d) => setDraft(d)} />
        ) : (
          <AccommodationsReadOnly profile={profile} />
        )}

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={pending}>
              {canEdit ? 'Cancel' : 'Close'}
            </Button>
          </DialogClose>
          {canEdit && (
            <Button onClick={save} disabled={pending || loading}>
              {pending && <Loader2 className="animate-spin" aria-hidden />}
              Save
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// A compact read-only view when the viewer has accommodations.view but not .edit (today both are
// manager+ so an admin always edits — but this keeps the surface honest if that ever diverges).
function AccommodationsReadOnly({ profile }: { profile: AccommodationsProfile | null }) {
  if (!profile) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No accommodations on file.</p>;
  }
  const rows: [string, React.ReactNode][] = [
    ['Dietary', (profile.dietary ?? []).join(', ') || '—'],
    ['Allergies', profile.allergies?.text ? `${profile.allergies.text} (${profile.allergies.severity})` : '—'],
    ['Accessibility', (profile.accessibility ?? []).join(', ') || '—'],
    ['Medical', profile.medical || '—'],
    ['Notes', profile.notes || '—'],
    [
      'Emergency contacts',
      (profile.emergencyContacts ?? []).length
        ? (profile.emergencyContacts ?? [])
            .map((c) => [c.name, c.relationship, c.phone, c.email].filter(Boolean).join(' · '))
            .join('; ')
        : '—',
    ],
  ];
  return (
    <dl className="grid gap-2 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[140px_1fr] gap-2">
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">{k}</dt>
          <dd className="text-foreground">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export default UsersTable;
