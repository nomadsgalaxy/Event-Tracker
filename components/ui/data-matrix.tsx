import * as React from 'react';

import { cn } from '@/lib/util/utils';
import { eitmCode, type EitmKind } from '@/lib/integrations/eitm';
import { dataMatrixSvg } from '@/lib/integrations/data-matrix';

// components/ui/data-matrix.tsx — renders a scannable Data Matrix for an `eitm:` code (the ENCODE +
// RENDER side of the feature; the scan screen already DECODES). Server Component: the SVG is built
// server-side via lib/data-matrix (bwip-js, server-only) and shipped as inline markup, which is the
// cleanest path for PRINT (no client encoder, no hydration, deterministic bytes). Mirrors the
// Python app's printed labels / case-manifest code box (index.html ~L4704 .case-code .box).
//
// A Data Matrix scans as DARK-on-LIGHT, so the symbol always sits on a white tile (regardless of the
// dark UI) — that tile is the only non-token color here, and it's required for the code to scan
// (DESIGN_SYSTEM §0's no-raw-color rule is about THEME color; a barcode's quiet-zone white is
// functional, like an avatar image). a11y: role="img" + an aria-label naming the entity. Fallback:
// if bwip-js fails (or no code resolves), the plain-text code renders instead — the page never
// crashes (the source's Data Matrix → text fallback).

export interface DataMatrixProps extends Omit<React.ComponentProps<'figure'>, 'children'> {
  /** Entity kind for the `eitm:` payload: 'c'(ase) / 'i'(tem) / 'e'(vent). */
  kind?: EitmKind;
  /** The entity's raw id. Encoded with `kind` into `eitm:<hash>:<kind>:<id>`. */
  id?: string;
  /** The deploy tenant hash (from a Server Component that already computed it). Omit to read the env. */
  tenantHash?: string;
  /** A pre-built `eitm:` payload string — use INSTEAD of kind/id (e.g. the print path passes the
   *  exact code it embeds elsewhere so screen + print + scan all agree). */
  code?: string;
  /** Tile edge length (px). Default 128 — matches the source's ~108-128px case-code box. */
  size?: number;
  /** Accessible label, e.g. "Data Matrix code for Front-of-house case". Falls back to the payload. */
  label?: string;
  /** Hide the small mono caption under the code (shown by default for human-readable redundancy). */
  hideCaption?: boolean;
}

/** Resolve the `eitm:` payload from either the explicit `code` prop or the kind/id pair. */
function resolvePayload(props: Pick<DataMatrixProps, 'code' | 'kind' | 'id' | 'tenantHash'>): string {
  if (props.code) return props.code;
  if (props.kind && props.id) return eitmCode(props.kind, props.id, props.tenantHash);
  return '';
}

export function DataMatrix({
  kind,
  id,
  tenantHash,
  code,
  size = 128,
  label,
  hideCaption = false,
  className,
  ...props
}: DataMatrixProps) {
  const payload = resolvePayload({ code, kind, id, tenantHash });
  const ariaLabel = label || (payload ? `Data Matrix code: ${payload}` : 'No code available');

  // Encode server-side; on failure fall through to the plain-text code (never crash the page).
  let svg = '';
  if (payload) {
    try {
      svg = dataMatrixSvg(payload);
    } catch {
      svg = '';
    }
  }

  return (
    <figure
      className={cn('inline-flex flex-col items-center gap-1', className)}
      {...props}
    >
      <div
        role="img"
        aria-label={ariaLabel}
        className="grid place-items-center rounded-md border border-border bg-white p-1.5"
        style={{ width: size, height: size }}
      >
        {svg ? (
          // The bwip-js SVG already declares its own viewBox; box it to fill the white tile.
          <span
            className="block size-full [&>svg]:block [&>svg]:size-full"
            // eslint-disable-next-line react/no-danger -- server-built, deterministic bwip-js SVG (no user HTML).
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <span className="break-all px-1 text-center font-mono text-[8px] leading-tight text-black">
            {payload || '—'}
          </span>
        )}
      </div>
      {!hideCaption && payload ? (
        <figcaption className="max-w-full truncate font-mono text-[10px] text-muted-foreground">
          {payload}
        </figcaption>
      ) : null}
    </figure>
  );
}

export default DataMatrix;
