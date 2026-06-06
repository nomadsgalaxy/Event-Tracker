import { requireRole } from '@/lib/auth';
import { ConfigHeader } from './config-header';

// app/config — the CONFIG / ADMIN area. The WHOLE area is admin-only: this layout gates every
// nested route (Users / Permissions / Audit) with requireRole('admin') BEFORE any child Server
// Component renders. An unauthenticated caller is redirected to /login; an authed non-admin gets
// a Forbidden the route's error boundary surfaces as "Not permitted" (distinct from the login
// bounce — they're already signed in, just under-privileged). The Server Actions re-gate
// independently, so this layout gate is defense-in-depth on the READ surface, not the only check.
//
// The signed-in admin's email is threaded into the sub-nav so it's visible on every config tab —
// the user can always see WHO they are, which makes the "you can't change your own role" rule
// legible on the Users page (their own row is the locked one).
export const dynamic = 'force-dynamic';

export default async function ConfigLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireRole('admin');

  return (
    <div className="space-y-6 px-6 py-6">
      <ConfigHeader adminEmail={admin.email} />
      {children}
    </div>
  );
}
