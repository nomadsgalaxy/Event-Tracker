import 'server-only';
import * as account from '@/app/account/actions';
import * as cases from '@/app/cases/actions';
import * as catalog from '@/app/catalog/actions';
import * as kits from '@/app/catalog/kits/actions';
import * as config from '@/app/config/actions';
import * as admin from '@/app/config/admin-actions';
import * as webhookSubs from '@/app/config/admin/webhook-subscription-actions';
import * as flights from '@/app/event/flight-actions';
import * as bols from '@/app/event/bol-actions';
import * as pallets from '@/app/event/pallet-actions';
import * as report from '@/app/event/[id]/report/actions';
import * as feedback from '@/app/event/feedback-actions';
import * as notifications from '@/app/notifications/actions';
import * as events from '@/app/event/actions';
import * as scan from '@/app/scan/actions';
import * as manifest from '@/app/manifest/actions';
import * as warehouses from '@/app/warehouses/actions';
import * as signoff from '@/app/signoff/actions';

// lib/api/api-v1-actions.ts — the registry behind /api/v1/actions: every app server action a
// full-access key (api.fullaccess) may call, by "<module>.<action>" name, minus the credential ones.

type Action = (...args: unknown[]) => Promise<unknown>;

const MODULES: Record<string, Record<string, unknown>> = {
  account, cases, catalog, kits, config, admin, webhookSubs, flights, bols, pallets, report, feedback,
  notifications, events, scan, manifest, warehouses, signoff,
};

// Account credentials stay UI-only: a leaked key must not be able to sign someone out, or set another
// user's password / 2FA and take the account over.
const BLOCKED = new Set([
  'account.logoutAction',
  'admin.resetPasswordAction',
  'admin.convertToLocalAction',
  'admin.convertToOauthAction',
  'admin.clear2faAction',
]);

export function actionNames(): string[] {
  const out: string[] = [];
  for (const [mod, exports] of Object.entries(MODULES)) {
    for (const [fn, v] of Object.entries(exports)) {
      const name = `${mod}.${fn}`;
      if (typeof v === 'function' && !BLOCKED.has(name)) out.push(name);
    }
  }
  return out.sort();
}

export function resolveAction(name: string): Action | null {
  if (BLOCKED.has(name)) return null;
  const dot = name.indexOf('.');
  if (dot <= 0) return null;
  const exports = MODULES[name.slice(0, dot)];
  const fn = exports && Object.prototype.hasOwnProperty.call(exports, name.slice(dot + 1)) ? exports[name.slice(dot + 1)] : null;
  return typeof fn === 'function' ? (fn as Action) : null;
}

function toFormData(fields: Record<string, unknown>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    for (const one of Array.isArray(v) ? v : [v]) {
      if (one != null) fd.append(k, typeof one === 'string' ? one : JSON.stringify(one));
    }
  }
  return fd;
}

export function decodeArg(a: unknown): unknown {
  if (a && typeof a === 'object' && !Array.isArray(a) && '$formData' in a) {
    const f = (a as { $formData: unknown }).$formData;
    return toFormData(f && typeof f === 'object' ? (f as Record<string, unknown>) : {});
  }
  return a;
}

// Next's redirect()/notFound() throw a control-flow error with a `digest`; report it instead of a 500.
export function controlFlow(e: unknown): { redirect?: string; notFound?: true } | null {
  const digest = (e as { digest?: unknown })?.digest;
  if (typeof digest !== 'string') return null;
  if (digest.startsWith('NEXT_REDIRECT')) return { redirect: digest.split(';')[2] || '' };
  if (digest.startsWith('NEXT_HTTP_ERROR_FALLBACK;404') || digest === 'NEXT_NOT_FOUND') return { notFound: true };
  return null;
}
