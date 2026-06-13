'use client';

import * as React from 'react';
import Link from 'next/link';
import { LogOut, Settings2, ScrollText, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/util/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { logoutAction } from '@/app/actions/auth';
import { USER_MENU_NAV } from './nav-model';

// user-menu.tsx — the RIGHT-cluster identity trigger + dropdown. The trigger is an avatar + display
// name + an ORANGE role badge (admin/manager/etc.). Opening it reveals the MENU-ONLY destinations:
//   Account & Preferences (/account) · Activity log (/activity) · ─── · Log Off
//
// Account & Activity live ONLY here — they are intentionally absent from the primary nav
// (DESIGN_ALIGNMENT §1.3 / §2.1, NAV_EXCLUDED). Log Off posts the existing logoutAction Server
// Action (clears the session cookie + redirects to /login) via a real <form> + submit <button> so
// it works without JS and keeps menu keyboard semantics.
//
// Identity: the TopBar reads the DIRECTORY record server-side (getUserChrome) and threads the
// preferredName/name + profile picture here; the email local-part + initials are the fallback when
// the directory has neither (e.g. a brand-new SSO user before their first profile edit).

interface UserMenuProps {
  email: string;
  role: string;
  /** Human role label + its token color (resolved by the server from the rbac role table). */
  roleLabel: string;
  roleColor: string;
  /** Directory display name (preferredName -> name). Falls back to the email local-part. */
  displayName?: string;
  /** Profile picture (an Account data-URL upload or the OAuth provider photo URL). */
  picture?: string;
}

/** Derive a friendly display name from an email local-part: "ada.lovelace@x" → "Ada Lovelace". */
function displayNameFromEmail(email: string): string {
  const local = (email.split('@')[0] || email).replace(/[._-]+/g, ' ').trim();
  if (!local) return email;
  return local
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const MENU_ICON = { account: Settings2, activity: ScrollText } as const;

export function UserMenu({ email, role, roleLabel, roleColor, displayName, picture }: UserMenuProps) {
  const name = displayName || displayNameFromEmail(email);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'inline-flex h-11 items-center gap-2 rounded-md pl-1 pr-2 text-sm transition-colors md:h-9',
          'hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background'
        )}
        aria-label={`Account menu for ${name}`}
      >
        <Avatar className="size-7">
          <AvatarImage src={picture || undefined} alt="" />
          <AvatarFallback className="text-xs">{initials(name)}</AvatarFallback>
        </Avatar>
        <span className="hidden max-w-32 truncate font-medium text-foreground sm:inline">
          {name}
        </span>
        <span
          className="hidden rounded-full border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase lg:inline"
          style={{ color: roleColor, borderColor: roleColor }}
        >
          {roleLabel}
        </span>
        <ChevronDown size={14} className="text-muted-foreground" aria-hidden />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" sideOffset={8} className="min-w-56">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="truncate text-sm font-medium text-foreground">{name}</span>
          <span className="truncate font-mono text-xs font-normal text-muted-foreground">
            {email}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {USER_MENU_NAV.map((m) => {
          const Icon = MENU_ICON[m.id as keyof typeof MENU_ICON] ?? Settings2;
          return (
            <DropdownMenuItem key={m.id} asChild>
              <Link href={m.href} className="gap-2">
                <Icon size={16} aria-hidden />
                {m.label}
              </Link>
            </DropdownMenuItem>
          );
        })}

        <DropdownMenuSeparator />

        {/* Log Off → the existing logoutAction Server Action. A real form submit so it works with the
            keyboard + without JS; the menu item's onSelect requests the submit. */}
        <form action={logoutAction}>
          <DropdownMenuItem
            variant="destructive"
            className="gap-2"
            onSelect={(e) => {
              e.preventDefault();
              (e.currentTarget as HTMLElement)
                .closest('form')
                ?.requestSubmit();
            }}
          >
            <LogOut size={16} aria-hidden />
            Log Off
          </DropdownMenuItem>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default UserMenu;
