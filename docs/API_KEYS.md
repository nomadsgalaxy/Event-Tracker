# Setting up API keys (step by step)

Every integration key is **optional**. The app runs fine without them; each key just lights up one
feature, and anything unconfigured degrades gracefully (address fields fall back to plain typing,
weather and flight lookup hide, etc.). This guide walks you through each one from scratch.

- [How keys are stored](#how-keys-are-stored)
- [Google: address autocomplete + venue weather](#google-address-autocomplete--venue-weather)
- [Flight lookup (AeroDataBox)](#flight-lookup-aerodatabox)
- [Shipment tracking (EasyPost / AfterShip / 17TRACK)](#shipment-tracking)
- [Troubleshooting](#troubleshooting)
- [Security notes](#security-notes)

## How keys are stored

There are two ways to give the app a key:

1. **In the app (recommended)** - sign in as an admin and go to **Config -> Databases & API**.
   Paste the key, Save. It is stored encrypted at rest and takes effect immediately, no redeploy.
2. **Environment variable** - set it in your container env or `.env.local`. An env var always
   **overrides** the in-app value (good for infrastructure-managed secrets).

Resolution order per key: the environment variable wins, otherwise the encrypted in-app value is used.

## Google: address autocomplete + venue weather

One Google key powers two things: **address autocomplete** in the venue and warehouse address fields,
and the **venue weather** forecast on an event. Setup is a few clicks in Google Cloud, then one paste.

### 1. Create a Google Cloud project

1. Go to <https://console.cloud.google.com/>.
2. Top bar -> project dropdown -> **New Project** (or pick an existing one).

### 2. Turn on billing

Google Maps Platform requires a billing account (there is a large monthly free tier that covers
typical use). Console -> **Billing** -> link a billing account to the project.

### 3. Enable the APIs

Console -> **APIs & Services -> Library**, and enable each of these (search by name, click Enable):

- **Maps JavaScript API** - the in-browser autocomplete widget. This is the one most people forget.
- **Places API** - the address suggestions.
- **Geocoding API** - address lookups.
- **Weather API** - the venue forecast.

### 4. Create the key

Console -> **APIs & Services -> Credentials -> Create credentials -> API key**. Copy the key
(looks like `AIzaSy...`).

### 5. Restrict the key

Click the new key to edit it:

- **API restrictions** -> "Restrict key" -> select the four APIs from step 3. (Always do this.)
- **Application restrictions**: the simplest setup that powers BOTH browser autocomplete AND
  server-side weather with one key is **None** (Maps browser keys are designed to be exposed to the
  page; you cap abuse with the API restriction + quotas). If you want it locked to your site and only
  use autocomplete (not weather), choose **HTTP referrers** and add:
  - `https://your-domain.example/*` (your real URL)
  - `http://localhost:3100/*` (local dev)

  Note: an HTTP-referrer restriction blocks server-side calls (weather, the Verify button), because
  those have no referrer. If you want both tight referrer restriction AND weather, use two keys (see
  [tighter setup](#tighter-two-key-setup)).

### 6. Paste it into the app

Sign in as an admin -> **Config -> Databases & API** -> Google API key -> paste -> **Save**. Click
**Verify connection** to confirm the REST APIs respond.

> The Verify button tests the REST APIs server-side (Places / Geocoding / Weather). It does **not**
> exercise the in-browser Maps JavaScript API, so a green check does not by itself prove address
> autocomplete works. If the dropdown does not appear, see [Troubleshooting](#troubleshooting).

### Tighter (two-key) setup

For the strictest restriction, use two keys:

- **Browser key** - restricted to HTTP referrers (your domain + localhost), APIs limited to Maps
  JavaScript API + Places API. Provide it at **build time** as `NEXT_PUBLIC_GOOGLE_PLACES_API_KEY`
  (it is inlined into the page, so it needs a rebuild to change).
- **Server key** - restricted by IP (or unrestricted), APIs limited to Geocoding + Weather. Provide
  it as the `GOOGLE_API_KEY` env var (or `GOOGLE_PLACES_API_KEY` / `GOOGLE_WEATHER_API_KEY`).

## Flight lookup (AeroDataBox)

Powers the **Look up** button in an event's Team & Travel editor (flight number to carrier + times).

1. Create a RapidAPI account at <https://rapidapi.com/>.
2. Subscribe to **AeroDataBox** (it has a free tier).
3. Copy your RapidAPI key (the `X-RapidAPI-Key` value).
4. Paste it: **Config -> Databases & API -> Flight lookup key -> Save** (or set `AERODATABOX_API_KEY`).

This key is used server-side only and is never sent to the browser. Without it, the Look-up button is
inert and travel is entered manually.

## Shipment tracking

Powers tracking of shipped road-case freight. Set whichever provider you use:

| Provider | Where to get a key | Env var |
| --- | --- | --- |
| EasyPost (parcel + LTL) | <https://www.easypost.com/> account -> API keys | `EASYPOST_API_KEY` |
| AfterShip (UniShippers / LTL) | <https://www.aftership.com/> account -> API keys | `AFTERSHIP_API_KEY` |
| 17TRACK (free-tier fallback) | <https://www.17track.net/> API account | `SEVENTEENTRACK_API_KEY` |

Or paste any of them under **Config -> Databases & API**. All are server-side only.

## Troubleshooting

**Address autocomplete shows no dropdown.** The Maps SDK loads in the browser, so check the browser
console on an address field (F12 -> Console):

| Symptom | Cause | Fix |
| --- | --- | --- |
| `ApiNotActivatedMapError` | Maps JavaScript API not enabled | enable it (step 3) |
| `RefererNotAllowedMapError` | your domain is not in the key's referrer allowlist | add `https://your-domain.example/*` |
| `ApiTargetBlockedMapError` | the key's API restriction blocks Maps JS | add Maps JavaScript API to the key |
| `net::ERR_BLOCKED_BY_CLIENT` on a `maps.googleapis.com` request | an ad blocker / privacy extension | allowlist `maps.googleapis.com` (or the site) |
| dropdown works in a clean browser but not yours | a stale cached service worker | hard-reload; the app ships a self-cleaning `/sw.js` that fixes this on the next visit |

**Weather not showing.** Make sure the Weather API is enabled and the key is not HTTP-referrer
restricted (server calls have no referrer). Re-run Verify connection.

**Verify connection fails for one API.** That API is not enabled on the key, or the key's API
restriction excludes it. Enable / allow it in Google Cloud, then re-verify.

## Security notes

- In-app keys are encrypted at rest with a key derived from `ET_SESSION_SECRET`. If you rotate that
  secret, stored keys become unreadable and must be re-entered.
- The Google key used for autocomplete is handed to signed-in browsers (Maps browser keys are meant
  to be public). Limit it with API restrictions + quotas, and prefer the two-key setup if you want a
  referrer-locked browser key.
- Never commit real keys. Env keys belong in your container env or a gitignored `.env.local`, never in
  `.env.example`.
