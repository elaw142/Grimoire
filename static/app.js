'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let schools   = (window.GRIMOIRE_DATA || []).map(s => Object.assign({}, s));
let deedLog   = (window.DEED_LOG || []).slice();
const XP_PER_LEVEL = window.XP_PER_LEVEL || 100;
const RANKS        = window.RANKS || [];

// Drawer
let activeSchoolId = null;
let pendingVerdict = null;
let deedLoading    = false;

// Menu
let menuOpen = false;
let menuTab  = 'chronicle';

// Augur tab state
let augurState = {
  recalLoading:   false,
  recalResult:    null,   // { schoolName, spells }
  discoverStage:  'input', // 'input' | 'loading' | 'preview'
  discoverPreview: null,  // { name, flavour, spells }
  discoverDesc:   '',
};

// Misc
let bannerTimer = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
function getSchool(id) { return schools.find(s => s.id === id); }

function getRank(level) {
  let rank = RANKS[0];
  for (const r of RANKS) { if (level >= r.min_level) rank = r; }
  return rank;
}

function getLevel(xp)      { return Math.floor(xp / XP_PER_LEVEL) + 1; }
function getXPInLevel(xp)  { return xp % XP_PER_LEVEL; }

async function apiFetch(url, body, method = 'POST') {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (method !== 'DELETE') opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  return resp.json();
}

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Card DOM updates ──────────────────────────────────────────────────────────
function updateCardDOM(school) {
  const card = document.getElementById(`card-${school.id}`);
  if (!card) return;
  const rank   = school.rank || getRank(school.level);
  const xpPct  = Math.min(100, (school.xp_in_level / XP_PER_LEVEL) * 100);

  card.querySelector('.rank-badge').textContent = rank.name;
  card.querySelector('.rank-badge').style.cssText =
    `color:${rank.color};border-color:${rank.color}90;background:${rank.color}18;` +
    (school.level >= 25 ? `box-shadow:0 0 8px ${rank.color}45;` : '');
  card.querySelector('.card-name').textContent = school.name;
  const lr = card.querySelector('.card-level-row');
  lr.children[0].textContent = `LV ${school.level}`;
  lr.children[1].textContent = `${school.xp_in_level}/100`;
  const fill = card.querySelector('.xp-bar-fill');
  fill.style.width      = `${xpPct}%`;
  fill.style.background = `linear-gradient(90deg,${school.color}70,${school.color})`;
  fill.style.boxShadow  = `0 0 5px ${school.color}50`;
}

function flashCard(schoolId) {
  const card = document.getElementById(`card-${schoolId}`);
  if (!card) return;
  const s = getSchool(schoolId);
  card.style.setProperty('--card-color', s ? s.color + '50' : '');
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 900);
}

function addSchoolCard(school) {
  const grid = document.getElementById('school-grid');
  if (!grid) return;
  const rank = school.rank || getRank(1);
  const card = document.createElement('div');
  card.className = 'stat-card';
  card.id = `card-${school.id}`;
  card.dataset.schoolId = school.id;
  card.setAttribute('onclick', `openDrawer(${school.id})`);
  card.innerHTML = `
    <div class="card-inner">
      <div class="rank-badge"
           style="color:${rank.color};border-color:${rank.color}90;background:${rank.color}18;">
        ${rank.name}
      </div>
      <div class="card-body">
        <div class="card-name">${escHtml(school.name)}</div>
        <div class="card-custom-tag">CUSTOM</div>
        <div class="card-level-row"><span>LV 1</span><span>0/100</span></div>
        <div class="xp-bar-bg">
          <div class="xp-bar-fill"
               style="width:0%;background:linear-gradient(90deg,${school.color}70,${school.color});box-shadow:0 0 5px ${school.color}50;">
          </div>
        </div>
      </div>
    </div>
    <div class="card-recal-spinner" id="recal-${school.id}" style="display:none;">
      <div class="ai-spinner"></div>
    </div>`;
  grid.appendChild(card);
}

