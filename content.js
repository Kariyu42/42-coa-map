/**
 * Content script — injected on 42 intra cluster map pages.
 *
 * 1. Read campus ID from #cluster-map[data-campus-id]
 * 2. Fetch active locations (host → login) + coalition data via background worker
 * 3. Watch for SVGs injected into .map-container divs
 * 4. For each occupied seat, directly style its stroke/fill with the coalition color
 * 5. Hover card: show user profile on seat hover (replaces intra's default tooltip)
 * 6. Filter panel: toggle coalition visibility
 */

const CLUSTER_MAP_EL = document.getElementById('cluster-map');
const CAMPUS_ID = CLUSTER_MAP_EL?.dataset.campusId;

// host  → { login, coalition: { name, color, image_url, slug } | null }
const hostData = new Map();
// login → coalition  (used by the link-based fallback)
const loginCoalition = new Map();

const BADGE_ATTR = 'data-coa-applied';
const SLUG_ATTR  = 'data-coa-slug';
const LOGIN_ATTR = 'data-coa-login';

// Hidden coalition slugs (filter panel state)
const hiddenSlugs = new Set();

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

  // Persist campus ID so the leaderboard script can use it on project pages
  chrome.storage.local.set({ last_campus_id: CAMPUS_ID });

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
  buildFilterPanel();
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

function styleSeat(seatEl, coalition, login) {
  if (seatEl.hasAttribute(BADGE_ATTR)) return;
  seatEl.setAttribute(BADGE_ATTR, '1');

  // Suppress intra's default Bootstrap tooltip on this seat
  seatEl.removeAttribute('title');
  seatEl.removeAttribute('data-original-title');
  seatEl.removeAttribute('data-toggle');

  if (coalition?.slug) seatEl.setAttribute(SLUG_ATTR, coalition.slug);
  if (login) seatEl.setAttribute(LOGIN_ATTR, login);

  if (!coalition?.color) {
    if (login) addHoverListeners(seatEl, login, null);
    return;
  }

  const bg = seatEl.querySelector('rect, polygon, path') || seatEl;
  bg.style.stroke      = coalition.color;
  bg.style.strokeWidth = '3';

  const rgb = hexToRgb(coalition.color);
  if (rgb) bg.style.fill = `rgba(${rgb.r},${rgb.g},${rgb.b},0.35)`;

  // Apply current filter state
  if (hiddenSlugs.has(coalition.slug)) seatEl.setAttribute('data-coa-hidden', '1');

  addHoverListeners(seatEl, login, coalition);
}

// ── Apply to a single .map-container ─────────────────────────────────────────

