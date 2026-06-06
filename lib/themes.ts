// lib/themes.ts — the UI theme registry for the Next.js rebuild.
//
// PARITY-WITH-CONSTRAINT: the Python app ships a full multi-theme system (window.eitThemes) that
// swaps the ENTIRE palette, including LIGHT modes. DESIGN_SYSTEM.md §0 mandates the rebuild is
// DARK-FIRST, DARK-ONLY — no light theme, no light toggle. So we port the theme SELECTOR's feature
// + behavior (live preview, revert-on-leave, swatch chips, the "Live preview applied" caption,
// persistence to the user's directory record) but constrain the themes to DARK accent variants.
// Each theme only re-tints the brand ACCENT family (--primary / --ring / --st-in_transit, the
// orange status token) via custom properties on <html>; the near-black surfaces stay fixed (the
// dark-only rule). Values are oklch — NEVER a raw hex in a component (the token rule). This mirrors
// the Python built-ins' DARK members (Dark Mystery / Pro Green Dark / High Contrast).
//
// Client-safe (no `server-only`): the Account preferences panel (a Client Component) reads this to
// render the <select> + swatches + apply the live preview; the boot script + the Server read both
// validate an id against THEME_IDS.

export interface UiTheme {
  /** Stable id, stored on the user record (payload.uiTheme). Matches /^[a-z0-9_-]+$/. */
  id: string;
  /** Human label for the <select>. */
  label: string;
  /** Short descriptor shown after the label (the source's `hint`). */
  hint: string;
  /** The accent swatch chip color (a CSS color — the brand accent for this theme). */
  swatch: string;
  /** The surface chip color (kept near-black across all dark themes — shown for parity with the
   *  source's two-swatch preview). */
  surface: string;
  /** The CSS custom-property overrides this theme writes onto <html> when active. Keyed by var
   *  name; only the accent family is themed (dark-only). */
  vars: Record<string, string>;
}

// The DEFAULT theme is the current brand orange (matches globals.css's .dark --primary). Selecting
// it clears any override (back to the stylesheet default).
export const DEFAULT_UI_THEME = 'dark-mystery';

export const UI_THEMES: readonly UiTheme[] = [
  {
    id: 'dark-mystery',
    label: 'Dark Mystery',
    hint: 'Orange on near-black (default)',
    swatch: 'oklch(0.66 0.20 40)',
    surface: 'oklch(0.145 0.004 286)',
    // The stylesheet default — selecting it writes the same values (a no-op tint), so applying it
    // after another theme cleanly restores the brand orange.
    vars: {
      '--primary': 'oklch(0.66 0.20 40)',
      '--ring': 'oklch(0.66 0.20 40)',
      '--st-in_transit': 'oklch(0.66 0.20 40)',
    },
  },
  {
    id: 'pro-green-dark',
    label: 'Pro Green · Dark',
    hint: 'Green accent on dark',
    swatch: 'oklch(0.72 0.17 162)',
    surface: 'oklch(0.145 0.004 286)',
    vars: {
      '--primary': 'oklch(0.72 0.17 162)',
      // Green is light enough for dark text to clear AA — keep the dark foreground.
      '--primary-foreground': 'oklch(0.18 0.02 162)',
      '--ring': 'oklch(0.72 0.17 162)',
      '--st-in_transit': 'oklch(0.72 0.17 162)',
    },
  },
  {
    id: 'ocean-dark',
    label: 'Ocean · Dark',
    hint: 'Blue accent on dark',
    swatch: 'oklch(0.62 0.17 250)',
    surface: 'oklch(0.145 0.004 286)',
    vars: {
      '--primary': 'oklch(0.62 0.17 250)',
      '--primary-foreground': 'oklch(0.98 0.005 250)',
      '--ring': 'oklch(0.62 0.17 250)',
      '--st-in_transit': 'oklch(0.62 0.17 250)',
    },
  },
  {
    id: 'high-contrast',
    label: 'High Contrast',
    hint: 'Maximum legibility, WCAG-AAA focus',
    swatch: 'oklch(0.92 0.19 100)',
    surface: 'oklch(0.0 0 0)',
    vars: {
      '--primary': 'oklch(0.92 0.19 100)',
      '--primary-foreground': 'oklch(0.0 0 0)',
      '--ring': 'oklch(0.92 0.19 100)',
      '--st-in_transit': 'oklch(0.85 0.16 200)',
    },
  },
];

export const THEME_IDS: readonly string[] = UI_THEMES.map((t) => t.id);

/** Resolve an id to a known theme, falling back to the default (never returns undefined). */
export function themeById(id: string | null | undefined): UiTheme {
  const t = UI_THEMES.find((x) => x.id === id);
  return t || UI_THEMES.find((x) => x.id === DEFAULT_UI_THEME)!;
}

/** Validate + clamp an arbitrary value to a known theme id (used server-side on save). */
export function clampThemeId(id: unknown): string {
  const s = typeof id === 'string' ? id : '';
  return THEME_IDS.includes(s) ? s : DEFAULT_UI_THEME;
}

// The full var set we may set/clear when switching themes (the union across all themes). Applying a
// theme clears EVERY key in this set first, then writes only that theme's vars — so leaving a theme
// that set --primary-foreground (e.g. high-contrast) doesn't leave a stale override behind. Mirrors
// the Python apply()'s VAR_CONTRACT clear-then-set.
export const THEME_VAR_KEYS: readonly string[] = Array.from(
  new Set(UI_THEMES.flatMap((t) => Object.keys(t.vars)))
);

/**
 * Apply a theme to <html> by writing its CSS custom-property overrides (clear-then-set so no stale
 * override survives a switch). CLIENT-ONLY — guards on `document` so it is inert during SSR / the
 * initial server render (the mount-gate rule). Returns the applied id.
 */
export function applyTheme(id: string | null | undefined): string {
  const theme = themeById(id);
  if (typeof document === 'undefined') return theme.id;
  const root = document.documentElement;
  for (const k of THEME_VAR_KEYS) root.style.removeProperty(k);
  for (const [k, v] of Object.entries(theme.vars)) root.style.setProperty(k, v);
  return theme.id;
}
