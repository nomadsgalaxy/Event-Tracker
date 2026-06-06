'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { MapPin } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/util/utils';

// components/ui/places-address-field.tsx — the Google Places autocomplete address field.
//
// A faithful port of the Python PlacesAddressField (index.html ~L9786): a text input wired to Google
// Places Autocomplete. When the user picks a suggestion, onPlace fires with a parsed
// { address, city, state, zip, lat, lng } bag so the parent form fans it out to its other fields.
//
// KEY FLAG / STUB: the Google Maps JS SDK runs in the BROWSER and needs a public key. We read it from
// NEXT_PUBLIC_GOOGLE_PLACES_API_KEY (NEXT_PUBLIC_* is the only env that's safe to expose client-side).
// When it's ABSENT we render a plain <input> and a small inline note flagging the key needed — exactly
// like the Python degrades when no key is configured (and like lib/weather.ts flags its key). When the
// key IS present we lazy-load the SDK and bind Autocomplete (legacy) or the new PlaceAutocompleteElement.
//
// SSR-safety: we never touch window/google during the initial render. The SDK load + bind happens in a
// mount effect (mounted-gate), so the server render and first client render are identical (no hydration
// mismatch). The plain input is always the SSR/first-paint shape.

export interface ParsedPlace {
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  lat?: number;
  lng?: number;
}

// ── Google Maps SDK loader (browser-only, idempotent) ──────────────────────────────────────────
// Lazy-injects the Maps JS script ONCE per page and resolves when google.maps.places is ready.
// Mirrors the Python window.eitLoadGoogleMaps (index.html). No-op + reject when no public key.
type MapsNamespace = typeof globalThis & {
  google?: { maps?: { places?: unknown; importLibrary?: (name: string) => Promise<unknown> } };
};
let mapsPromise: Promise<unknown> | null = null;

function placesReady(w: MapsNamespace): boolean {
  return typeof (w.google?.maps?.places as { Autocomplete?: unknown } | undefined)?.Autocomplete === 'function';
}

