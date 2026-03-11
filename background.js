/**
 * Service worker for 42 Coalition Map extension.
 * Handles OAuth2 token management and API requests with caching.
 */

const API_BASE = 'https://api.intra.42.fr';
const TOKEN_KEY = 'oauth_token';
const COALITION_CACHE_KEY = 'coalition_cache';
const LOCATION_CACHE_KEY  = 'location_cache';
const COALITION_TTL_MS = 30 * 60 * 1000; //  30 min — coalitions rarely change
const LOCATION_TTL_MS  =  5 * 60 * 1000; //   5 min — locations change often

// ── Rate limiter ──────────────────────────────────────────────────────────────
// The 42 API allows 2 req/s. We stay safe at 1 req/550ms.

const REQUEST_INTERVAL_MS = 550;
let lastRequestAt = 0;

async function rateLimit() {
  const now = Date.now();
  const wait = REQUEST_INTERVAL_MS - (now - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

// ── Token management ──────────────────────────────────────────────────────────

async function getCredentials() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['client_id', 'client_secret'], resolve);
  });
}

async function fetchNewToken(clientId, clientSecret) {
  const res = await fetch(`${API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`Token fetch failed: ${res.status}`);
  const data = await res.json();
  const token = {
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000 - 60_000,
  };
  await chrome.storage.local.set({ [TOKEN_KEY]: token });
  return token.access_token;
}

async function getAccessToken() {
  const { oauth_token } = await new Promise((resolve) =>
    chrome.storage.local.get(TOKEN_KEY, resolve)
  );
  if (oauth_token && Date.now() < oauth_token.expires_at) {
    return oauth_token.access_token;
  }
  const { client_id, client_secret } = await getCredentials();
  if (!client_id || !client_secret) throw new Error('No credentials configured');
  return fetchNewToken(client_id, client_secret);
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiFetch(path, params = {}, retries = 2) {
  await rateLimit();
  const token = await getAccessToken();
  const url = new URL(`${API_BASE}/v2${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 429 && retries > 0) {
    await new Promise((r) => setTimeout(r, 2000));
    return apiFetch(path, params, retries - 1);
  }

  if (!res.ok) throw new Error(`API error ${res.status}: ${path}`);
  return res.json();
}

async function fetchAllPages(path, params = {}) {
  let page = 1;
  const results = [];
  while (true) {
    const data = await apiFetch(path, { ...params, 'page[size]': 100, 'page[number]': page });
    if (!Array.isArray(data) || data.length === 0) break;
    results.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return results;
}

// ── Generic cache helpers ─────────────────────────────────────────────────────

async function readCache(key) {
  const stored = await new Promise((resolve) => chrome.storage.local.get(key, resolve));
  const entry = stored[key];
  if (!entry || Date.now() > entry.expires_at) return null;
  return entry.data;
}

async function writeCache(key, data, ttlMs) {
  await chrome.storage.local.set({ [key]: { data, expires_at: Date.now() + ttlMs } });
}

// ── Locations ─────────────────────────────────────────────────────────────────

async function getActiveLocations(campusId) {
  const cacheKey = `${LOCATION_CACHE_KEY}_${campusId}`;
  const cached = await readCache(cacheKey);
  if (cached) return cached;

  const raw = await fetchAllPages(`/campus/${campusId}/locations`, {
    'filter[active]': 'true',
  });

  const locations = raw
    .map((loc) => ({ login: loc.user?.login, host: loc.host }))
    .filter((l) => l.login);

  await writeCache(cacheKey, locations, LOCATION_TTL_MS);
  return locations;
}

// ── Coalitions ────────────────────────────────────────────────────────────────

async function getBestCoalition(userId) {
  // Try coalitions_users — may include nested coalition + bloc.cursus_id
  try {
    const cuList = await apiFetch(`/users/${userId}/coalitions_users`);
    const withData = cuList.filter((cu) => cu.coalition?.color);
    if (withData.length > 0) {
      const MAIN_CURSUS_ID = 21;
      const best =
        withData.find((cu) => cu.bloc?.cursus_id === MAIN_CURSUS_ID) || withData[0];
      const c = best.coalition;
      return { name: c.name, color: c.color, image_url: c.image_url, slug: c.slug };
    }
  } catch { /* fall through */ }

  // Fallback: /coalitions — prefer non-piscine entry
  const coalitions = await apiFetch(`/users/${userId}/coalitions`);
  if (!coalitions.length) return null;
  const main = coalitions.find((c) => !/(piscine)/i.test(`${c.name} ${c.slug}`));
  const c = main || coalitions[0];
  return { name: c.name, color: c.color, image_url: c.image_url, slug: c.slug };
}

async function getCoalitionsForLogins(logins) {
  if (!logins.length) return {};

  const cache = (await readCache(COALITION_CACHE_KEY)) || {};
  const missing = logins.filter((l) => !(l in cache));

  if (missing.length > 0) {
    for (let i = 0; i < missing.length; i += 100) {
      const chunk = missing.slice(i, i + 100);
      try {
        const users = await apiFetch('/users', {
          'filter[login]': chunk.join(','),
          'page[size]': 100,
        });

        // Sequential to respect rate limit
        for (const user of users) {
          try {
            cache[user.login] = await getBestCoalition(user.id);
          } catch {
            cache[user.login] = null;
          }
        }
      } catch (err) {
        console.error('[42 CoaMap] Error fetching users chunk:', err);
      }
    }

    await writeCache(COALITION_CACHE_KEY, cache, COALITION_TTL_MS);
  }

  const result = {};
  for (const login of logins) result[login] = cache[login] ?? null;
  return result;
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_COALITIONS') {
    getCoalitionsForLogins(msg.logins)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'GET_ACTIVE_LOCATIONS') {
    getActiveLocations(msg.campusId)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'TEST_CREDENTIALS') {
    getAccessToken()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'CLEAR_CACHE') {
    chrome.storage.local.remove(
      [COALITION_CACHE_KEY, `${LOCATION_CACHE_KEY}_${msg.campusId || ''}`],
      () => sendResponse({ ok: true })
    );
    return true;
  }
});
