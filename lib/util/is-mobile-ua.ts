// Server-side first-paint hint from the request's user agent (Chromium phones send
// `Sec-CH-UA-Mobile: ?1` by default; everything else falls back to the UA-string sniff). A HINT
// only — useIsMobile corrects from the real viewport on mount. Lives OUTSIDE the 'use client' hook
// module on purpose: a client module's exports become client references, and CALLING one from a
// Server Component throws at request time (this took /scan down when it lived in the hook file).
export function isMobileUa(headers: { get(name: string): string | null }): boolean {
  const ch = headers.get('sec-ch-ua-mobile');
  if (ch) return ch.includes('?1');
  return /Mobi|Android|iPhone|iPad/i.test(headers.get('user-agent') ?? '');
}
