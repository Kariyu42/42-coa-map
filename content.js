/**
 * Content script — injected on 42 intra cluster map pages.
 *
 * 1. Read campus ID from #cluster-map[data-campus-id]
 * 2. Fetch active locations (host → login) + coalition data via background worker
 * 3. Watch for SVGs injected into .map-container divs
 * 4. For each occupied seat, directly style its stroke/fill with the coalition color
 */

const CLUSTER_MAP_EL = document.getElementById('cluster-map');
const CAMPUS_ID = CLUSTER_MAP_EL?.dataset.campusId;

// host  → { login, coalition: { name, color, image_url } | null }
const hostData   = new Map();
// login → coalition  (used by the link-based fallback)
const loginCoalition = new Map();

const BADGE_ATTR = 'data-coa-applied';

// ── Messaging ─────────────────────────────────────────────────────────────────

function sendMsg(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

// ── Load data ─────────────────────────────────────────────────────────────────

async function loadData() {
  if (!CAMPUS_ID) {
    console.warn('[42 CoaMap] No campus ID found on #cluster-map');
    return;
  }

  let locRes;
  try {
    locRes = await sendMsg({ type: 'GET_ACTIVE_LOCATIONS', campusId: CAMPUS_ID });
  } catch (e) {
    console.warn('[42 CoaMap] Background unreachable:', e.message);
    return;
  }

  if (!locRes?.ok) {
    console.warn('[42 CoaMap] Location error:', locRes?.error);
    return;
  }

  const locations = locRes.data; // [{ host, login }]
  if (!locations.length) return;

  const logins = [...new Set(locations.map((l) => l.login))];
  const coaRes = await sendMsg({ type: 'GET_COALITIONS', logins });
  if (!coaRes?.ok) return;

  const coalitions = coaRes.data; // { login: coalition | null }

  for (const { host, login } of locations) {
    const coalition = coalitions[login] ?? null;
    hostData.set(host, { login, coalition });
    loginCoalition.set(login, coalition);
  }

  document.querySelectorAll('.map-container').forEach(applyToContainer);
}

// ── Style a seat element ──────────────────────────────────────────────────────

function hexToRgb(hex) {
  const h = hex.replace(/^#/, '');
  if (h.length !== 6) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function styleSeat(seatEl, coalition) {
  if (seatEl.hasAttribute(BADGE_ATTR)) return;
  seatEl.setAttribute(BADGE_ATTR, '1');

  if (!coalition?.color) return;

  const bg = seatEl.querySelector('rect, polygon, path') || seatEl;

  bg.style.stroke      = coalition.color;
  bg.style.strokeWidth = '3';

  const rgb = hexToRgb(coalition.color);
  if (rgb) bg.style.fill = `rgba(${rgb.r},${rgb.g},${rgb.b},0.35)`;

  let title = seatEl.querySelector('title');
  if (!title) {
    title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    seatEl.prepend(title);
  }
  title.textContent = coalition.name;
}

// ── Apply to a single .map-container ─────────────────────────────────────────

function applyToContainer(container) {
  const svg = container.querySelector('svg');
  if (!svg) return;

  // Strategy 1: SVG element id == API host (e.g. "e1r1s1")
  for (const [host, { coalition }] of hostData) {
    const seat = svg.getElementById(host);
    if (seat) styleSeat(seat, coalition);
  }

  // Strategy 2: intra JS adds <a href=".../users/LOGIN"> to occupied seats
  svg.querySelectorAll(`a[href*="/users/"]:not([${BADGE_ATTR}])`).forEach((a) => {
    const match = a.getAttribute('href')?.match(/\/users\/([^/?#]+)/);
    if (!match) return;
    const login = match[1];
    const coalition = loginCoalition.get(login) ?? null;
    styleSeat(a, coalition);
  });
}

// ── Observe DOM changes ───────────────────────────────────────────────────────

let pending = false;

function scheduleApply() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    document.querySelectorAll('.map-container').forEach(applyToContainer);
  });
}

new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (
        node.tagName === 'svg' ||
        node.tagName === 'SVG' ||
        node.querySelector?.('svg') ||
        node.querySelector?.(`a[href*="/users/"]`)
      ) {
        scheduleApply();
        return;
      }
    }
  }
}).observe(document.body, { childList: true, subtree: true });

// Re-apply when a Bootstrap tab becomes active
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-toggle="tab"]')) {
    setTimeout(scheduleApply, 400);
  }
});

loadData();
