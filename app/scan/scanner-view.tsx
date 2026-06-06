'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useScanCamera, type ScanResult } from './use-scan-camera';

// app/scan/scanner-view.tsx — the camera scanner surface. Faithful port of index.html ScannerView
// (~L17933): a live <video> (rear camera) with the tap-to-commit detection OVERLAY (an SVG polygon
// over the detected code, scaled out from its centroid to envelop the quiet zone), a ZXing-fallback
// badge, the corner brackets + laser sweep, and every camera state surface:
//   • HTTPS-required (non-secure origin — but localhost IS secure, so dev works)
//   • permission-denied (Camera blocked + Retry)
//   • no-camera
//   • camera-unsupported (no getUserMedia)
//   • generic error (+ Retry)
//   • Start-camera button (before the stream is live)
// Tapping the video commits the freshest detection (the live read already auto-fires on a steady
// decode; the tap is the explicit "commit this one" affordance for an off-axis read).

export function ScannerView({
  onScan,
  height = 220,
  throttleMs = 1200,
  autoStart = true,
  label = '',
}: {
  onScan?: (r: ScanResult) => void;
  height?: number;
  throttleMs?: number;
  autoStart?: boolean;
  label?: string;
}) {
  const cam = useScanCamera({ onScan, throttleMs });
  // HYDRATION-SAFE FIRST PAINT: the server has no `location`/`navigator`/`BarcodeDetector`, so we
  // must NOT branch the rendered tree on any client-only value during the initial render. `mounted`
  // is false on the server AND the first client paint → both render the SAME ssr-stable idle frame
  // (the scan-frame container + a hidden <video> + the Start-camera button, identical markup). Only
  // AFTER mount do we read the secure-context check, the detection overlay, and the camera state +
  // kick off autostart. The container className + the <video> element are byte-identical across the
  // boundary, so React sees a matching tree on hydration (no mismatch).
  const [mounted, setMounted] = useState(false);
  const [tried, setTried] = useState(false);

  // Secure-context check is computed only after mount (reads `location`).
  const isHttpsOrLocal =
    mounted &&
    typeof location !== 'undefined' &&
    (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1');

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (mounted && autoStart && !tried && isHttpsOrLocal) {
      setTried(true);
      cam.start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, autoStart, isHttpsOrLocal]);

  // Before mount: render the SSR-stable idle frame. Identical on the server + the first client paint
  // (no location/camera reads). The camera surfaces (HTTPS-required, permission/error overlays, the
  // detection overlay, ZXing badge) all light up AFTER mount when the real render below takes over.
  if (!mounted) {
    return <IdleFrame height={height} label={label} />;
  }

  // After mount: the HTTPS-required surface (a non-secure origin can't use getUserMedia).
  if (!isHttpsOrLocal) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-1.5 rounded border border-warning/60 bg-card px-3.5 text-center"
        style={{ height }}
      >
        <div className="text-[11px] font-bold uppercase tracking-[0.06em] text-warning">HTTPS required</div>
        <p className="max-w-[260px] text-[11px] text-muted-foreground">
          Camera scanning needs an https:// origin or localhost. Reload the app from a secure URL.
        </p>
      </div>
    );
  }

  // Build the SVG polygon from the latest detection (3-point ZXing finder → parallelogram-completed
  // quad, sorted by angle around the centroid, scaled out 1.22× to envelop the quiet zone).
  const det = cam.detection;
  const detPolygon = (() => {
    if (!det || !det.points || det.points.length < 3 || !(det.videoW > 0) || !(det.videoH > 0)) return null;
    let pts = det.points.map((p) => ({ x: p.x, y: p.y }));
    if (pts.length === 3) {
      const tl = pts[1];
      const tr = pts[2];
      const bl = pts[0];
      pts = [tl, tr, { x: tr.x + (bl.x - tl.x), y: tr.y + (bl.y - tl.y) }, bl];
    }
    let cx = 0;
    let cy = 0;
    for (const p of pts) {
      cx += p.x;
      cy += p.y;
    }
    cx /= pts.length;
    cy /= pts.length;
    pts.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
    const SCALE = 1.22;
    pts = pts.map((p) => ({ x: cx + (p.x - cx) * SCALE, y: cy + (p.y - cy) * SCALE }));
    return pts.map((p) => p.x + ',' + p.y).join(' ');
  })();

  return (
    <div
      className="eit-scan-frame relative overflow-hidden rounded bg-black"
      style={{ height }}
      role={detPolygon ? 'button' : undefined}
      tabIndex={detPolygon ? 0 : undefined}
      onClick={detPolygon ? () => cam.commit() : undefined}
      onKeyDown={
        detPolygon
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                cam.commit();
              }
            }
          : undefined
      }
      aria-label={detPolygon ? 'Tap to commit the detected code' : undefined}
    >
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={cam.videoRef}
        muted
        playsInline
        className="size-full object-cover"
        style={{ display: cam.active ? 'block' : 'none' }}
      />
      {detPolygon && (
        <svg
          viewBox={'0 0 ' + det!.videoW + ' ' + det!.videoH}
          preserveAspectRatio="xMidYMid slice"
          className="pointer-events-none absolute inset-0 size-full"
          aria-hidden="true"
        >
          <polygon
            points={detPolygon}
            fill="rgba(101,201,0,.18)"
            stroke="var(--success, #65c900)"
            strokeWidth={Math.max(2, Math.round(Math.min(det!.videoW, det!.videoH) * 0.016))}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      )}
      {/* Corner brackets + laser sweep (decorative scan-frame chrome). */}
      <span className="pointer-events-none absolute right-2 top-2 size-5 border-r-2 border-t-2 border-success/70" aria-hidden />
      <span className="pointer-events-none absolute bottom-2 left-2 size-5 border-b-2 border-l-2 border-success/70" aria-hidden />
      {label && (
        <div className="absolute left-2 top-2 rounded-[3px] bg-black/60 px-1.5 py-[3px] font-mono text-[10px] tracking-[0.04em] text-foreground">
          {label}
        </div>
      )}
      {cam.usingFallback && cam.active && (
        <div className="absolute right-2 top-2 rounded-[3px] bg-black/60 px-1.5 py-[2px] font-mono text-[9px] tracking-[0.04em] text-foreground">
          ZXing
        </div>
      )}
      {cam.error === 'permission-denied' && (
        <StateOverlay tone="error" title="Camera blocked" line="Allow camera access for this site, then tap Retry." onRetry={cam.start} />
      )}
      {cam.error === 'no-camera' && (
        <StateOverlay tone="error" title="No camera" line="This device has no usable camera. Use Find item or NFC instead." />
      )}
      {cam.error === 'camera-unsupported' && (
        <StateOverlay tone="warning" title="Camera unsupported" line="Browser doesn't expose getUserMedia." />
      )}
      {cam.error && cam.error !== 'permission-denied' && cam.error !== 'no-camera' && cam.error !== 'camera-unsupported' && (
        <StateOverlay tone="error" title="Scanner error" line={cam.error} onRetry={cam.start} />
      )}
      {!cam.active && !cam.error && (
        <Button
          size="sm"
          className="absolute bottom-3 left-1/2 -translate-x-1/2"
          onClick={(e) => {
            e.stopPropagation();
            cam.start();
          }}
        >
          Start camera
        </Button>
      )}
    </div>
  );
}

