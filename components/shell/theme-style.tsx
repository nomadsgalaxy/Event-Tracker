import { getCurrentUser } from '@/lib/auth/auth';
import { getDb, NOT_DELETED } from '@/lib/db/mongo';
import { themeById, DEFAULT_UI_THEME, type UiTheme } from '@/lib/util/themes';
import type { UserDoc } from '@/lib/types/types';

// ThemeStyle — a Server Component that resolves the SIGNED-IN user's saved UI theme (payload.uiTheme,
// a dark-only accent variant) and emits an inline <style> overriding the accent token family on :root.
// This applies the chosen theme APP-WIDE with NO flash-of-unstyled-content (it's in the document head,
// rendered before paint) and NO client-only read during render — the mount-gate rule. The default
// theme writes the stylesheet's own orange (a no-op), so an unset/signed-out user sees the brand look.
//
// Only the accent family is themed (the dark surfaces are fixed — the dark-only rule); the values are
// the same oklch tokens lib/themes ships, so this never hardcodes a hex outside the token system.

const USERS_COLLECTION = 'users';

async function resolveTheme(): Promise<UiTheme> {
  const user = await getCurrentUser();
  if (!user) return themeById(DEFAULT_UI_THEME);
  try {
    const db = await getDb();
    const doc = await db
      .collection<UserDoc & { payload: { uiTheme?: string } }>(USERS_COLLECTION)
      .findOne({ _id: user.email.toLowerCase(), ...NOT_DELETED }, { projection: { 'payload.uiTheme': 1 } });
    return themeById((doc?.payload as { uiTheme?: string } | undefined)?.uiTheme);
  } catch {
    return themeById(DEFAULT_UI_THEME);
  }
}

export async function ThemeStyle() {
  const theme = await resolveTheme();
  // Build a `.dark{ --primary: …; … }` rule from the theme's vars. We target `.dark` (NOT `:root`) at
  // the SAME specificity as globals.css's .dark token block, and because this inline <style> is emitted
  // AFTER the imported stylesheet in document order it WINS at equal specificity — so it overrides the
  // default --primary. Keys are our own controlled token names + oklch values (no user input).
  const body = Object.entries(theme.vars)
    .map(([k, v]) => `${k}:${v};`)
    .join('');
  return <style id="eit-theme-vars" dangerouslySetInnerHTML={{ __html: `.dark{${body}}` }} />;
}

export default ThemeStyle;
