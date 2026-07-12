import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** A dialable tel: href from a free-text phone ("+420 777 123 456", "(555) 123-4567 ext 2",
 *  "1-800-FLOWERS"). Keeps a leading + (country code) and letters (vanity numbers — dialers map
 *  them to keypad digits), drops the separators that break some dialers, and carries an
 *  "ext/x 123" suffix as RFC 3966 ;ext= instead of gluing its digits onto the number. Returns
 *  the raw trimmed value when nothing dialable can be extracted (never a dead href). */
export function telHref(phone: unknown): string {
  const s = String(phone ?? '').trim();
  if (!s) return '';
  // Split off an extension: "ext 2", "ext. 2", "x2", "#2" at the end.
  const m = s.match(/^(.*?)(?:\s*(?:ext\.?|extension|x|#)\s*(\d{1,7}))\s*$/i);
  const main = (m ? m[1] : s).trim();
  const ext = m ? m[2] : '';
  const plus = main.startsWith('+') ? '+' : '';
  const dialable = main.replace(/[^0-9A-Za-z]/g, ''); // digits + vanity letters
  // Letters only count as a vanity number when at least one real digit anchors it
  // ("1-800-FLOWERS" yes, "front desk" no).
  if (!dialable || !/\d/.test(dialable)) return `tel:${encodeURIComponent(s)}`;
  return `tel:${plus}${dialable}${ext ? `;ext=${ext}` : ''}`;
}