// IdleFrame — the SSR-stable initial shell. Rendered on the server AND the first client paint (when
// `mounted` is still false), and it reads NO client-only value. Its container className + the hidden
// <video> + the corner brackets + label + Start-camera button are identical to the post-mount idle
// state of the real ScannerView render, so hydration sees a matching tree. The Start button is inert
// here (the camera isn't wired until mount); a tap before mount is a no-op, and autostart kicks in
// immediately after mount on a secure origin anyway.
function IdleFrame({ height, label }: { height: number; label: string }) {
  return (
    <div className="eit-scan-frame relative overflow-hidden rounded bg-black" style={{ height }}>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video muted playsInline className="size-full object-cover" style={{ display: 'none' }} />
      <span className="pointer-events-none absolute right-2 top-2 size-5 border-r-2 border-t-2 border-success/70" aria-hidden />
      <span className="pointer-events-none absolute bottom-2 left-2 size-5 border-b-2 border-l-2 border-success/70" aria-hidden />
      {label && (
        <div className="absolute left-2 top-2 rounded-[3px] bg-black/60 px-1.5 py-[3px] font-mono text-[10px] tracking-[0.04em] text-foreground">
          {label}
        </div>
      )}
      <Button size="sm" className="absolute bottom-3 left-1/2 -translate-x-1/2">
        Start camera
      </Button>
    </div>
  );
}

function StateOverlay({
  tone,
  title,
  line,
  onRetry,
}: {
  tone: 'error' | 'warning';
  title: string;
  line: string;
  onRetry?: () => void;
}) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/85 px-3.5 text-center">
      <div
        className="text-[11px] font-bold uppercase tracking-[0.06em]"
        style={{ color: tone === 'error' ? 'var(--error)' : 'var(--warning)' }}
      >
        {title}
      </div>
      <p className="max-w-[240px] break-words text-[11px] text-muted-foreground">{line}</p>
      {onRetry ? (
        <Button
          variant="outline"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onRetry();
          }}
        >
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export default ScannerView;
