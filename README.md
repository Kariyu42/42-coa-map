# 42 Coalition Map

A Chrome extension that overlays coalition colors on the [42 intra](https://meta.intra.42.fr/clusters) cluster map, so you can instantly see which coalition each logged-in student belongs to.

![Extension preview](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)
![License](https://img.shields.io/badge/License-Apache_2.0-blue)

## Features

- Colored border + tinted background on each occupied seat, matching the student's coalition color
- Prefers the **42cursus** coalition over C Piscine for students enrolled in the main curriculum
- Coalition data cached for **30 minutes** — locations cached for **5 minutes**
- Rate-limited API calls (≤ 2 req/s) with automatic retry on `429 Too Many Requests`
- Works across all clusters and tabs on the cluster map page

## Installation

> The extension is not published on the Chrome Web Store — load it manually.

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the repository folder

## Setup

You need a personal 42 API application to authenticate:

1. Go to [profile.intra.42.fr/oauth/applications](https://profile.intra.42.fr/oauth/applications)
2. Click **New application**
   - Name: anything (e.g. `Coalition Map`)
   - Redirect URI: `http://localhost` (required by the form, not actually used)
   - Scopes: leave as `public`
3. Copy your **Client UID** and **Client Secret**
4. Click the extension icon in Chrome → **↗ Open in tab** (so the popup doesn't close while you paste)
5. Paste both values and click **Save & Test**

A green confirmation message means you're ready. Navigate to [meta.intra.42.fr/clusters](https://meta.intra.42.fr/clusters) and coalition colors will appear on the map.

## How it works

```
Cluster page loads
       │
       ▼
content.js reads campus ID from #cluster-map[data-campus-id]
       │
       ▼
background.js fetches active locations → GET /v2/campus/:id/locations
       │
       ▼
background.js fetches coalitions for each user → GET /v2/users/:id/coalitions
  (prefers 42cursus over C Piscine, cached 30 min)
       │
       ▼
content.js finds each seat in the SVG by host ID (e.g. e1r1s1)
and applies a colored stroke + fill tint directly on the SVG element
```

OAuth2 uses the **Client Credentials** flow — your secret is stored locally in `chrome.storage.local` and never leaves your browser.

## File structure

```
42-coa-map/
├── manifest.json       # Chrome MV3 manifest
├── background.js       # Service worker: auth, API calls, caching
├── content.js          # Injected on cluster pages: SVG overlay logic
├── content.css         # Minimal styles
├── popup/
│   ├── popup.html      # Settings UI
│   ├── popup.js
│   └── popup.css
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## Permissions

| Permission | Why |
|---|---|
| `storage` | Save API credentials and coalition cache locally |
| `tabs` | Open settings in a full tab |
| `https://*.intra.42.fr/*` | Run on cluster map pages |
| `https://api.intra.42.fr/*` | Call the 42 API |

## License

Apache 2.0 — see [LICENSE](LICENSE)