function loadGoogleMaps(key: string): Promise<unknown> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  const w = window as MapsNamespace;
  if (placesReady(w)) return Promise.resolve(w);
  if (mapsPromise) return mapsPromise;
  mapsPromise = new Promise((resolve, reject) => {
    // With `loading=async` the script's `load` event fires BEFORE google.maps.places is populated, and
    // mixing it with `libraries=places` makes both the load event and importLibrary-at-load unreliable
    // for knowing when the widget can bind. So we POLL for google.maps.places.Autocomplete (the thing
    // we actually need) and resolve once it exists — robust to whichever load path Google takes. We
    // resolve the WINDOW (not window.google) because the binding effect reads `(resolved).google.maps`.
    const start = Date.now();
    const poll = () => {
      if (placesReady(w)) return resolve(w);
      if (Date.now() - start > 15000) return reject(new Error('Google Maps Places timed out'));
      setTimeout(poll, 120);
    };
    if (!document.getElementById('eit-gmaps-sdk')) {
      const s = document.createElement('script');
      s.id = 'eit-gmaps-sdk';
      s.async = true;
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=places&loading=async`;
      s.addEventListener('error', () => reject(new Error('Google Maps failed to load')), { once: true });
      document.head.appendChild(s);
    }
    poll();
  });
  return mapsPromise;
}

// Parse a Google Place (legacy Autocomplete getPlace() OR the new Place after fetchFields) into the
// flat { address, city, state, zip, lat, lng } bag the form needs. Verbatim component mapping from the
// Python eitParsePlace.
interface AddrComp {
  types?: string[];
  long_name?: string;
  short_name?: string;
  longText?: string;
  shortText?: string;
}
interface PlaceLike {
  formatted_address?: string;
  formattedAddress?: string;
  address_components?: AddrComp[];
  addressComponents?: AddrComp[];
  geometry?: { location?: { lat?: () => number; lng?: () => number } };
  location?: { lat?: () => number | number; lng?: () => number | number };
}

function parsePlace(place: PlaceLike): ParsedPlace {
  const comps = place.address_components || place.addressComponents || [];
  const get = (type: string, short = false): string => {
    const c = comps.find((x) => (x.types || []).includes(type));
    if (!c) return '';
    return short ? c.short_name || c.shortText || '' : c.long_name || c.longText || c.short_name || c.shortText || '';
  };
  const streetNumber = get('street_number');
  const route = get('route');
  const street = [streetNumber, route].filter(Boolean).join(' ');
  const out: ParsedPlace = {
    address: street || place.formatted_address || place.formattedAddress || '',
    city: get('locality') || get('postal_town') || get('sublocality') || '',
    state: get('administrative_area_level_1', true),
    zip: get('postal_code'),
  };
  // lat/lng — legacy geometry.location.lat()/lng() OR the new Place.location (numbers or fns).
  const loc = place.geometry?.location || place.location;
  if (loc) {
    const la = typeof loc.lat === 'function' ? loc.lat() : (loc.lat as number | undefined);
    const ln = typeof loc.lng === 'function' ? loc.lng() : (loc.lng as number | undefined);
    if (typeof la === 'number' && Number.isFinite(la)) out.lat = la;
    if (typeof ln === 'number' && Number.isFinite(ln)) out.lng = ln;
  }
  return out;
}

export function PlacesAddressField({
  value,
  onChange,
  onPlace,
  placeholder,
  disabled,
  placesAvailable,
  className,
  'aria-label': ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  onPlace: (p: ParsedPlace) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Server-advertised: is a Google key wired? When false we render the plain input + flag the key. */
  placesAvailable: boolean;
  className?: string;
  'aria-label'?: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [bound, setBound] = useState(false);
  const flagId = useId();

  // Latest-callback ref — the Places listener binds once per mount, so without this it would call
  // the FIRST render's stale onPlace (the same ref fix the Python uses). The plain input's onChange
  // is read inline (not from the listener), so it needs no ref.
  const onPlaceRef = useRef(onPlace);
  useEffect(() => {
    onPlaceRef.current = onPlace;
  });

  // The public browser key — first the build-time NEXT_PUBLIC_* inline (if set), else fetched at
  // runtime from /api/maps-key (the key the admin saved in Config -> Databases & API, which lives in
  // the server store and otherwise can't reach the browser SDK). A Maps browser key is referrer-
  // restricted and meant to be public, so this mirrors the Python /eit-google-config.json exposure.
  const publicKey = useMemo(() => (process.env.NEXT_PUBLIC_GOOGLE_PLACES_API_KEY || '').trim(), []);
  const [fetchedKey, setFetchedKey] = useState('');
  useEffect(() => {
    if (publicKey || !placesAvailable) return; // env key wins; only fetch when the server says one's wired
    let cancelled = false;
    fetch('/api/maps-key')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d && typeof d.key === 'string' && d.key) setFetchedKey(d.key.trim());
      })
      .catch(() => {
        /* plain input is the fallback */
      });
    return () => {
      cancelled = true;
    };
  }, [publicKey, placesAvailable]);
  const browserKey = publicKey || fetchedKey;
  // Only attempt the SDK when the SERVER says a key is wired AND we actually have a browser key.
  const canAutocomplete = placesAvailable && browserKey.length > 0;

  useEffect(() => {
    if (!canAutocomplete || !inputRef.current) return;
    let cancelled = false;
    loadGoogleMaps(browserKey)
      .then((google) => {
        if (cancelled || !inputRef.current) return;
        const places = (google as MapsNamespace).google?.maps?.places as
          | { Autocomplete?: new (el: HTMLInputElement, opts: unknown) => { addListener: (e: string, cb: () => void) => void; getPlace: () => PlaceLike } }
          | undefined;
        if (!places?.Autocomplete) return;
        try {
          const ac = new places.Autocomplete(inputRef.current, {
            types: ['address'],
            fields: ['formatted_address', 'address_components', 'name', 'geometry.location'],
          });
          try {
            inputRef.current.setAttribute('autocomplete', 'eit-no-autofill');
          } catch {
            /* ignore */
          }
          ac.addListener('place_changed', () => {
            const place = ac.getPlace();
            const parts = parsePlace(place);
            onPlaceRef.current(parts);
          });
          setBound(true);
        } catch {
          /* leave as a plain input */
        }
      })
      .catch(() => {
        /* loader logs; plain input is the fallback */
      });
    return () => {
      cancelled = true;
    };
  }, [canAutocomplete, browserKey]);

  return (
    <div className="grid gap-1">
      <Input
        ref={inputRef}
        type="text"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className={cn(className)}
        aria-label={ariaLabel}
        // Suppress Chrome's saved-address picker so the Places dropdown shows (Python parity).
        autoComplete="eit-no-autofill"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-form-type="other"
        data-lpignore="true"
        data-1p-ignore="true"
        aria-describedby={!canAutocomplete ? flagId : undefined}
      />
      {!canAutocomplete && (
        <p id={flagId} className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <MapPin aria-hidden className="size-3 shrink-0" />
          Plain entry — add a Google API key in Config → Databases &amp; API (with the Maps JavaScript +
          Places APIs enabled) to autofill city / state / ZIP.
        </p>
      )}
      {bound && (
        <span className="sr-only" aria-live="polite">
          Address autocomplete ready.
        </span>
      )}
    </div>
  );
}

export default PlacesAddressField;
