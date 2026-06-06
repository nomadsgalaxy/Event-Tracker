'use server';

import { redirect } from 'next/navigation';
import { clearSessionCookie } from '@/lib/session';

// app/actions/auth.ts — the logout Server Action.
//
// The LOGIN flow now lives in the staged /api/auth/* Route Handlers (password → 2FA / setup / forced
// change → full session), driven by app/login/login-form.tsx — the server is the sole authority over
// what session is granted there. Logout is the one auth mutation that fits a plain form-action: it
// clears the HttpOnly session cookie and redirects to /login.
//
// SECURITY: clearing the cookie is the only state change; there's no credential here to leak.

export async function logoutAction(): Promise<void> {
  await clearSessionCookie();
  redirect('/login');
}