function applyToContainer(container) {
  const svg = container.querySelector('svg');
  if (!svg) return;

  // Strategy 1: SVG element id == API host (e.g. "e1r1s1")
  for (const [host, { login, coalition }] of hostData) {
    const seat = svg.getElementById(host);
    if (seat) styleSeat(seat, coalition, login);
  }

  // Strategy 2: intra JS adds <a href=".../users/LOGIN"> to occupied seats
  svg.querySelectorAll(`a[href*="/users/"]:not([${BADGE_ATTR}])`).forEach((a) => {
    const match = a.getAttribute('href')?.match(/\/users\/([^/?#]+)/);
    if (!match) return;
    const login = match[1];
    const coalition = loginCoalition.get(login) ?? null;
    styleSeat(a, coalition, login);
  });
}

// ── Hover card ────────────────────────────────────────────────────────────────

const card = document.createElement('div');
card.id = 'coa-card';
card.innerHTML = `
  <div class="coa-card-top">
    <img class="coa-card-avatar" src="" alt="" />
    <div class="coa-card-meta">
      <div class="coa-card-login"></div>
      <div class="coa-card-displayname"></div>
    </div>
    <div class="coa-card-badge"></div>
  </div>
  <div class="coa-card-level-row">
    <div class="coa-card-level-bar"><div class="coa-card-level-fill"></div></div>
    <span class="coa-card-level-text"></span>
  </div>
`;
document.body.appendChild(card);

let hoverTimer = null;
let activeLogin = null;

function showCard(seatEl, login, coalition) {
  activeLogin = login;
  card.dataset.state = 'loading';
  positionCard(seatEl);

  sendMsg({ type: 'GET_USER_PROFILE', login })
    .then((res) => {
      if (activeLogin !== login) return;
      if (!res?.ok) { hideCard(); return; }
      populateCard(res.data, coalition);
      card.dataset.state = 'visible';
    })
    .catch(hideCard);
}

function positionCard(seatEl) {
  const rect = seatEl.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top;
  card.style.left = `${cx}px`;
  card.style.top  = `${cy - 8}px`;
}

function populateCard(profile, coalition) {
  const avatarEl = card.querySelector('.coa-card-avatar');
  if (profile.avatar) {
    avatarEl.src = profile.avatar;
    avatarEl.style.display = '';
  } else {
    avatarEl.style.display = 'none';
  }

  card.querySelector('.coa-card-login').textContent = profile.login;
  card.querySelector('.coa-card-displayname').textContent = profile.displayname || '';

  const badge = card.querySelector('.coa-card-badge');
  if (coalition?.color) {
    badge.textContent = coalition.name;
    badge.style.background = coalition.color;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }

  const levelRow = card.querySelector('.coa-card-level-row');
  if (profile.level !== null) {
    const fraction = profile.level % 1;
    const fill = card.querySelector('.coa-card-level-fill');
    fill.style.width = `${fraction * 100}%`;
    fill.style.background = coalition?.color || '#6688cc';
    card.querySelector('.coa-card-level-text').textContent = `Level ${Math.floor(profile.level)}`;
    levelRow.style.display = '';
  } else {
    levelRow.style.display = 'none';
  }
}

function hideCard() {
  activeLogin = null;
  card.dataset.state = '';
}

function addHoverListeners(seatEl, login, coalition) {
  if (!login) return;

  // The intra uses <image data-tooltip-login="..." data-tooltip-url="..."> for avatars.
  // Find it inside the seat or its parent group.
  const group = seatEl.closest('g') || seatEl;
  const avatarImg = group.querySelector(`image[data-tooltip-login="${login}"]`)
                 || group.querySelector('image[data-tooltip-login]')
                 || group.querySelector('image');

  // Suppress intra's default tooltip on the avatar image
  if (avatarImg) {
    avatarImg.removeAttribute('data-tooltip-url');
    avatarImg.removeAttribute('data-tooltip-login');
    avatarImg.removeAttribute('title');
    avatarImg.removeAttribute('data-original-title');
    avatarImg.removeAttribute('data-toggle');
  }

  // Also suppress on the seat element itself
  seatEl.removeAttribute('title');
  seatEl.removeAttribute('data-original-title');
  seatEl.removeAttribute('data-toggle');

  // Attach hover to the avatar image (primary) and seat rect (fallback)
  const target = avatarImg || seatEl;
  target.addEventListener('mouseenter', () => {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => showCard(target, login, coalition), 250);
  });
  target.addEventListener('mouseleave', () => {
    clearTimeout(hoverTimer);
    hideCard();
  });
}

// ── Filter panel ──────────────────────────────────────────────────────────────

function buildFilterPanel() {
  if (document.getElementById('coa-filter')) return; // already built

  // Collect unique coalitions present on this cluster
  const seen = new Map();
  for (const coalition of loginCoalition.values()) {
    if (coalition?.slug && !seen.has(coalition.slug)) seen.set(coalition.slug, coalition);
  }
  if (!seen.size) return;

  const panel = document.createElement('div');
  panel.id = 'coa-filter';
  panel.innerHTML = `
    <div class="coa-filter-header">
      <span>Coalitions</span>
      <button class="coa-filter-collapse" title="Collapse">−</button>
    </div>
    <div class="coa-filter-body"></div>
  `;

  const body = panel.querySelector('.coa-filter-body');
  for (const [slug, coa] of seen) {
    const row = document.createElement('label');
    row.className = 'coa-filter-row';
    row.innerHTML = `
      <input type="checkbox" checked data-slug="${slug}" />
      <span class="coa-filter-dot" style="background:${coa.color}"></span>
      <span class="coa-filter-name">${coa.name}</span>
    `;
    row.querySelector('input').addEventListener('change', (e) => {
      toggleCoalition(slug, e.target.checked);
    });
    body.appendChild(row);
  }

  panel.querySelector('.coa-filter-collapse').addEventListener('click', (e) => {
    const collapsed = body.style.display === 'none';
    body.style.display = collapsed ? '' : 'none';
    e.target.textContent = collapsed ? '−' : '+';
  });

  document.body.appendChild(panel);
}

function toggleCoalition(slug, visible) {
  if (visible) {
    hiddenSlugs.delete(slug);
    document.querySelectorAll(`[${SLUG_ATTR}="${slug}"]`).forEach((el) =>
      el.removeAttribute('data-coa-hidden')
    );
  } else {
    hiddenSlugs.add(slug);
    document.querySelectorAll(`[${SLUG_ATTR}="${slug}"]`).forEach((el) =>
      el.setAttribute('data-coa-hidden', '1')
    );
  }
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