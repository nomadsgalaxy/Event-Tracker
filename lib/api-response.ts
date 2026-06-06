import { NextResponse } from 'next/server';

// lib/api-response.ts — tiny JSON helpers for the /api/auth/* Route Handlers, so every endpoint
// returns the SAME { error } / { ...ok } shape the client expects (and matches eit_auth._ok/_err).
// Responses are no-store: an auth response must never be cached by an intermediary.

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export function jsonOk(body: Record<string, unknown> = {}, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function jsonErr(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

/** Parse a JSON request body defensively — a malformed/absent body yields {} (never throws). */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === 'object' ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
