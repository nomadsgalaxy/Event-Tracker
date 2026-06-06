'use client';

import { useSyncExternalStore } from 'react';

// flair-library.ts — the reusable-flair palette (Config > Tags). Faithful port of window.flairLibrary
// (index.html ~L25703): a per-browser, localStorage-backed list of { id, emoji, label } that you can
// attach to any tag. It is DELIBERATELY client/local (the source comment: "the library itself is the
// per-browser palette of choices") — when a flair is chosen on a tag we denormalize its emoji onto
// the tag's customEmoji so the chosen glyph travels + syncs WITH the tag record (the gated tag write).
//
// Implemented as a tiny external store (subscribe + getSnapshot) so React stays in sync via
// useSyncExternalStore; the mutators are exposed as static methods on the hook (useFlairLibrary.add /
// .update / .remove), mirroring the source's window.flairLibrary.{add,update,remove}.

export interface FlairDef {
  id: string;
  emoji: string;
  label: string;
}

const KEY = 'eit:flairs:v1';
const DEFAULTS: FlairDef[] = [
  { id: 'priority', emoji: '⭐', label: 'Priority' },
  { id: 'maintenance', emoji: '🔧', label: 'Maintenance' },
  { id: 'shipping', emoji: '📦', label: 'Shipping' },
  { id: 'attention', emoji: '⚠️', label: 'Attention' },
  { id: 'ready', emoji: '✅', label: 'Ready' },
];

const listeners = new Set<() => void>();
// Cache the parsed list as a STABLE reference so useSyncExternalStore's getSnapshot doesn't loop
// (it must return the same reference until the data actually changes).
let cache: FlairDef[] | null = null;

function readRaw(): FlairDef[] {
  if (typeof window === 'undefined') return DEFAULTS.slice();
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) return p as FlairDef[];
    }
  } catch {
    /* fall through to defaults */
  }
  return DEFAULTS.slice();
}

function getSnapshot(): FlairDef[] {
  if (cache === null) cache = readRaw();
  return cache;
}

function getServerSnapshot(): FlairDef[] {
  return DEFAULTS;
}

function write(list: FlairDef[]): void {
  cache = list;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* localStorage may be unavailable (private mode) — the in-memory cache still drives the UI */
  }
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* a listener throwing must not break the others */
    }
  });
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  // Cross-tab: a write in another tab fires `storage`; re-read so this tab stays in sync.
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) {
      cache = null;
      fn();
    }
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

// eitFirstEmoji — take the FIRST emoji/grapheme of a string (the source's truncation so a paste of
// several glyphs only keeps one). Uses Intl.Segmenter when available (correct ZWJ/variation handling),
// else falls back to the first code point.
export function firstEmoji(s: string): string {
  const str = (s ?? '').trim();
  if (!str) return '';
  try {
    if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
      const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      for (const g of seg.segment(str)) return g.segment;
    }
  } catch {
    /* fall through */
  }
  return Array.from(str)[0] ?? '';
}

function uid(): string {
  return 'f' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

/** The React hook: the live flair list. */
export function useFlairLibrary(): FlairDef[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// Static mutators (mirror window.flairLibrary.{add,update,remove}).
useFlairLibrary.list = (): FlairDef[] => getSnapshot();
useFlairLibrary.add = (f: { emoji?: string; label?: string }): FlairDef | null => {
  const emoji = firstEmoji(f.emoji || '');
  if (!emoji) return null;
  const item: FlairDef = { id: uid(), emoji, label: (f.label || '').trim() };
  write([...getSnapshot(), item]);
  return item;
};
useFlairLibrary.update = (id: string, patch: { emoji?: string; label?: string }): void => {
  write(
    getSnapshot().map((f) =>
      f.id !== id
        ? f
        : {
            id: f.id,
            emoji: patch.emoji != null ? firstEmoji(patch.emoji) : f.emoji,
            label: patch.label != null ? patch.label.trim() : f.label,
          }
    )
  );
};
useFlairLibrary.remove = (id: string): void => {
  write(getSnapshot().filter((f) => f.id !== id));
};
