/**
 * Service worker for 42 Coalition Map extension.
 * Handles OAuth2 token management and API requests with caching.
 */

const API_BASE = 'https://api.intra.42.fr';
const TOKEN_KEY = 'oauth_token';
const COALITION_CACHE_KEY = 'coalition_cache';
const LOCATION_CACHE_KEY  = 'location_cache';
const PROFILE_CACHE_KEY   = 'profile_cache';
const COALITION_TTL_MS = 30 * 60 * 1000; //  30 min — coalitions rarely change
const LOCATION_TTL_MS  =  5 * 60 * 1000; //   5 min — locations change often
const PROFILE_TTL_MS   = 30 * 60 * 1000; //  30 min — profiles rarely change
const LB_TTL_MS        = 10 * 60 * 1000; //  10 min — leaderboard

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

// ── User profiles ─────────────────────────────────────────────────────────────

async function getUserProfile(login) {
  const cache = (await readCache(PROFILE_CACHE_KEY)) || {};
  if (cache[login]) return cache[login];

  const user = await apiFetch(`/users/${login}`);
  const cursus42 = user.cursus_users?.find((cu) => cu.cursus_id === 21)
    || user.cursus_users?.find((cu) => !/(piscine)/i.test(cu.cursus?.name || ''))
    || user.cursus_users?.[0];

  const profile = {
    login: user.login,
    displayname: user.displayname,
    avatar: user.image?.versions?.small || user.image?.link || null,
    level: cursus42?.level ?? null,
    grade: cursus42?.grade ?? null,
  };

  cache[login] = profile;
  await writeCache(PROFILE_CACHE_KEY, cache, PROFILE_TTL_MS);
  return profile;
}

// ── Project leaderboard ───────────────────────────────────────────────────────

async function getProjectLeaderboard(projectSlug, campusId) {
  const cacheKey = `lb_${projectSlug}_${campusId}`;
  const cached = await readCache(cacheKey);
  if (cached) return cached;

  // Resolve slug → project ID
  const projects = await apiFetch('/projects', { 'filter[slug]': projectSlug, 'page[size]': 1 });
  if (!projects.length) throw new Error(`Project not found: ${projectSlug}`);
  const projectId = projects[0].id;

  const raw = await apiFetch('/projects_users', {
    'filter[project_id]': projectId,
    'filter[campus_id]': campusId,
    'filter[status]': 'finished',
    'sort': '-final_mark',
    'page[size]': 20,
  });

  const leaderboard = raw
    .filter((pu) => pu.final_mark !== null)
    .map((pu) => ({
      login: pu.user?.login,
      displayname: pu.user?.displayname,
      avatar: pu.user?.image?.versions?.small || pu.user?.image?.link || null,
      finalMark: pu.final_mark,
      validated: pu['validated?'],
    }));

  await writeCache(cacheKey, leaderboard, LB_TTL_MS);
  return leaderboard;
}

// ── Auto-setup: create/find OAuth app on the user's 42 profile ───────────────

/**
 * Parse all <input> and <textarea> fields from raw HTML.
 * Returns a list of { name, value, type } objects (preserves duplicates for
 * array-style fields like scopes[]).
 */
