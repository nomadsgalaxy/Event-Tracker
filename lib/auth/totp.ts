import 'server-only';
import crypto from 'node:crypto';
import { authenticator } from 'otplib';
import { HashAlgorithms } from '@otplib/core';

// lib/auth/totp.ts — RFC-6238 TOTP + recovery codes + at-rest secret wrapping.
//
// FAITHFUL to server/eit_auth.py:
//   • TOTP: SHA1, 6 digits, 30s step, a ±1 step window (totp_verify window=1). otplib is
//     configured to exactly those params so a code that verifies in Python verifies here and
//     vice-versa. The verify is constant-time (otplib's compare + we never branch on the secret).
//   • otpauth:// URI built locally with the same params (issuer "Event Tracker") so a QR rendered
//     CLIENT-SIDE (qrcode-generator — never a 3rd-party QR service) is identical to the Python one.
//   • RECOVERY codes: 8 codes of secrets.token_hex(5) (10 hex chars), HASHED at rest with the SAME
//     PBKDF2 record the password uses (verifyPassword/hashPassword in lib/auth) — never plaintext.
//   • AT-REST WRAP for the TOTP secret: the Python uses an HMAC-CTR keystream + HMAC tag keyed off
//     EIT_AUTH_SECRET. We use AES-256-GCM keyed off a key DERIVED from ET_SESSION_SECRET (HKDF-ish
//     HMAC) — a STRONGER primitive (Node has AES; the Python avoided it only for stdlib purity).
//     The wrapped blob is opaque + self-describing (v2:<iv>:<ct>:<tag>) and only ever decrypted
//     server-side; the plaintext secret NEVER leaves the server except the one-time enroll QR/secret
//     shown to the enrolling user themselves.
//
// The TOTP secret + recovery hashes live on the `auth` credential doc (off the data-plane
// allowlist). Only server-side code here reads/writes them.

const ISSUER = 'Event Tracker';
export const TOTP_DIGITS = 6;
export const TOTP_STEP = 30;
const TOTP_WINDOW = 1; // ±1 step — matches eit_auth.totp_verify(window=1)

// Configure the shared authenticator instance once (otplib mutates a singleton; we set it
// explicitly on every call path to avoid any ambient drift from another import).
function configured(): typeof authenticator {
  authenticator.options = {
    digits: TOTP_DIGITS,
    step: TOTP_STEP,
    window: TOTP_WINDOW,
    algorithm: HashAlgorithms.SHA1, // RFC-6238 SHA1 — matches eit_auth._totp_at (hashlib.sha1)
  };
  return authenticator;
}

/** Generate a fresh base32 TOTP secret (otplib default = 20 base32 chars; any length verifies). */
export function generateTotpSecret(): string {
  return configured().generateSecret();
}

/**
 * Verify a 6-digit code against a base32 secret. Tolerates non-digit input safely (strips it),
 * requires exactly 6 digits, and checks the ±1 step window. Returns false on ANY malformed input
 * (mirrors totp_verify's guards). otplib's verify is constant-time over the candidate windows.
 */
export function verifyTotp(secretB32: string | null | undefined, code: string | null | undefined): boolean {
  if (!secretB32 || code == null) return false;
  const digits = String(code).replace(/\D/g, '');
  if (digits.length !== TOTP_DIGITS) return false;
  try {
    return configured().verify({ token: digits, secret: secretB32 });
  } catch {
    return false;
  }
}

/** Build the otpauth:// provisioning URI (rendered to a QR client-side). Same params as Python. */
export function totpUri(email: string, secretB32: string): string {
  // otplib's keyuri produces otpauth://totp/<issuer>:<email>?secret=...&issuer=...&algorithm=SHA1&
  // digits=6&period=30 — byte-equivalent to eit_auth.totp_uri.
  return configured().keyuri(email, ISSUER, secretB32);
}

// ── At-rest wrapping for the TOTP secret (AES-256-GCM, key derived from ET_SESSION_SECRET) ──
function wrapKey(): Buffer {
  const s = process.env.ET_SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new Error('ET_SESSION_SECRET is required (>=16 chars) to wrap TOTP secrets.');
  }
  // Derive a 32-byte AES key from the session secret with a domain-separation label (so the TOTP
  // wrap key is distinct from the session-signing use of the same secret).
  return crypto.createHmac('sha256', Buffer.from(s, 'utf-8')).update('totp-wrap-v2').digest();
}

/** Encrypt a plaintext TOTP secret for storage. Returns "v2:<iv>:<ct>:<tag>" (base64url parts). */
export function encSecret(plaintext: string): string {
  const key = wrapKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf-8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v2', iv.toString('base64url'), ct.toString('base64url'), tag.toString('base64url')].join(':');
}

/** Decrypt a wrapped TOTP secret. Returns null on ANY tamper/format error (fail-closed). */
export function decSecret(blob: string | null | undefined): string | null {
  if (!blob || typeof blob !== 'string') return null;
  const parts = blob.split(':');
  if (parts.length !== 4 || parts[0] !== 'v2') return null;
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const ct = Buffer.from(parts[2], 'base64url');
    const tag = Buffer.from(parts[3], 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', wrapKey(), iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf-8');
  } catch {
    return null; // bad tag / wrong key / malformed — never leak which
  }
}

/** Generate 8 fresh recovery codes (plaintext, shown ONCE). 10 hex chars each (token_hex(5)). */
export function generateRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () => crypto.randomBytes(5).toString('hex'));
}