// ── XP gain ───────────────────────────────────────────────────────────────────
function applyXPResult(result) {
  const school = getSchool(result.school_id);
  if (!school) return;
  school.total_xp   = result.new_xp;
  school.level      = result.level;
  school.xp_in_level = result.xp_in_level;
  school.rank       = result.rank;
  updateCardDOM(school);
  flashCard(school.id);
  showFloatingXP(result.xp_gained, school.color);
  updateHeaderStats();
  prependLogEntry(school, result);
  if (result.leveled_up) {
    showBanner(school, result.level, result.rank);
    triggerRecalibrate(school.id);
    refreshAITitle();
  }
}

function updateHeaderStats() {
  if (!schools.length) return;
  const avgLv = Math.round(schools.reduce((a, s) => a + s.level, 0) / schools.length);
  const rank  = getRank(avgLv);
  const rankEl = document.querySelector('.header-stats .header-stat:nth-child(1) .hstat-value');
  const lvEl   = document.querySelector('.header-stats .header-stat:nth-child(2) .hstat-value');
  if (rankEl) { rankEl.textContent = rank.name; rankEl.style.color = rank.color; rankEl.style.textShadow = `0 0 14px ${rank.color}70`; }
  if (lvEl)   lvEl.textContent = avgLv;
}

async function refreshAITitle() {
  const el = document.getElementById('header-ai-title');
  if (!el) return;
  const result = await apiFetch('/api/augur/title', {});
  if (result.title) el.textContent = result.title;
}

function prependLogEntry(school, result) {
  const entry = {
    deed_name:     result._deed_name || '',
    is_custom:     result._is_custom || false,
    augur_verdict: result._verdict   || '',
    school_name:   school.name,
    school_color:  school.color,
    xp:            result.xp_gained,
    cast_at:       new Date().toISOString(),
  };
  deedLog.unshift(entry);
  if (deedLog.length > 50) deedLog.pop();
  // Refresh chronicle if it's currently visible
  if (menuOpen && menuTab === 'chronicle') renderChronicle();
}

// ── Floating XP ───────────────────────────────────────────────────────────────
function showFloatingXP(xp, color) {
  const el = document.getElementById('floating-xp');
  if (!el) return;
  el.textContent = `+${xp} XP`;
  el.style.color = color;
  el.style.textShadow = `0 0 18px ${color}90`;
  el.className = 'floating-xp';
  void el.offsetWidth;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 1200);
}

// ── Level-up banner ───────────────────────────────────────────────────────────
function showBanner(school, level, rank) {
  const banner = document.getElementById('levelup-banner');
  if (!banner) return;
  document.getElementById('levelup-text').textContent = `${school.name} \u2014 Level ${level}`;
  document.getElementById('levelup-text').style.color = school.color;
  document.getElementById('levelup-sub').textContent  = `Rank ${rank.name} \u00b7 The Augur reforges your incantations`;
  banner.classList.remove('hidden');
  void banner.offsetWidth;
  if (bannerTimer) clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => banner.classList.add('hidden'), 3500);
}

