import type { MetadataRoute } from 'next';

// app/manifest.ts — the PWA web app manifest (served at /manifest.webmanifest, public in the
// middleware). This is what makes Chrome offer "Install app" on Android/desktop — the shell's
// InstallButton has been waiting on it (it listens for beforeinstallprompt, which never fires
// without a manifest). Installed, the app runs standalone (no browser chrome) with the dark shell
// colors; the layout's viewport-fit=cover + safe-area padding keep the bottom tab bar above the
// gesture area on edge-to-edge phones. No service worker by design (public/sw.js is the
// self-destructor for the old Python one) — installability no longer requires one.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Event Tracker',
    short_name: 'Event Tracker',
    description: 'Fully Self Hosted showcase inventory and event manager',
    id: '/',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0b0b0d',
    theme_color: '#0b0b0d',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  };
}
