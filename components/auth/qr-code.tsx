'use client';

import * as React from 'react';
import qrcode from 'qrcode-generator';

// components/auth/qr-code.tsx — render a QR LOCALLY (qrcode-generator), never a 3rd-party QR service.
// SECURITY: the otpauth:// URI contains the TOTP secret; sending it to an external QR image service
// would leak the secret. We rasterize it in-browser to a data: URI instead. Mount-gated by being a
// client component (qrcode-generator is browser-agnostic but we keep it client-only for parity).
export function QrCode({ value, size = 192, alt = 'QR code' }: { value: string; size?: number; alt?: string }) {
  const dataUrl = React.useMemo(() => {
    if (!value) return '';
    try {
      const qr = qrcode(0, 'M'); // type 0 = auto-size, error-correction M
      qr.addData(value);
      qr.make();
      // cellSize 4, margin 4 — createDataURL returns a GIF data: URI (offline, no network).
      return qr.createDataURL(4, 4);
    } catch {
      return '';
    }
  }, [value]);

  if (!dataUrl) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-border bg-muted text-xs text-muted-foreground"
        style={{ width: size, height: size }}
      >
        QR unavailable
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a local data: URI, not a remote image
    <img
      src={dataUrl}
      alt={alt}
      width={size}
      height={size}
      className="rounded-md border border-border bg-white p-2"
      style={{ width: size, height: size, imageRendering: 'pixelated' }}
    />
  );
}

export default QrCode;