// ── Spell drawer ──────────────────────────────────────────────────────────────
function openDrawer(schoolId) {
  activeSchoolId = schoolId;
  pendingVerdict = null;
  deedLoading    = false;
  renderDrawer();
  document.getElementById('drawer-overlay').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeDrawer() {
  document.getElementById('drawer-overlay').classList.add('hidden');
  document.body.style.overflow = '';
  activeSchoolId = null;
  pendingVerdict = null;
}

async function deleteSchool(schoolId) {
  const school = getSchool(schoolId);
  if (!school) return;
  if (!confirm(`Banish the school of ${school.name}? This cannot be undone.`)) return;
  const result = await apiFetch(`/api/school/${schoolId}`, {}, 'DELETE');
  if (result.error) { alert(result.error); return; }
  closeDrawer();
  schools = schools.filter(s => s.id !== schoolId);
  const card = document.getElementById(`card-${schoolId}`);
  if (card) card.remove();
  renderMenu();
}

function updateRecalBanish() {
  const sel = document.getElementById('recal-school-select');
  const btn = document.getElementById('recal-banish-btn');
  if (!sel || !btn) return;
  const school = getSchool(parseInt(sel.value));
  btn.style.display = (school && school.is_custom) ? '' : 'none';
}

async function banishSelectedSchool() {
  const sel = document.getElementById('recal-school-select');
  if (!sel) return;
  await deleteSchool(parseInt(sel.value));
}

function renderDrawer() {
  const school = getSchool(activeSchoolId);
  if (!school) return;
  const rank   = school.rank || getRank(school.level);
  const xpPct  = Math.min(100, (school.xp_in_level / XP_PER_LEVEL) * 100);

  let spellsHtml = '';
  for (const sp of (school.spells || [])) {
    const desc = sp.description ? `<span class="habit-desc">${escHtml(sp.description)}</span>` : '';
    spellsHtml += `
      <button class="habit-btn" onclick="castSpell(${sp.id},${school.id})" ${deedLoading ? 'disabled' : ''}>
        <span class="habit-name-wrap"><span class="habit-name">${escHtml(sp.name)}</span>${desc}</span>
        <span class="habit-xp" style="color:${school.color};">+${sp.xp} XP</span>
      </button>`;
  }

  let oracleSection = '';
  if (!pendingVerdict) {
    oracleSection = `
      <div class="oracle-section-label">OFFER A CUSTOM ACT TO THE AUGUR</div>
      <div class="oracle-row">
        <textarea class="oracle-input" id="deed-input" rows="2"
          placeholder="Describe your act\u2026 e.g. \u2018I ran 12km in the rain\u2019"
          ${deedLoading ? 'disabled' : ''}
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();submitDeed();}"></textarea>
        <button class="oracle-submit" onclick="submitDeed()" ${deedLoading ? 'disabled' : ''}>
          ${deedLoading ? '<div class="ai-spinner"></div>' : 'SUBMIT'}
        </button>
      </div>`;
  } else {
    const v = pendingVerdict;
    oracleSection = `
      <div class="oracle-verdict">
        <div class="verdict-deed">&ldquo;${escHtml(v.deed)}&rdquo;</div>
        <div class="verdict-text">${escHtml(v.verdict)}</div>
        ${!v.error ? `
        <div class="verdict-footer">
          <div class="verdict-xp" style="color:${school.color};text-shadow:0 0 12px ${school.color}60;">+${v.xp} XP</div>
          <div class="verdict-actions">
            <button class="consult-btn" onclick="retryDeed()">RETRY</button>
            <button class="oracle-submit" onclick="acceptVerdict()">ACCEPT</button>
          </div>
        </div>` : `<button class="consult-btn" onclick="retryDeed()">DISMISS</button>`}
      </div>`;
  }

  document.getElementById('drawer-content').innerHTML = `
    <div class="drawer-header">
      <div class="rank-badge"
           style="color:${rank.color};border-color:${rank.color}80;background:${rank.color}15;">
        ${rank.name}
      </div>
      <div class="drawer-title-wrap">
        <div class="drawer-title">${escHtml(school.name)}</div>
        <div class="drawer-subtitle">Level ${school.level} &middot; ${school.xp_in_level}/100 XP</div>
        ${school.flavour ? `<div class="drawer-flavour">${escHtml(school.flavour)}</div>` : ''}
      </div>
      <div class="drawer-header-actions">
        <button class="drawer-close" onclick="closeDrawer()" aria-label="Close">&times;</button>
      </div>
    </div>
    <div class="xp-bar-bg" style="margin-bottom:18px;">
      <div class="xp-bar-fill"
           style="width:${xpPct}%;background:linear-gradient(90deg,${school.color}70,${school.color});box-shadow:0 0 6px ${school.color}50;">
      </div>
    </div>
    <div class="oracle-section-label" style="margin-bottom:8px;">PERFORM AN INCANTATION</div>
    <div class="habit-list" id="habit-list">${spellsHtml}</div>
    <div class="divider" style="margin:0 0 14px;"></div>
    ${oracleSection}`;

  if (!pendingVerdict) {
    const inp = document.getElementById('deed-input');
    if (inp) inp.focus();
  }
}

// ── Cast preset spell ─────────────────────────────────────────────────────────
async function castSpell(spellId, schoolId) {
  if (deedLoading) return;
  deedLoading = true;
  const result = await apiFetch('/api/cast', { spell_id: spellId });
  deedLoading = false;
  if (result.error) { alert(result.error); return; }
  const school = getSchool(schoolId);
  const spell  = (school?.spells || []).find(sp => sp.id === spellId);
  result._deed_name = spell?.name || '';
  result._is_custom = false;
  result._verdict   = '';
  applyXPResult(result);
  closeDrawer();
}

// ── Custom deed (Augur evaluation) ────────────────────────────────────────────
async function submitDeed() {
  if (deedLoading) return;
  const inp  = document.getElementById('deed-input');
  const deed = inp ? inp.value.trim() : '';
  if (!deed) return;
  deedLoading = true;
  renderDrawer();
  const result = await apiFetch('/api/augur/deed', { school_id: activeSchoolId, deed });
  deedLoading = false;
  pendingVerdict = result.error
    ? { deed, xp: 0, verdict: result.error, error: true }
    : { deed, xp: result.xp, verdict: result.verdict, error: false };
  renderDrawer();
}

function retryDeed() { pendingVerdict = null; renderDrawer(); }

async function acceptVerdict() {
  if (!pendingVerdict || pendingVerdict.error) { retryDeed(); return; }
  const { deed, xp, verdict } = pendingVerdict;
  const result = await apiFetch('/api/augur/accept', { school_id: activeSchoolId, deed, xp, verdict });
  if (result.error) { alert(result.error); return; }
  result._deed_name = deed;
  result._is_custom = true;
  result._verdict   = verdict;
  applyXPResult(result);
  closeDrawer();
}

// ── Auto-recalibrate on level-up ──────────────────────────────────────────────
async function triggerRecalibrate(schoolId, context) {
  const spinnerEl = document.getElementById(`recal-${schoolId}`);
  if (spinnerEl) spinnerEl.style.display = '';
  const result = await apiFetch('/api/augur/recalibrate', { school_id: schoolId, context: context || '' });
  if (spinnerEl) spinnerEl.style.display = 'none';
  if (result.error || !result.spells) return result;
  const school = getSchool(schoolId);
  if (school) school.spells = result.spells;
  if (activeSchoolId === schoolId) renderDrawer();
  return result;
}

// ── Side menu ─────────────────────────────────────────────────────────────────
function openMenu() {
  menuOpen = true;
  const overlay = document.getElementById('menu-overlay');
  overlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  renderMenuContent();
}

function closeMenu() {
  menuOpen = false;
  document.getElementById('menu-overlay').classList.add('hidden');
  document.body.style.overflow = '';
}

function setMenuTab(tab) {
  menuTab = tab;
  document.querySelectorAll('.menu-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  renderMenuContent();
}

function renderMenuContent() {
  if (menuTab === 'chronicle') renderChronicle();
  else if (menuTab === 'orrery') renderOrrery();
  else if (menuTab === 'augur')  renderAugurTab();
}

// ── Chronicle ─────────────────────────────────────────────────────────────────
function renderChronicle() {
  const el = document.getElementById('menu-content');
  if (!el) return;

  let entriesHtml = '';
  for (const entry of deedLog.slice(0, 50)) {
    const date = (entry.cast_at || '').slice(0, 10);
    entriesHtml += `
      <div class="log-entry">
        <div class="log-school-dot"
             style="background:${entry.school_color};box-shadow:0 0 6px ${entry.school_color}60;"></div>
        <div class="log-body">
          <div class="log-deed">
            ${escHtml(entry.deed_name)}
            ${entry.is_custom ? '<span class="ai-tag">&#10022; AUGUR</span>' : ''}
          </div>
          ${entry.augur_verdict
            ? `<div class="log-verdict">&ldquo;${escHtml(entry.augur_verdict)}&rdquo;</div>`
            : ''}
          <div class="log-meta">${escHtml(entry.school_name)} &middot; ${date}</div>
        </div>
        <div class="log-xp" style="color:${entry.school_color};">+${entry.xp} XP</div>
      </div>`;
  }

  el.innerHTML = `
    <div class="chronicle-title">CHRONICLE OF INCANTATIONS</div>
    <div class="chronicle-sub">A record of your mortal striving.</div>
    ${entriesHtml || `
      <div class="chronicle-empty">
        The Chronicle is empty.<br>
        <span class="log-empty-sub">PERFORM YOUR FIRST INCANTATION TO BEGIN</span>
      </div>`}`;
}

// ── Orrery (radar chart) ──────────────────────────────────────────────────────
function renderOrrery() {
  const el = document.getElementById('menu-content');
  if (!el) return;

  const N   = schools.length;
  const CX  = 160, CY = 160, R = 105, R_LABEL = 136;
  const MAX_LV = 30;

  const angles = schools.map((_, i) => (i / N) * 2 * Math.PI - Math.PI / 2);

  // Nested polygon grid lines
  let grid = [0.25, 0.5, 0.75, 1.0].map(pct => {
    const pts = angles.map(a =>
      `${(CX + R * pct * Math.cos(a)).toFixed(1)},${(CY + R * pct * Math.sin(a)).toFixed(1)}`
    ).join(' ');
    return `<polygon points="${pts}" fill="none"
      stroke="rgba(201,162,39,${pct === 1 ? 0.18 : 0.07})" stroke-width="1"/>`;
  }).join('');

  // Spokes
  let spokes = schools.map((s, i) =>
    `<line x1="${CX}" y1="${CY}"
      x2="${(CX + R * Math.cos(angles[i])).toFixed(1)}"
      y2="${(CY + R * Math.sin(angles[i])).toFixed(1)}"
      stroke="${s.color}" stroke-opacity="0.22" stroke-width="1"/>`
  ).join('');

  // Data polygon
  const dataPts = schools.map((s, i) => {
    const pct = Math.min(s.level / MAX_LV, 1);
    return `${(CX + R * pct * Math.cos(angles[i])).toFixed(1)},${(CY + R * pct * Math.sin(angles[i])).toFixed(1)}`;
  }).join(' ');

  // Nodes
  let nodes = schools.map((s, i) => {
    const pct   = Math.min(s.level / MAX_LV, 1);
    const nx    = (CX + R * pct * Math.cos(angles[i])).toFixed(1);
    const ny    = (CY + R * pct * Math.sin(angles[i])).toFixed(1);
    const delay = (0.55 + i * 0.06).toFixed(2);
    return `<circle cx="${nx}" cy="${ny}" r="4.5" fill="${s.color}"
      class="orrery-dot" style="animation-delay:${delay}s;"/>`;
  }).join('');

  // Labels — placed outside the chart with dy offsets to avoid overlap
  let labels = schools.map((s, i) => {
    const a      = angles[i];
    const sinA   = Math.sin(a);
    const cosA   = Math.cos(a);
    const anchor = cosA > 0.3 ? 'start' : cosA < -0.3 ? 'end' : 'middle';
    const name   = s.name.length > 11 ? s.name.slice(0, 10) + '\u2026' : s.name;
    const rank   = s.rank || getRank(s.level);

    // Push labels further out; for top/bottom nodes shift horizontally a bit
    const lx = (CX + R_LABEL * cosA).toFixed(1);

    // Stack two text lines centred on the label point with a fixed 11px gap
    const gap    = 11;
    const nameY  = (CY + R_LABEL * sinA - gap * 0.5).toFixed(1);
    const rankY  = (parseFloat(nameY) + gap).toFixed(1);

    return `
      <text x="${lx}" y="${nameY}" text-anchor="${anchor}" dominant-baseline="auto"
        fill="${s.color}" font-family="Cinzel,serif" font-size="8.5" font-weight="600"
        letter-spacing="0.3">${name.toUpperCase()}</text>
      <text x="${lx}" y="${rankY}" text-anchor="${anchor}" dominant-baseline="auto"
        fill="${rank.color}" font-family="Cinzel,serif" font-size="7.5">
        LV${s.level} ${rank.name}</text>`;
  }).join('');

  const total  = schools.reduce((a, s) => a + (s.total_xp || 0), 0);
  const avgLv  = schools.length ? Math.round(schools.reduce((a, s) => a + s.level, 0) / schools.length) : 1;
  const orank  = getRank(avgLv);

  el.innerHTML = `
    <div class="orrery-title">THE ORRERY</div>
    <div class="orrery-sub">Constellation of your arcane schools.</div>
    <svg viewBox="0 0 320 320" xmlns="http://www.w3.org/2000/svg"
         style="width:100%;max-width:360px;display:block;margin:0 auto;overflow:visible;">
      ${grid}
      ${spokes}
      <polygon points="${dataPts}"
        fill="rgba(201,162,39,0.07)"
        stroke="rgba(201,162,39,0.55)"
        stroke-width="1.5"
        class="orrery-polygon"/>
      ${nodes}
      <circle cx="${CX}" cy="${CY}" r="3" fill="rgba(201,162,39,0.4)"/>
      ${labels}
    </svg>
    <div class="orrery-stats">
      <div class="orrery-stat">
        <div class="orrery-stat-label">RANK</div>
        <div class="orrery-stat-val" style="color:${orank.color};text-shadow:0 0 10px ${orank.color}70;">${orank.name}</div>
      </div>
      <div class="orrery-stat">
        <div class="orrery-stat-label">AVG LV</div>
        <div class="orrery-stat-val" style="color:#c9a227;">${avgLv}</div>
      </div>
      <div class="orrery-stat">
        <div class="orrery-stat-label">TOTAL XP</div>
        <div class="orrery-stat-val" style="color:#7a9a6a;">${total.toLocaleString()}</div>
      </div>
    </div>`;
}

// ── Augur tab ─────────────────────────────────────────────────────────────────
function renderAugurTab() {
  const el = document.getElementById('menu-content');
  if (!el) return;
  el.innerHTML = `
    <div class="augur-panel-title">THE AUGUR'S CHAMBER</div>
    <div class="augur-panel-sub">Seek counsel. Forge new paths.</div>
    ${renderRecalibrateSection()}
    ${renderDiscoverSection()}`;
  updateRecalBanish();
}

function renderRecalibrateSection() {
  const st = augurState;

  const schoolOptions = schools.map(s =>
    `<option value="${s.id}">${escHtml(s.name)} &mdash; LV${s.level}</option>`
  ).join('');

  if (st.recalLoading) {
    return `
      <div class="augur-section">
        <div class="augur-section-title">RECALIBRATE A SCHOOL</div>
        <div style="text-align:center;padding:24px 0;">
          <div class="ai-spinner" style="width:18px;height:18px;border-width:2px;margin:0 auto 12px;"></div>
          <div style="font-family:'Cinzel',serif;font-size:10px;letter-spacing:3px;color:#7a6a50;">
            THE AUGUR DELIBERATES&hellip;
          </div>
        </div>
      </div>`;
  }

  if (st.recalResult) {
    const spellRows = st.recalResult.spells.map(sp =>
      `<div class="augur-spell-row">
         <span class="augur-spell-name-wrap">
           <span>${escHtml(sp.name)}</span>
           ${sp.description ? `<span class="augur-spell-desc">${escHtml(sp.description)}</span>` : ''}
         </span>
         <span class="augur-spell-xp">+${sp.xp} XP</span>
       </div>`
    ).join('');
    return `
      <div class="augur-section">
        <div class="augur-section-title">RECALIBRATE A SCHOOL</div>
        <div class="augur-result">
          <div class="augur-result-label">REFORGED INCANTATIONS &mdash; ${escHtml(st.recalResult.schoolName)}</div>
          ${spellRows}
        </div>
        <div style="margin-top:12px;display:flex;justify-content:flex-end;">
          <button class="consult-btn" onclick="resetRecal()">RECALIBRATE ANOTHER</button>
        </div>
      </div>`;
  }

  return `
    <div class="augur-section">
      <div class="augur-section-title">RECALIBRATE A SCHOOL</div>
      <div class="augur-section-sub">
        The Augur will reforge a school's incantations based on your level, history, and any guidance you provide.
      </div>
      <select class="school-select" id="recal-school-select" onchange="updateRecalBanish()">${schoolOptions}</select>
      <textarea class="oracle-input" id="recal-context-input" rows="3"
        placeholder="Guidance for the Augur (optional) \u2014 e.g. \u2018I\u2019ve started training for a marathon\u2019"
        style="width:100%;margin-bottom:10px;"></textarea>
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <button class="banish-school-btn recal-banish-btn" id="recal-banish-btn" onclick="banishSelectedSchool()" style="display:none;">BANISH</button>
        <button class="oracle-submit" onclick="doAugurRecalibrate()">&#10022; CONSULT THE AUGUR</button>
      </div>
    </div>`;
}

function renderDiscoverSection() {
  const st = augurState;

  if (st.discoverStage === 'loading') {
    return `
      <div class="augur-section">
        <div class="augur-section-title">DISCOVER A NEW SCHOOL</div>
        <div style="text-align:center;padding:24px 0;">
          <div class="ai-spinner" style="width:18px;height:18px;border-width:2px;margin:0 auto 12px;"></div>
          <div style="font-family:'Cinzel',serif;font-size:10px;letter-spacing:3px;color:#7a6a50;">
            THE AUGUR DIVINES&hellip;
          </div>
        </div>
      </div>`;
  }

  if (st.discoverStage === 'preview' && st.discoverPreview) {
    const p = st.discoverPreview;
    const spellRows = p.spells.map(sp =>
      `<div class="augur-spell-row">
         <span class="augur-spell-name-wrap">
           <span>${escHtml(sp.name)}</span>
           ${sp.description ? `<span class="augur-spell-desc">${escHtml(sp.description)}</span>` : ''}
         </span>
         <span class="augur-spell-xp">+${sp.xp} XP</span>
       </div>`
    ).join('');
    return `
      <div class="augur-section">
        <div class="augur-section-title">DISCOVER A NEW SCHOOL</div>
        <div style="font-family:'Cinzel',serif;font-size:9px;letter-spacing:3px;color:#7a6a50;margin-bottom:10px;">
          THE AUGUR PROPOSES &mdash; EDIT AS YOU SEE FIT
        </div>
        <input class="field-input" id="discover-name-input" value="${escHtml(p.name)}"
               maxlength="50" style="margin-bottom:8px;font-family:'Cinzel',serif;font-size:15px;color:#c9a227;">
        <textarea class="oracle-input" id="discover-flavour-input" rows="2"
                  maxlength="300" style="width:100%;margin-bottom:14px;">${escHtml(p.flavour)}</textarea>
        <div class="augur-result-label">OPENING INCANTATIONS</div>
        ${spellRows}
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
          <button class="consult-btn" onclick="resetDiscover()">BACK</button>
          <button class="oracle-submit" onclick="confirmNewSchool()">INSCRIBE THIS SCHOOL</button>
        </div>
      </div>`;
  }

  return `
    <div class="augur-section">
      <div class="augur-section-title">DISCOVER A NEW SCHOOL</div>
      <div class="augur-section-sub">
        The Augur will divine a new domain of arcane practice and forge its opening incantations.
      </div>
      <textarea class="oracle-input" id="discover-desc-input" rows="3"
        placeholder="Describe the domain you wish to cultivate \u2014 e.g. \u2018I want to improve my creative writing\u2019"
        style="width:100%;margin-bottom:10px;"
        onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();doAugurDiscover();}"
      >${escHtml(st.discoverDesc)}</textarea>
      <div style="display:flex;justify-content:flex-end;">
        <button class="oracle-submit" onclick="doAugurDiscover()">&#10022; CONSULT THE AUGUR</button>
      </div>
    </div>`;
}

function resetRecal() {
  augurState.recalResult = null;
  renderAugurTab();
}

function resetDiscover() {
  augurState.discoverStage   = 'input';
  augurState.discoverPreview = null;
  renderAugurTab();
}

async function doAugurRecalibrate() {
  const schoolId = parseInt(document.getElementById('recal-school-select')?.value);
  const context  = document.getElementById('recal-context-input')?.value.trim() || '';
  if (!schoolId) return;

  augurState.recalLoading = true;
  renderAugurTab();

  const result = await triggerRecalibrate(schoolId, context);
  augurState.recalLoading = false;

  if (!result || result.error || !result.spells) {
    augurState.recalResult = null;
    renderAugurTab();
    // Show error inline — re-render will show form; alert for now
    alert((result && result.error) || 'The Augur could not recalibrate at this time.');
    return;
  }

  const school = getSchool(schoolId);
  augurState.recalResult = { schoolName: school?.name || '', spells: result.spells };
  renderAugurTab();
}

async function doAugurDiscover() {
  const desc = document.getElementById('discover-desc-input')?.value.trim() || '';
  if (!desc) return;
  augurState.discoverDesc   = desc;
  augurState.discoverStage  = 'loading';
  renderAugurTab();

  const result = await apiFetch('/api/augur/school', { description: desc });

  if (result.error || !result.name) {
    augurState.discoverStage = 'input';
    renderAugurTab();
    alert(result.error || 'The Augur could not conceive a school. Try again.');
    return;
  }

  augurState.discoverPreview = result;
  augurState.discoverStage   = 'preview';
  renderAugurTab();
}

async function confirmNewSchool() {
  if (!augurState.discoverPreview) return;
  const name    = document.getElementById('discover-name-input')?.value.trim()   || augurState.discoverPreview.name;
  const flavour = document.getElementById('discover-flavour-input')?.value.trim() || augurState.discoverPreview.flavour;
  if (!name) { alert('A school must have a name.'); return; }

  const result = await apiFetch('/api/augur/school/confirm', {
    name, flavour, spells: augurState.discoverPreview.spells,
  });

  if (result.error || !result.school) {
    alert(result.error || 'Failed to create school.');
    return;
  }

  schools.push(result.school);
  addSchoolCard(result.school);
  updateHeaderStats();
  augurState.discoverStage   = 'input';
  augurState.discoverPreview = null;
  augurState.discoverDesc    = '';

  // Show success briefly then stay on augur tab
  const el = document.getElementById('menu-content');
  if (el) {
    renderAugurTab();
    const succEl = document.createElement('div');
    succEl.style.cssText = 'text-align:center;padding:10px;font-family:Cinzel,serif;font-size:11px;letter-spacing:2px;color:#c9a227;animation:fadein 0.3s ease;';
    succEl.textContent = `\u2726 ${name.toUpperCase()} INSCRIBED \u2726`;
    el.prepend(succEl);
    setTimeout(() => succEl.remove(), 2500);
  }
}

// ── Rank info tooltip ─────────────────────────────────────────────────────────
function toggleRankInfo(btn) {
  const tooltip = btn.nextElementSibling;
  tooltip.classList.toggle('visible');
}

document.addEventListener('click', e => {
  if (!e.target.closest('.rank-info-wrap')) {
    document.querySelectorAll('.rank-tooltip.visible').forEach(t => t.classList.remove('visible'));
  }
});

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (menuOpen) closeMenu();
  else if (!document.getElementById('drawer-overlay').classList.contains('hidden')) closeDrawer();
});