function parseFormFields(html) {
  const fields = [];

  // <input> tags
  const inputRe = /<input\b[^>]*>/gi;
  let m;
  while ((m = inputRe.exec(html)) !== null) {
    const tag = m[0];
    const nameM  = tag.match(/name="([^"]+)"/);
    if (!nameM) continue;
    const name  = nameM[1];
    const value = (tag.match(/value="([^"]*)"/) || [])[1] ?? '';
    const type  = ((tag.match(/type="([^"]+)"/) || [])[1] || 'text').toLowerCase();
    if (type === 'submit') continue;
    if (type === 'checkbox' && !tag.includes('checked')) continue;
    fields.push({ name, value: value || (type === 'checkbox' ? '1' : '') });
  }

  // <textarea> tags
  const taRe = /<textarea[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/gi;
  while ((m = taRe.exec(html)) !== null) {
    fields.push({ name: m[1], value: m[2].trim() });
  }

  // <select> tags — pick the selected <option> or first option with a non-empty value
  const selRe = /<select[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/gi;
  while ((m = selRe.exec(html)) !== null) {
    const selName = m[1];
    const selBody = m[2];
    // Collect all options: { value, text }
    const opts = [...selBody.matchAll(/<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi)]
      .map((om) => ({ value: om[1], text: om[2].replace(/<[^>]*>/g, '').trim(), selected: om[0].includes('selected') }));
    const selected = opts.find((o) => o.selected && o.value);
    const firstNonEmpty = opts.find((o) => o.value);
    const pick = selected || firstNonEmpty;
    if (pick) fields.push({ name: selName, value: pick.value, options: opts });
  }

  return fields;
}

async function autoSetupCredentials() {
  const BASE = 'https://profile.intra.42.fr';

  // 1 ── Fetch the applications list page ─────────────────────────────────────
  const listRes = await fetch(`${BASE}/oauth/applications`, {
    credentials: 'include',
    redirect: 'follow',
  });
  if (!listRes.ok) throw new Error('Could not reach 42 intra. Are you logged in?');
  const listHtml = await listRes.text();

  if (listHtml.includes('sign_in') && !listHtml.includes('/oauth/applications/')) {
    throw new Error('You are not logged in to 42 intra. Please log in first.');
  }

  // 2 ── Check for an existing "42 CoaMap" app ────────────────────────────────
  const existingMatch = listHtml.match(
    /href="(\/oauth\/applications\/\d+)"[\s\S]{0,500}?42\s*CoaMap/i
  ) || listHtml.match(
    /42\s*CoaMap[\s\S]{0,500}?href="(\/oauth\/applications\/\d+)"/i
  );

  let detailHtml;

  if (existingMatch) {
    const appPath = existingMatch[1];
    let detailRes = await fetch(`${BASE}${appPath}`, { credentials: 'include' });

    // The server may require updating the app (description / application_type now mandatory).
    // If the detail page contains validation warnings or redirects to edit, update it.
    let detailText = detailRes.ok ? await detailRes.text() : '';
    const needsUpdate = !detailRes.ok
      || /please update your application/i.test(detailText)
      || /description.*required|application.type.*required/i.test(detailText);

    if (needsUpdate) {
      // Fetch the edit form
      const editRes = await fetch(`${BASE}${appPath}/edit`, { credentials: 'include' });
      if (editRes.ok) {
        const editHtml = await editRes.text();
        const editFields = parseFormFields(editHtml);

        // Find application_type select value
        const editTypeField = editFields.find((f) => f.name.includes('[application_type]') || f.name.includes('[type]'));
        let editTypeValue = '';
        if (editTypeField?.options) {
          const ct = editTypeField.options.find((o) => /campus.?tool/i.test(o.text));
          const valid = editTypeField.options.filter((o) => o.value);
          editTypeValue = ct?.value || valid[valid.length - 1]?.value || '';
        }

        const editBody = new URLSearchParams();
        for (const { name, value } of editFields) {
          if (name.includes('[description]') && !value) {
            editBody.append(name, 'Coalition color overlay for the 42 cluster map');
          } else if (name.includes('[application_type]') || name.includes('[type]')) {
            editBody.append(name, editTypeValue || value);
          } else {
            editBody.append(name, value);
          }
        }

        // Rails uses PATCH via _method hidden field (already in editFields),
        // but the form action targets the app path
        const editAction = editHtml.match(/<form[^>]+action="([^"]+)"/i)?.[1] || appPath;
        const updateRes = await fetch(`${BASE}${editAction}`, {
          method: 'POST',
          credentials: 'include',
          redirect: 'follow',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: editBody.toString(),
        });
        if (updateRes.ok) {
          detailText = await updateRes.text();
        }
      }

      // Re-fetch the detail page after update
      if (!detailText || /please update/i.test(detailText)) {
        detailRes = await fetch(`${BASE}${appPath}`, { credentials: 'include' });
        if (!detailRes.ok) throw new Error('Failed to load app details after update');
        detailText = await detailRes.text();
      }
    }

    detailHtml = detailText;
  } else {
    // 3 ── Fetch the "new app" form to get exact field names ──────────────────
    const formRes = await fetch(`${BASE}/oauth/applications/new`, {
      credentials: 'include',
    });
    if (!formRes.ok) throw new Error('Failed to load the app creation form');
    const formHtml = await formRes.text();

    // Parse every form field so we send exactly what the server expects
    const fields = parseFormFields(formHtml);

    // Find the application_type select field and pick "Campus Tool" by its actual option value
    const appTypeField = fields.find((f) => f.name.includes('[application_type]') || f.name.includes('[type]'));
    let appTypeValue = '';
    if (appTypeField?.options) {
      // Try to match "Campus Tool" by option text, fall back to last non-empty option
      const campusTool = appTypeField.options.find((o) => /campus.?tool/i.test(o.text));
      const anyValid = appTypeField.options.filter((o) => o.value);
      appTypeValue = campusTool?.value || anyValid[anyValid.length - 1]?.value || '';
    }

    // Build the POST body — start with all hidden/default fields from the form
    const body = new URLSearchParams();
    for (const { name, value } of fields) {
      // Fill in our values for the known fields, keep everything else as-is
      if (name.includes('[name]')) {
        body.append(name, '42 CoaMap');
      } else if (name.includes('[description]')) {
        body.append(name, 'Coalition color overlay for the 42 cluster map');
      } else if (name.includes('[redirect_uri]')) {
        body.append(name, 'https://localhost/oauth/callback');
      } else if (name.includes('[scopes]')) {
        body.append(name, 'public');
      } else if (name.includes('[confidential]')) {
        body.append(name, value || '1');
      } else if (name.includes('[application_type]') || name.includes('[type]')) {
        body.append(name, appTypeValue || value);
      } else {
        body.append(name, value);
      }
    }

    // Ensure description and application_type are present even if the form
    // didn't have them as pre-existing fields (they may be required)
    const prefix = fields.find((f) => f.name.includes('[name]'))?.name.replace('[name]', '') || 'doorkeeper_application';
    if (!fields.some((f) => f.name.includes('[description]'))) {
      body.append(`${prefix}[description]`, 'Coalition color overlay for the 42 cluster map');
    }
    if (!fields.some((f) => f.name.includes('[application_type]') || f.name.includes('[type]'))) {
      body.append(`${prefix}[application_type]`, appTypeValue || 'campus_tool');
    }

    // If the form didn't include a scopes field (it may be a checkbox not
    // checked by default), inject one so the app gets at least "public" scope
    if (!fields.some((f) => f.name.includes('[scopes]'))) {
      // Guess the prefix from any existing field
      const prefix = fields.find((f) => f.name.includes('[name]'))?.name.replace('[name]', '') || 'doorkeeper_application';
      body.append(`${prefix}[scopes]`, 'public');
    }

    // Determine the form action URL
    const actionMatch = formHtml.match(/<form[^>]+action="([^"]+)"/i);
    const action = actionMatch ? actionMatch[1] : '/oauth/applications';

    // 4 ── Submit the form ────────────────────────────────────────────────────
    const createRes = await fetch(`${BASE}${action}`, {
      method: 'POST',
      credentials: 'include',
      redirect: 'follow',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!createRes.ok) throw new Error(`App creation failed (HTTP ${createRes.status})`);
    detailHtml = await createRes.text();
  }

  // 5 ── Extract UID + Secret from the detail page ────────────────────────────
  //
  // Strip <head>, <script>, <style> so we don't match asset-fingerprint hashes.
  const bodyHtml = detailHtml
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<link[^>]*>/gi, '');

  let clientId, clientSecret;

  // Strategy 1: data-clipboard-text attributes (common copy-to-clipboard UI)
  const clipMatches = [...bodyHtml.matchAll(/data-clipboard-text="([^"]{40,})"/g)].map((m) => m[1]);
  if (clipMatches.length >= 2) {
    clientId = clipMatches[0];
    clientSecret = clipMatches[1];
  }

  // Strategy 2: labeled extraction — "UID" / "Secret" near a long credential string
  // Credential format: could be 64-char hex, or prefixed (u-xxx-<hex>, s-xxx-<hex>)
  if (!clientId || !clientSecret) {
    const credRe = /([a-f0-9]{64}|[us]-[a-z0-9]+-[a-f0-9]{50,})/i;
    const uidMatch = bodyHtml.match(new RegExp('(?:uid|application.?id)[\\s\\S]{0,300}?' + credRe.source, 'i'));
    const secretMatch = bodyHtml.match(new RegExp('(?:secret)[\\s\\S]{0,300}?' + credRe.source, 'i'));
    if (uidMatch && secretMatch) {
      clientId = uidMatch[1];
      clientSecret = secretMatch[1];
    }
  }

  // Strategy 3: credentials inside <code>, <pre>, <samp>, or <td> elements
  if (!clientId || !clientSecret) {
    const tagMatches = [...bodyHtml.matchAll(/<(?:code|pre|samp|td)[^>]*>\s*([a-f0-9-]{40,})\s*<\//gi)]
      .map((m) => m[1])
      .filter((v) => v.length >= 40);
    const unique = [...new Set(tagMatches)];
    if (unique.length >= 2) {
      clientId = unique[0];
      clientSecret = unique[1];
    }
  }

  // Strategy 4: first two unique 64-char hex strings in body content only
  if (!clientId || !clientSecret) {
    const hexes = [...new Set((bodyHtml.match(/(?<![a-f0-9])[a-f0-9]{64}(?![a-f0-9])/g) || []))];
    if (hexes.length >= 2) {
      clientId = hexes[0];
      clientSecret = hexes[1];
    }
  }

  if (!clientId || !clientSecret) {
    throw new Error('Could not extract credentials from the app page. Please use manual setup.');
  }

  // 6 ── Persist ──────────────────────────────────────────────────────────────
  await new Promise((r) =>
    chrome.storage.local.set({ client_id: clientId, client_secret: clientSecret, oauth_token: null }, r)
  );

  return { clientId: clientId.slice(0, 8) + '…' };
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

  if (msg.type === 'AUTO_SETUP') {
    autoSetupCredentials()
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

  if (msg.type === 'GET_USER_PROFILE') {
    getUserProfile(msg.login)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'GET_PROJECT_LEADERBOARD') {
    getProjectLeaderboard(msg.projectSlug, msg.campusId)
      .then((data) => sendResponse({ ok: true, data }))
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
