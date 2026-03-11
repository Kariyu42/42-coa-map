/**
 * Content script — injected on 42 intra project pages.
 * Shows a leaderboard of top-scoring campus peers for the current project.
 *
 * Requires the user to have visited the cluster map at least once so that
 * the campus ID is stored in chrome.storage.local (done by content.js).
 */

// Extract project slug from URL
// e.g. https://projects.intra.42.fr/projects/42cursus-libft → "42cursus-libft"
const pathMatch = location.pathname.match(/\/projects\/([^/?#]+)/);
if (!pathMatch) {
  // Not a project detail page — nothing to do
  throw new Error('[42 CoaMap] leaderboard.js: not a project page');
}
const PROJECT_SLUG = pathMatch[1];

function sendMsg(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

// ── Panel UI ──────────────────────────────────────────────────────────────────

function buildPanel() {
  const panel = document.createElement('div');
  panel.id = 'coa-lb-panel';
  panel.innerHTML = `
    <div class="coa-lb-header">
      <span>Campus Leaderboard</span>
      <button class="coa-lb-refresh" title="Refresh">↻</button>
      <button class="coa-lb-collapse" title="Collapse">−</button>
    </div>
    <div class="coa-lb-body">
      <div class="coa-lb-status">Loading…</div>
    </div>
  `;

  panel.querySelector('.coa-lb-collapse').addEventListener('click', (e) => {
    const body = panel.querySelector('.coa-lb-body');
    const collapsed = body.style.display === 'none';
    body.style.display = collapsed ? '' : 'none';
    e.target.textContent = collapsed ? '−' : '+';
  });

  panel.querySelector('.coa-lb-refresh').addEventListener('click', () => {
    loadLeaderboard(panel);
  });

  document.body.appendChild(panel);
  return panel;
}

async function loadLeaderboard(panel) {
  const body = panel.querySelector('.coa-lb-body');
  body.innerHTML = '<div class="coa-lb-status">Loading…</div>';

  const { last_campus_id } = await new Promise((r) =>
    chrome.storage.local.get('last_campus_id', r)
  );

  if (!last_campus_id) {
    body.innerHTML = '<div class="coa-lb-status">Visit the cluster map first — campus ID needed.</div>';
    return;
  }

  try {
    const res = await sendMsg({
      type: 'GET_PROJECT_LEADERBOARD',
      projectSlug: PROJECT_SLUG,
      campusId: last_campus_id,
    });

    if (!res?.ok) throw new Error(res?.error || 'Unknown error');

    const entries = res.data;
    if (!entries.length) {
      body.innerHTML = '<div class="coa-lb-status">No finished submissions found.</div>';
      return;
    }

    body.innerHTML = '';
    entries.forEach((entry, i) => {
      const row = document.createElement('div');
      row.className = 'coa-lb-row';
      row.innerHTML = `
        <span class="coa-lb-rank">${i + 1}</span>
        ${entry.avatar
          ? `<img class="coa-lb-avatar" src="${entry.avatar}" alt="" />`
          : '<div class="coa-lb-avatar"></div>'}
        <span class="coa-lb-login">${entry.login || '?'}</span>
        <span class="coa-lb-mark ${entry.validated ? 'pass' : 'fail'}">${entry.finalMark}</span>
      `;
      body.appendChild(row);
    });
  } catch (err) {
    body.innerHTML = `<div class="coa-lb-status">Error: ${err.message}</div>`;
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

const panel = buildPanel();
loadLeaderboard(panel);