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
let drawerEditMode = false;

// Menu
let menuOpen = false;
let menuTab  = 'chronicle';

// Chronicle
let chronicleView  = 'log';       // 'log' | 'calendar' | 'milestones'
let calendarDays   = 90;          // 90 | 180 | 365
let calendarData   = null;        // cached response from API
let calendarLoading = false;
let calendarSelectedDay = null;   // date string 'YYYY-MM-DD'
let milestonesData = null;        // cached milestones from API

// Augur tab state
let augurState = {
  mode:           null,    // null | 'recalibrate' | 'discover'
  recalLoading:   false,
  recalResult:    null,   // { schoolName, spells }
  discoverStage:  'input', // 'input' | 'loading' | 'preview'
  discoverPreview: null,  // { name, flavour, spells }
  discoverDesc:   '',
};

// Misc
let bannerTimer = null;

// ── Splash screen ─────────────────────────────────────────────────────────────
function dismissSplash() {
  const splash = document.getElementById('splash');
  if (!splash || splash.classList.contains('hidden') || splash.classList.contains('fade-out')) return;
  splash.classList.add('fade-out');
  setTimeout(() => {
    splash.classList.add('hidden');
    const content = document.getElementById('page-content');
    if (content) content.classList.add('visible');
  }, 500);
}
setTimeout(dismissSplash, 2600);

// Pending recalibration (level-up flow)
let pendingRecal = null; // { schoolId, schoolName, spells }

// ── Themed notifications ──────────────────────────────────────────────────────
let _errorTimer = null;
function showError(msg) {
  const toast = document.getElementById('error-toast');
  const msgEl = document.getElementById('error-toast-msg');
  if (!toast || !msgEl) return;
  msgEl.textContent = msg;
  toast.classList.remove('hidden');
  if (_errorTimer) clearTimeout(_errorTimer);
  _errorTimer = setTimeout(() => toast.classList.add('hidden'), 4500);
}

function showConfirm(msg, onConfirm) {
  const dialog    = document.getElementById('confirm-dialog');
  const msgEl     = document.getElementById('confirm-dialog-msg');
  const cancelBtn = document.getElementById('confirm-dialog-cancel');
  const okBtn     = document.getElementById('confirm-dialog-ok');
  if (!dialog) { if (confirm(msg)) onConfirm(); return; }
  msgEl.textContent = msg;
  dialog.classList.remove('hidden');
  const close = () => dialog.classList.add('hidden');
  cancelBtn.onclick = close;
  okBtn.onclick = () => { close(); onConfirm(); };
}

function confirmSignOut() {
  showConfirm('Sign out of Grimoire?', () => {
    document.getElementById('logout-form').submit();
  });
}

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

// ── Custom select component ───────────────────────────────────────────────────
// Renders a themed dropdown. `options` = [{value, label}], `selectedValue` = current value.
// `onChangeFn` is a string of JS to call with the new value, e.g. "selectAugurMode"
function customSelect(id, options, selectedValue, onChangeFn) {
  const sel = options.find(o => String(o.value) === String(selectedValue)) || options[0];
  const label = sel ? sel.label : '— Select —';
  const optionsHtml = options.map(o => `
    <div class="csel-option ${String(o.value) === String(selectedValue) ? 'active' : ''}"
         data-value="${escHtml(String(o.value))}"
         onclick="pickCustomSelect('${id}','${escHtml(String(o.value))}','${onChangeFn}')">
      ${escHtml(o.label)}
    </div>`).join('');
  return `
    <div class="csel-wrapper" id="csel-${id}" tabindex="0"
         onkeydown="cselKeydown(event,'${id}','${onChangeFn}')"
         onclick="toggleCustomSelect('${id}')">
      <input type="hidden" id="${id}" value="${escHtml(String(selectedValue || ''))}">
      <div class="csel-display">
        <span class="csel-label">${escHtml(label)}</span>
        <svg class="csel-arrow" viewBox="0 0 10 6" xmlns="http://www.w3.org/2000/svg">
          <path d="M0 0l5 6 5-6z" fill="currentColor"/>
        </svg>
      </div>
      <div class="csel-options" id="csel-opts-${id}" onclick="event.stopPropagation()">${optionsHtml}</div>
    </div>`;
}

function toggleCustomSelect(id) {
  const wrapper = document.getElementById(`csel-${id}`);
  const opts    = document.getElementById(`csel-opts-${id}`);
  if (!wrapper || !opts) return;
  const isOpen = wrapper.classList.contains('open');
  // Close all other open selects first
  document.querySelectorAll('.csel-wrapper.open').forEach(el => el.classList.remove('open'));
  if (!isOpen) {
    wrapper.classList.add('open');
    // Close on outside click
    setTimeout(() => document.addEventListener('click', function handler(e) {
      if (!wrapper.contains(e.target)) {
        wrapper.classList.remove('open');
        document.removeEventListener('click', handler);
      }
    }), 0);
  }
}

function pickCustomSelect(id, value, onChangeFn) {
  const input   = document.getElementById(id);
  const wrapper = document.getElementById(`csel-${id}`);
  if (!input || !wrapper) return;
  input.value = value;
  wrapper.classList.remove('open');
  // Update label
  const label = wrapper.querySelector('.csel-label');
  const active = wrapper.querySelector(`.csel-option[data-value="${CSS.escape(value)}"]`);
  if (label && active) label.textContent = active.textContent.trim();
  // Mark active option
  wrapper.querySelectorAll('.csel-option').forEach(el =>
    el.classList.toggle('active', el.dataset.value === value)
  );
  // Fire the callback
  if (onChangeFn) window[onChangeFn](value);
}

function cselKeydown(e, id, onChangeFn) {
  const wrapper = document.getElementById(`csel-${id}`);
  if (!wrapper) return;
  const opts = [...wrapper.querySelectorAll('.csel-option')];
  const cur  = opts.findIndex(o => o.classList.contains('active'));
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCustomSelect(id); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); pickCustomSelect(id, opts[Math.min(cur+1, opts.length-1)].dataset.value, onChangeFn); }
  else if (e.key === 'ArrowUp')   { e.preventDefault(); pickCustomSelect(id, opts[Math.max(cur-1, 0)].dataset.value, onChangeFn); }
  else if (e.key === 'Escape')    { wrapper.classList.remove('open'); }
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
  const color = s ? s.color : '#c9a227';
  card.style.setProperty('--card-color', color + '50');
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 900);

  // Arcane ring pulses — two rings expand outward from the card
  const rect = card.getBoundingClientRect();
  for (let i = 0; i < 2; i++) {
    const ring = document.createElement('div');
    ring.className = 'arcane-ring';
    ring.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;--ring-color:${color};animation-delay:${i * 0.18}s;`;
    document.body.appendChild(ring);
    setTimeout(() => ring.remove(), 900 + i * 180);
  }
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
async function applyXPResult(result) {
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
  calendarData = null;
  if (result.leveled_up) {
    milestonesData = null;
    showBanner(school, result.level, result.rank);
    refreshAITitle();
  }
}

function updateHeaderStats() {
  if (!schools.length) return;
  const avgLv = Math.round(schools.reduce((a, s) => a + s.level, 0) / schools.length);
  const rank  = getRank(avgLv);
  const rankEl = document.querySelector('.header-stats .header-stat:nth-child(1) .hstat-value');
  const lvEl   = document.querySelector('.header-stats .header-stat:nth-child(3) .hstat-value');
  if (rankEl) { rankEl.textContent = rank.name; rankEl.style.color = rank.color; rankEl.style.textShadow = `0 0 14px ${rank.color}70`; }
  if (lvEl)   lvEl.textContent = avgLv;
}

async function refreshAITitle() {
  const el = document.getElementById('header-ai-title');
  if (!el) return;
  const result = await apiFetch('/api/augur/title', {});
  if (result.title) {
    if (result.title !== el.textContent) milestonesData = null;
    el.textContent = result.title;
  }
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
  banner.style.setProperty('--banner-color', school.color);
  banner.classList.remove('hidden', 'hiding');
  void banner.offsetWidth;
  if (bannerTimer) clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => {
    banner.classList.add('hiding');
    setTimeout(() => { banner.classList.remove('hiding'); banner.classList.add('hidden'); }, 360);
  }, 3800);
}

// ── Spell drawer ──────────────────────────────────────────────────────────────
function openDrawer(schoolId) {
  activeSchoolId = schoolId;
  pendingVerdict = null;
  deedLoading    = false;
  const overlay = document.getElementById('drawer-overlay');
  overlay.classList.remove('hidden', 'closing');
  document.body.style.overflow = 'hidden';
  // Render after showing so the slide animation isn't blocked by innerHTML work
  requestAnimationFrame(() => renderDrawer());
}

function closeDrawer() {
  const overlay = document.getElementById('drawer-overlay');
  overlay.classList.add('closing');
  document.body.style.overflow = '';
  activeSchoolId = null;
  setTimeout(() => {
    overlay.classList.add('hidden');
    overlay.classList.remove('closing');
  }, 200);
  pendingVerdict = null;
  drawerEditMode = false;
}

async function deleteSchool(schoolId) {
  const school = getSchool(schoolId);
  if (!school) return;
  showConfirm(`Banish the school of ${school.name}? This cannot be undone.`, async () => {
    const result = await apiFetch(`/api/school/${schoolId}`, {}, 'DELETE');
    if (result.error) { showError(result.error); return; }
    closeDrawer();
    schools = schools.filter(s => s.id !== schoolId);
    const card = document.getElementById(`card-${schoolId}`);
    if (card) card.remove();
    refreshAITitle();
    renderMenu();
  });
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
  if (drawerEditMode) { renderDrawerEdit(); return; }
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
      <div class="oracle-section-label">PRESENT A DEED BEFORE THE AUGUR</div>
      <div class="oracle-section-sub" style="font-family:'Cinzel',serif;font-size:9px;letter-spacing:2px;color:#7a6a50;margin-bottom:10px;">FOR ACTS THAT LIE BEYOND THY DAILY RITES</div>
      <div class="oracle-row">
        <textarea class="oracle-input" id="deed-input" rows="2"
          placeholder="Declare thy act\u2026 e.g. \u2018I ran 12km in the rain\u2019"
          ${deedLoading ? 'disabled' : ''}
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();submitDeed();}"></textarea>
        <button class="oracle-submit" onclick="submitDeed()" ${deedLoading ? 'disabled' : ''}>
          ${deedLoading ? '<div class="ai-spinner"></div>' : 'SUBMIT'}
        </button>
      </div>
      ${deedLoading ? `<div id="deed-flavour" class="recal-flavour-text" style="font-size:11px;color:#7a6a50;font-style:italic;margin-top:8px;text-align:center;"></div>` : ''}`;
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
        <button class="drawer-edit-btn" onclick="enterDrawerEditMode()" aria-label="Edit">&#9998;</button>
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

// ── Drawer edit mode ──────────────────────────────────────────────────────────

function enterDrawerEditMode() {
  drawerEditMode = true;
  renderDrawer();
}

function exitDrawerEditMode() {
  drawerEditMode = false;
  renderDrawer();
}

function renderDrawerEdit() {
  const school = getSchool(activeSchoolId);
  if (!school) return;
  const rank = school.rank || getRank(school.level);

  const spellRows = (school.spells || []).map(sp => `
    <div class="edit-spell-row" id="edit-spell-${sp.id}">
      <div style="display:flex;gap:6px;margin-bottom:4px;align-items:center;">
        <input class="field-input" id="esp-name-${sp.id}" value="${escHtml(sp.name)}" maxlength="80"
               placeholder="Incantation name" style="flex:1;font-size:13px;padding:6px 8px;">
        <input type="number" class="field-input" id="esp-xp-${sp.id}" value="${sp.xp}" min="10" max="50"
               style="width:52px;font-size:13px;padding:6px 8px;text-align:center;">
        <button class="drawer-edit-btn" style="font-size:16px;" onclick="saveSpellEdit(${sp.id})" title="Save">&#10003;</button>
        <button class="drawer-edit-btn" style="font-size:14px;color:#9a4a4a;" onclick="deleteSpell(${sp.id})" title="Delete">&#10005;</button>
      </div>
      <input class="field-input" id="esp-desc-${sp.id}" value="${escHtml(sp.description)}" maxlength="120"
             placeholder="Plain description — e.g. Walk 8,000 steps" style="width:100%;font-size:13px;padding:6px 8px;">
    </div>`
  ).join('');

  document.getElementById('drawer-content').innerHTML = `
    <div class="drawer-header" style="flex-direction:column;align-items:stretch;gap:8px;">
      <div style="display:flex;align-items:center;gap:10px;">
        <div class="rank-badge"
             style="color:${rank.color};border-color:${rank.color}80;background:${rank.color}15;flex-shrink:0;">
          ${rank.name}
        </div>
        <input class="field-input" id="edit-school-name" value="${escHtml(school.name)}" maxlength="50"
               style="flex:1;font-family:'Cinzel',serif;font-size:15px;color:#c9a227;padding:6px 10px;">
        <div class="school-color-swatch" id="school-color-swatch" style="background:${school.color};"
             onclick="toggleColorPopover()" title="Change colour"></div>
        <input type="hidden" id="edit-school-color" value="${school.color}">
        <button class="drawer-close" onclick="closeDrawer()" aria-label="Close">&times;</button>
      </div>
      <textarea class="oracle-input" id="edit-school-flavour" rows="2" maxlength="300"
                style="width:100%;">${escHtml(school.flavour)}</textarea>
      <div style="display:flex;justify-content:flex-end;">
        <button class="oracle-submit" onclick="saveSchoolEdit()">SAVE</button>
      </div>
    </div>
    <div class="divider" style="margin:12px 0;"></div>
    <div class="oracle-section-label" style="margin-bottom:10px;">INCANTATIONS</div>
    <div id="edit-spell-list">${spellRows}</div>
    <div id="add-spell-area" style="margin-top:10px;">
      <div id="add-spell-collapsed" style="display:flex;justify-content:center;">
        <button class="consult-btn" style="letter-spacing:2px;" onclick="showAddSpellForm()">+ ADD INCANTATION</button>
      </div>
      <div id="add-spell-form" style="display:none;">
        <div style="display:flex;gap:6px;margin-bottom:4px;align-items:center;">
          <input class="field-input" id="new-spell-name" maxlength="80" placeholder="Incantation name"
                 style="flex:1;font-size:13px;padding:6px 8px;">
          <input type="number" class="field-input" id="new-spell-xp" value="20" min="10" max="50"
                 style="width:52px;font-size:13px;padding:6px 8px;text-align:center;">
        </div>
        <input class="field-input" id="new-spell-desc" maxlength="120"
               placeholder="Plain description — e.g. Walk 8,000 steps"
               style="width:100%;font-size:13px;padding:6px 8px;margin-bottom:8px;">
        <div style="display:flex;justify-content:flex-end;gap:8px;">
          <button class="consult-btn" onclick="hideAddSpellForm()">CANCEL</button>
          <button class="oracle-submit" onclick="addSpell()">ADD</button>
        </div>
      </div>
    </div>
    <div class="divider" style="margin:14px 0;"></div>
    <div style="display:flex;justify-content:flex-end;">
      <button class="consult-btn" onclick="exitDrawerEditMode()">DONE</button>
    </div>`;
}

function showAddSpellForm() {
  document.getElementById('add-spell-collapsed').style.display = 'none';
  document.getElementById('add-spell-form').style.display = '';
  document.getElementById('new-spell-name').focus();
}

function hideAddSpellForm() {
  document.getElementById('add-spell-collapsed').style.display = '';
  document.getElementById('add-spell-form').style.display = 'none';
}

async function saveSchoolEdit() {
  const name    = (document.getElementById('edit-school-name').value || '').trim();
  const flavour = (document.getElementById('edit-school-flavour').value || '').trim();
  const color   = document.getElementById('edit-school-color').value;
  if (!name) return;
  const result = await apiFetch(`/api/school/${activeSchoolId}`, { name, flavour, color }, 'PUT');
  if (result.error) { showError(result.error); return; }
  const school = getSchool(activeSchoolId);
  if (school) { school.name = result.name; school.flavour = result.flavour; school.color = result.color; }
  updateCardDOM(school);
  const card = document.getElementById(`card-${activeSchoolId}`);
  if (card) card.style.setProperty('--card-color', result.color + '50');
  renderDrawerEdit();
  if (typeof renderOrrery === 'function') renderOrrery();
}

// Fixed S/L keeps all colours in the same muted jewel-tone family as the app
const COLOR_S = 55, COLOR_L = 62;

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = n => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return '#' + [f(0), f(8), f(4)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}

function hexToHue(hex) {
  const r = parseInt(hex.slice(1,3),16)/255, g = parseInt(hex.slice(3,5),16)/255, b = parseInt(hex.slice(5,7),16)/255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b), d = max - min;
  if (d === 0) return 0;
  let h = max === r ? ((g-b)/d % 6) : max === g ? (b-r)/d + 2 : (r-g)/d + 4;
  return Math.round(h * 60 + 360) % 360;
}

function toggleColorPopover() {
  const existing = document.getElementById('color-popover');
  if (existing) { existing.remove(); return; }

  const current = document.getElementById('edit-school-color').value;
  const hue     = hexToHue(current);
  const swatch  = document.getElementById('school-color-swatch');

  // Hue gradient stops for slider track
  const gradStops = Array.from({length: 13}, (_,i) => {
    const h = Math.round(i * 30);
    return `hsl(${h},${COLOR_S}%,${COLOR_L}%)`;
  }).join(', ');

  const pop = document.createElement('div');
  pop.id = 'color-popover';
  pop.className = 'color-popover';
  pop.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;">
      <div id="color-hue-preview" style="
        width:28px;height:28px;border-radius:50%;flex-shrink:0;
        background:${hslToHex(hue,COLOR_S,COLOR_L)};
        border:2px solid rgba(255,255,255,0.2);"></div>
      <input type="range" id="color-hue-slider" class="color-hue-slider"
             min="0" max="359" value="${hue}"
             style="--grad:linear-gradient(to right,${gradStops});"
             oninput="onHueSlide(this.value)">
    </div>`;

  // Position above the swatch
  const rect      = swatch.getBoundingClientRect();
  const drawerEl  = document.querySelector('.panel-drawer');
  const drawerRect = drawerEl.getBoundingClientRect();
  pop.style.top   = (rect.bottom - drawerRect.top + 8) + 'px';
  pop.style.right = (drawerRect.right - rect.right) + 'px';

  drawerEl.appendChild(pop);

  setTimeout(() => document.addEventListener('click', function handler(e) {
    if (!pop.contains(e.target) && e.target !== swatch) {
      pop.remove(); document.removeEventListener('click', handler);
    }
  }), 0);
}

function onHueSlide(hue) {
  const color = hslToHex(parseInt(hue), COLOR_S, COLOR_L);
  document.getElementById('color-hue-preview').style.background = color;
  document.getElementById('edit-school-color').value = color;
  document.getElementById('school-color-swatch').style.background = color;
}

function pickSchoolColor(color) {
  document.getElementById('edit-school-color').value = color;
  document.getElementById('school-color-swatch').style.background = color;
  document.getElementById('color-popover')?.remove();
}

async function saveSpellEdit(spellId) {
  const name = (document.getElementById(`esp-name-${spellId}`).value || '').trim();
  const desc = (document.getElementById(`esp-desc-${spellId}`).value || '').trim();
  const xp   = Math.max(10, Math.min(50, parseInt(document.getElementById(`esp-xp-${spellId}`).value, 10) || 20));
  if (!name) return;
  const result = await apiFetch(`/api/spell/${spellId}`, { name, description: desc, xp }, 'PUT');
  if (result.error) { showError(result.error); return; }
  const school = getSchool(activeSchoolId);
  if (school) {
    const sp = school.spells.find(s => s.id === spellId);
    if (sp) { sp.name = result.name; sp.description = result.description; sp.xp = result.xp; }
  }
}

async function deleteSpell(spellId) {
  const result = await apiFetch(`/api/spell/${spellId}`, {}, 'DELETE');
  if (result.error) { showError(result.error); return; }
  const school = getSchool(activeSchoolId);
  if (school) school.spells = school.spells.filter(s => s.id !== spellId);
  renderDrawerEdit();
}

async function addSpell() {
  const name = (document.getElementById('new-spell-name').value || '').trim();
  const desc = (document.getElementById('new-spell-desc').value || '').trim();
  const xp   = Math.max(10, Math.min(50, parseInt(document.getElementById('new-spell-xp').value, 10) || 20));
  if (!name) return;
  const result = await apiFetch(`/api/school/${activeSchoolId}/spell`, { name, description: desc, xp });
  if (result.error) { showError(result.error); return; }
  const school = getSchool(activeSchoolId);
  if (school) school.spells.push(result);
  renderDrawerEdit();
}

// ── Cast preset spell ─────────────────────────────────────────────────────────
async function castSpell(spellId, schoolId) {
  if (deedLoading) return;
  deedLoading = true;
  const result = await apiFetch('/api/cast', { spell_id: spellId });
  deedLoading = false;
  if (result.error) { showError(result.error); return; }
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
  setTimeout(() => startRecalFlavour('deed-flavour'), 0);
  let result;
  try {
    result = await apiFetch('/api/augur/deed', { school_id: activeSchoolId, deed });
  } finally {
    stopRecalFlavour();
    deedLoading = false;
  }
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
  if (result.error) { showError(result.error); return; }
  result._deed_name = deed;
  result._is_custom = true;
  result._verdict   = verdict;
  applyXPResult(result);
  closeDrawer();
}

// ── Recal panel flavour text cycling ─────────────────────────────────────────
const RECAL_FLAVOUR_LINES = [
  'The Augur peers into your potential\u2026',
  'Recalibrating your arcane signature\u2026',
  'The stars are being consulted\u2026',
  'Ancient rites are being rewritten\u2026',
  'Your deeds are being weighed\u2026',
  'The Augur communes with the void\u2026',
  'New trials are being forged\u2026',
  'The ledger of fate is being revised\u2026',
];
let _recalFlavourTimer = null;

function startRecalFlavour(elId = 'recal-flavour-text') {
  stopRecalFlavour();
  const el = document.getElementById(elId);
  if (!el) return;
  let i = 0;
  el.textContent = RECAL_FLAVOUR_LINES[0];
  el.style.opacity = '1';
  _recalFlavourTimer = setInterval(() => {
    i = (i + 1) % RECAL_FLAVOUR_LINES.length;
    el.style.opacity = '0';
    setTimeout(() => {
      const current = document.getElementById(elId);
      if (current) { current.textContent = RECAL_FLAVOUR_LINES[i]; current.style.opacity = '1'; }
    }, 300);
  }, 5000);
}

function stopRecalFlavour() {
  if (_recalFlavourTimer) { clearInterval(_recalFlavourTimer); _recalFlavourTimer = null; }
}

// ── Auto-recalibrate on rank-up (panel flow) ──────────────────────────────────
async function triggerRecalibrate(schoolId) {
  const school = getSchool(schoolId);
  // Show panel immediately in loading state
  document.getElementById('recal-panel-school').textContent = (school?.name || '').toUpperCase();
  document.getElementById('recal-panel-loading').style.display = '';
  document.getElementById('recal-panel-results').style.display = 'none';
  document.getElementById('recal-panel').classList.remove('hidden');
  startRecalFlavour('recal-flavour-text');

  let result;
  try {
    result = await apiFetch('/api/augur/recalibrate', { school_id: schoolId, context: '' });
  } finally {
    stopRecalFlavour();
  }

  if (!result || result.error || !result.spells) {
    document.getElementById('recal-panel').classList.add('hidden');
    showError((result && result.error) || 'The Augur could not recalibrate at this time.');
    return;
  }

  pendingRecal = { schoolId, schoolName: school?.name || '', spells: result.spells };
  const spellRows = result.spells.map(sp => `
    <div class="augur-spell-row">
      <span class="augur-spell-name-wrap">
        <span>${escHtml(sp.name)}</span>
        ${sp.description ? `<span class="augur-spell-desc">${escHtml(sp.description)}</span>` : ''}
      </span>
      <span class="augur-spell-xp">+${sp.xp} XP</span>
    </div>`).join('');
  document.getElementById('recal-panel-spells').innerHTML = spellRows;
  document.getElementById('recal-panel-loading').style.display = 'none';
  document.getElementById('recal-panel-results').style.display = '';
}

async function acceptRecal() {
  if (!pendingRecal) return;
  const { schoolId, spells } = pendingRecal;
  const result = await apiFetch('/api/augur/recalibrate/confirm', { school_id: schoolId, spells });
  if (result.error) return;
  const school = getSchool(schoolId);
  if (school) school.spells = result.spells;
  if (activeSchoolId === schoolId) renderDrawer();
  dismissRecal();
}

function dismissRecal() {
  pendingRecal = null;
  document.getElementById('recal-panel').classList.add('hidden');
}

// ── Side menu ─────────────────────────────────────────────────────────────────
function openMenu() {
  menuOpen = true;
  const overlay = document.getElementById('menu-overlay');
  overlay.classList.remove('hidden', 'closing');
  document.body.style.overflow = 'hidden';
  // Add .open on next frame so the panel has a translated starting position to animate from
  requestAnimationFrame(() => {
    overlay.classList.add('open');
    renderMenuContent();
  });
}

function closeMenu() {
  menuOpen = false;
  const overlay = document.getElementById('menu-overlay');
  overlay.classList.remove('open');
  overlay.classList.add('closing');
  document.body.style.overflow = '';
  setTimeout(() => {
    overlay.classList.add('hidden');
    overlay.classList.remove('closing');
  }, 260); // slightly longer than the 0.25s panel transition
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
  el.innerHTML = `
    <div class="chronicle-title">CHRONICLE OF INCANTATIONS</div>
    <div class="chronicle-sub">A record of your mortal striving.</div>
    <div class="chronicle-toggle">
      <button class="chr-tab-btn ${chronicleView === 'log'        ? 'active' : ''}" onclick="setChronicleView('log')">LOG</button>
      <button class="chr-tab-btn ${chronicleView === 'calendar'   ? 'active' : ''}" onclick="setChronicleView('calendar')">CALENDAR</button>
      <button class="chr-tab-btn ${chronicleView === 'milestones' ? 'active' : ''}" onclick="setChronicleView('milestones')">MILESTONES</button>
    </div>
    <div id="chronicle-body"></div>`;
  if (chronicleView === 'log') renderChronicleLog();
  else if (chronicleView === 'calendar') renderChronicleCalendar();
  else renderChronicleMilestones();
}

function setChronicleView(view) {
  chronicleView = view;
  renderChronicle();
}

function renderChronicleLog() {
  const el = document.getElementById('chronicle-body');
  if (!el) return;

  // Group by date
  const byDate = {};
  for (const entry of deedLog) {
    const date = (entry.cast_at || '').slice(0, 10);
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(entry);
  }

  const dates = Object.keys(byDate).sort((a, b) => b.localeCompare(a));
  if (!dates.length) {
    el.innerHTML = `<div class="chronicle-empty">The Chronicle is empty.<br><span class="log-empty-sub">PERFORM YOUR FIRST INCANTATION TO BEGIN</span></div>`;
    return;
  }

  let html = '';
  for (const date of dates) {
    const entries = byDate[date];
    const label = formatDateLabel(date);
    html += `<div class="chr-date-group"><div class="chr-date-label">${label}</div>`;
    for (const entry of entries) {
      html += `
        <div class="log-entry">
          <div class="log-school-dot" style="background:${entry.school_color};box-shadow:0 0 6px ${entry.school_color}60;"></div>
          <div class="log-body">
            <div class="log-deed">
              ${escHtml(entry.deed_name)}
              ${entry.is_custom ? '<span class="ai-tag">&#10022; AUGUR</span>' : ''}
            </div>
            ${entry.augur_verdict ? `<div class="log-verdict">&ldquo;${escHtml(entry.augur_verdict)}&rdquo;</div>` : ''}
            <div class="log-meta">${escHtml(entry.school_name)}</div>
          </div>
          <div class="log-xp" style="color:${entry.school_color};">+${entry.xp} XP</div>
        </div>`;
    }
    html += `</div>`;
  }
  el.innerHTML = html;
}

function formatDateLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const today = new Date(); today.setHours(0,0,0,0);
  const diff  = Math.round((today - d) / 86400000);
  if (diff === 0) return 'TODAY';
  if (diff === 1) return 'YESTERDAY';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).toUpperCase();
}

// ── Chronicle Calendar ────────────────────────────────────────────────────────
async function renderChronicleCalendar() {
  const el = document.getElementById('chronicle-body');
  if (!el) return;

  const rangeBtns = [90, 180, 365].map(d =>
    `<button class="chr-range-btn ${calendarDays === d ? 'active' : ''}" onclick="setCalendarRange(${d})">${d === 90 ? '90 DAYS' : d === 180 ? '6 MONTHS' : '1 YEAR'}</button>`
  ).join('');

  if (calendarLoading) {
    el.innerHTML = `
      <div class="chr-range-row">${rangeBtns}</div>
      <div style="text-align:center;padding:40px 0;color:#7a6a50;font-family:'Cinzel',serif;font-size:10px;letter-spacing:2px;">
        THE AUGUR READS THE STARS&hellip;
      </div>`;
    return;
  }

  if (!calendarData) {
    calendarLoading = true;
    renderChronicleCalendar();
    const result = await apiFetch('/api/chronicle/calendar', { days: calendarDays });
    calendarLoading = false;
    calendarData = result;
    renderChronicle();
    return;
  }

  // Build grid: calendarDays cells ending today
  const today = new Date(); today.setHours(0,0,0,0);
  const cells = [];
  for (let i = calendarDays - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    cells.push(d.toISOString().slice(0, 10));
  }

  // Find max XP in a day for intensity scaling
  const xpValues = cells.map(c => calendarData[c]?.xp || 0);
  const maxXP = Math.max(...xpValues, 1);

  const cellsHtml = cells.map(date => {
    const day = calendarData[date];
    const xp  = day?.xp || 0;
    const intensity = xp === 0 ? 0 : Math.max(0.15, xp / maxXP);
    const alpha = (intensity * 0.7 + 0.1).toFixed(2);

    let title = date;
    let bg = 'rgba(201,162,39,0.05)';
    if (day && xp > 0) {
      const schoolNames = day.schools.map(s => s.name).join(', ');
      title = `${date}: ${xp} XP — ${schoolNames}`;
      if (day.schools.length === 1) {
        bg = `rgba(${hexToRgb(day.schools[0].color)},${alpha})`;
      } else {
        bg = makeConicGradient(day.schools, alpha);
      }
    }

    const isSelected = date === calendarSelectedDay;
    return `<div class="chr-cal-cell ${isSelected ? 'selected' : ''}"
      style="background:${bg};${isSelected ? 'outline:1px solid rgba(201,162,39,0.6);' : ''}"
      title="${escHtml(title)}"
      onclick="selectCalendarDay('${date}')"></div>`;
  }).join('');

  // Day detail panel
  let detailHtml = '';
  if (calendarSelectedDay && calendarData[calendarSelectedDay]) {
    const day = calendarData[calendarSelectedDay];
    const label = formatDateLabel(calendarSelectedDay);
    const deedRows = day.deeds.map(d => `
      <div class="log-entry" style="padding:6px 0;">
        <div class="log-school-dot" style="background:${d.school_color};box-shadow:0 0 4px ${d.school_color}60;"></div>
        <div class="log-body">
          <div class="log-deed" style="font-size:13px;">${escHtml(d.deed_name)}${d.is_custom ? ' <span class="ai-tag">&#10022; AUGUR</span>' : ''}</div>
          <div class="log-meta">${escHtml(d.school_name)}</div>
        </div>
        <div class="log-xp" style="color:${d.school_color};">+${d.xp} XP</div>
      </div>`).join('');
    detailHtml = `
      <div class="chr-day-detail">
        <div class="chr-day-detail-title">${label} &mdash; ${day.xp} XP</div>
        ${deedRows}
      </div>`;
  } else if (calendarSelectedDay) {
    detailHtml = `<div class="chr-day-detail" style="color:#7a6a50;font-style:italic;text-align:center;">No incantations on this day.</div>`;
  }

  el.innerHTML = `
    <div class="chr-range-row">${rangeBtns}</div>
    <div class="chr-cal-grid" style="--cols:${calendarDays === 90 ? 13 : calendarDays === 180 ? 26 : 53};">${cellsHtml}</div>
    <div class="chr-cal-legend">
      <span style="color:#7a6a50;font-size:10px;letter-spacing:1px;">LESS</span>
      ${[0.05, 0.25, 0.45, 0.65, 0.85].map(o => `<div class="chr-cal-cell" style="background:rgba(201,162,39,${o});pointer-events:none;"></div>`).join('')}
      <span style="color:#7a6a50;font-size:10px;letter-spacing:1px;">MORE</span>
    </div>
    ${detailHtml}`;
}

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return `${r},${g},${b}`;
}

function makeConicGradient(schools, alpha) {
  const valid = schools.filter(sc => sc.color && sc.color.length === 7);
  if (!valid.length) return `rgba(201,162,39,${alpha})`;

  const sorted = [...valid].sort((a, b) => (b.xp || 0) - (a.xp || 0));
  const rawTotal = sorted.reduce((s, sc) => s + (sc.xp || 0), 0);
  const total = rawTotal || sorted.length;

  const bounds = [0];
  for (const sc of sorted) {
    const xp = sc.xp || (rawTotal === 0 ? 1 : 0);
    bounds.push(bounds[bounds.length - 1] + (xp / total) * 360);
  }

  // Rotate so the seam lands at the midpoint of the dominant colour's solid zone.
  // Both sides of the seam then show the same solid colour → completely invisible.
  const rotOffset = bounds[1] / 2;

  // Compute each segment's solid zone after rotation
  const segs = sorted.map((sc, i) => {
    const span = bounds[i + 1] - bounds[i];
    const blend = Math.min(18, span * 0.25);
    return {
      rgb: hexToRgb(sc.color),
      s: ((bounds[i]     + blend - rotOffset) % 360 + 360) % 360,
      e: ((bounds[i + 1] - blend - rotOffset) % 360 + 360) % 360,
    };
  });

  // The first segment straddles the seam — split it into a tail [s→360] and a head [0→e].
  // All other segments sit in the middle. CSS extends the head to 0° and the tail to 360°,
  // so both sides of the seam show the dominant colour.
  const head = segs[0];
  const tail = segs[0];
  const mid  = segs.slice(1);

  const pairs = [
    { rgb: head.rgb, s: 0,       e: head.e },   // dominant head (0° side of seam)
    ...mid.map(sg => ({ rgb: sg.rgb, s: sg.s, e: sg.e })),
    { rgb: tail.rgb, s: tail.s,  e: 360 },       // dominant tail (360° side of seam)
  ];

  const stops = pairs.map(p =>
    `rgba(${p.rgb},${alpha}) ${p.s.toFixed(1)}deg ${p.e.toFixed(1)}deg`
  ).join(', ');

  return `conic-gradient(from ${rotOffset.toFixed(1)}deg, ${stops})`;
}

async function setCalendarRange(days) {
  calendarDays = days;
  calendarData = null;
  calendarSelectedDay = null;
  renderChronicle();
}

function selectCalendarDay(date) {
  calendarSelectedDay = calendarSelectedDay === date ? null : date;
  // Re-render just the body to avoid re-fetching
  renderChronicleCalendar();
}

// ── Chronicle milestones ──────────────────────────────────────────────────────
async function renderChronicleMilestones() {
  const el = document.getElementById('chronicle-body');
  if (!el) return;

  if (!milestonesData) {
    el.innerHTML = `<div style="text-align:center;color:#7a6a50;font-style:italic;padding:20px;">Consulting the annals…</div>`;
    const result = await apiFetch('/api/chronicle/milestones', {});
    if (result.error) { el.innerHTML = `<div style="color:#9a4a4a;">${escHtml(result.error)}</div>`; return; }
    milestonesData = result;
    // Re-check we're still on milestones tab
    if (chronicleView !== 'milestones') return;
  }

  if (!milestonesData.length) {
    el.innerHTML = `<div style="text-align:center;color:#7a6a50;font-style:italic;padding:30px 0;">
      No milestones yet. Keep casting your incantations.
    </div>`;
    return;
  }

  const ICONS = { rank: '⬡', level: '✦', title: '✧' };

  const rows = milestonesData.map(m => {
    const icon  = ICONS[m.type] || '·';
    const color = m.school_color || '#c9a227';
    const date  = formatDateLabel(m.occurred_at.slice(0, 10));

    // Colour "Rank X" with the rank's colour, "Level N" with the school colour
    let desc = escHtml(m.description);
    desc = desc.replace(/Rank ([FEDCBAS])/g, (_, r) => {
      const rc = RANKS.find(x => x.name === r)?.color || color;
      return `Rank <span style="color:${rc};font-weight:700;">${r}</span>`;
    });
    desc = desc.replace(/Level (\d+)/g, (_, n) =>
      `Level <span style="color:${color};font-weight:700;">${n}</span>`
    );

    return `
      <div class="milestone-row">
        <div class="milestone-icon" style="color:${color};">${icon}</div>
        <div class="milestone-body">
          <div class="milestone-desc">${desc}</div>
          <div class="milestone-date">${date}</div>
        </div>
      </div>`;
  }).join('');

  el.innerHTML = `<div class="milestone-list">${rows}</div>`;
}

// ── Orrery (radar chart) ──────────────────────────────────────────────────────
function renderOrrery() {
  const el = document.getElementById('menu-content');
  if (!el) return;

  const N   = schools.length;
  const CX  = 150, CY = 150, R = 110;
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

  // HTML legend — no SVG text, no overflow issues
  const legendHtml = `<div class="orrery-legend">${schools.map(s => {
    const rank = s.rank || getRank(s.level);
    return `<div class="orrery-legend-item">
      <span class="orrery-legend-dot" style="background:${s.color};box-shadow:0 0 5px ${s.color}70;"></span>
      <span class="orrery-legend-name" style="color:${s.color};">${escHtml(s.name)}</span>
      <span class="orrery-legend-rank" style="color:${rank.color};">LV${s.level} ${rank.name}</span>
    </div>`;
  }).join('')}</div>`;

  const total  = schools.reduce((a, s) => a + (s.total_xp || 0), 0);
  const avgLv  = schools.length ? Math.round(schools.reduce((a, s) => a + s.level, 0) / schools.length) : 1;
  const orank  = getRank(avgLv);

  el.innerHTML = `
    <div class="orrery-title">THE ORRERY</div>
    <div class="orrery-sub">Constellation of your arcane schools.</div>
    <svg viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg"
         style="width:100%;max-width:300px;display:block;margin:0 auto;">
      ${grid}
      ${spokes}
      <polygon points="${dataPts}"
        fill="rgba(201,162,39,0.07)"
        stroke="rgba(201,162,39,0.55)"
        stroke-width="1.5"
        class="orrery-polygon"/>
      ${nodes}
      <circle cx="${CX}" cy="${CY}" r="3" fill="rgba(201,162,39,0.4)"/>
    </svg>
    ${legendHtml}
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

const AUGUR_MODE_LABELS = {
  recalibrate: 'Reforge a School',
  discover:    'Discover a New School',
};

// ── Augur tab ─────────────────────────────────────────────────────────────────
function renderAugurTab() {
  const el = document.getElementById('menu-content');
  if (!el) return;

  const { mode } = augurState;

  const modeOptions = [
    { value: '',             label: '— Choose your purpose —' },
    { value: 'recalibrate',  label: 'Reforge a School' },
    { value: 'discover',     label: 'Discover a New School' },
  ];

  const sectionHtml = mode === 'recalibrate' ? renderRecalibrateSection()
                    : mode === 'discover'    ? renderDiscoverSection()
                    : '';

  el.innerHTML = `
    <div class="augur-panel-title">THE AUGUR'S CHAMBER</div>
    <div class="augur-panel-sub">Seek counsel. Forge new paths.</div>
    <div class="augur-section">
      ${customSelect('augur-mode-select', modeOptions, mode || '', 'selectAugurMode')}
    </div>
    ${sectionHtml}`;

  if (mode === 'recalibrate') updateRecalBanish();
}

function selectAugurMode(val) {
  augurState.mode = val || null;
  // Reset sub-state when switching modes
  augurState.recalResult   = null;
  augurState.recalLoading  = false;
  augurState.discoverStage = 'input';
  augurState.discoverPreview = null;
  renderAugurTab();
}

function renderRecalibrateSection() {
  const st = augurState;

  const schoolOptions = schools.map(s =>
    ({ value: String(s.id), label: `${s.name} — LV${s.level}` })
  );
  const defaultSchoolId = String(schools[0]?.id || '');

  if (st.recalLoading) {
    setTimeout(() => startRecalFlavour('augur-recal-flavour'), 0);
    return `
      <div class="augur-section">
        <div class="augur-section-title">RECALIBRATE A SCHOOL</div>
        <div style="text-align:center;padding:24px 0;">
          <div class="ai-spinner" style="width:18px;height:18px;border-width:2px;margin:0 auto 12px;"></div>
          <div id="augur-recal-flavour" class="recal-flavour-text" style="font-family:'Cinzel',serif;font-size:10px;letter-spacing:2px;color:#7a6a50;">
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
        <div style="margin-top:12px;display:flex;justify-content:flex-end;gap:8px;">
          <button class="consult-btn" onclick="resetRecal()">DENY</button>
          <button class="oracle-submit" onclick="confirmRecal()">ACCEPT</button>
        </div>
      </div>`;
  }

  return `
    <div class="augur-section">
      <div class="augur-section-title">RECALIBRATE A SCHOOL</div>
      <div class="augur-section-sub">
        The Augur will reforge a school's incantations based on your level, history, and any guidance you provide.
      </div>
      ${customSelect('recal-school-select', schoolOptions, defaultSchoolId, 'updateRecalBanish')}
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
    setTimeout(() => startRecalFlavour('augur-discover-flavour'), 0);
    return `
      <div class="augur-section">
        <div class="augur-section-title">DISCOVER A NEW SCHOOL</div>
        <div style="text-align:center;padding:24px 0;">
          <div class="ai-spinner" style="width:18px;height:18px;border-width:2px;margin:0 auto 12px;"></div>
          <div id="augur-discover-flavour" class="recal-flavour-text" style="font-family:'Cinzel',serif;font-size:10px;letter-spacing:2px;color:#7a6a50;">
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

  let result;
  try {
    result = await apiFetch('/api/augur/recalibrate', { school_id: schoolId, context });
  } finally {
    stopRecalFlavour();
    augurState.recalLoading = false;
  }

  if (!result || result.error || !result.spells) {
    augurState.recalResult = null;
    renderAugurTab();
    showError((result && result.error) || 'The Augur could not recalibrate at this time.');
    return;
  }

  const school = getSchool(schoolId);
  augurState.recalResult = { schoolId, schoolName: school?.name || '', spells: result.spells };
  renderAugurTab();
}

async function confirmRecal() {
  const { schoolId, spells } = augurState.recalResult;
  const result = await apiFetch('/api/augur/recalibrate/confirm', { school_id: schoolId, spells });
  if (result.error) { showError(result.error); return; }
  const school = getSchool(schoolId);
  if (school) school.spells = result.spells;
  if (activeSchoolId === schoolId) renderDrawer();
  augurState.recalResult = null;
  renderAugurTab();
}

async function doAugurDiscover() {
  const desc = document.getElementById('discover-desc-input')?.value.trim() || '';
  if (!desc) return;
  augurState.discoverDesc   = desc;
  augurState.discoverStage  = 'loading';
  renderAugurTab();

  const result = await apiFetch('/api/augur/school', { description: desc });
  stopRecalFlavour();

  if (result.error || !result.name) {
    augurState.discoverStage = 'input';
    renderAugurTab();
    showError(result.error || 'The Augur could not conceive a school. Try again.');
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
  if (!name) { showError('A school must have a name.'); return; }

  const result = await apiFetch('/api/augur/school/confirm', {
    name, flavour, spells: augurState.discoverPreview.spells,
  });

  if (result.error || !result.school) {
    showError(result.error || 'Failed to create school.');
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

// Generate title on page load only if none exists yet
if (document.getElementById('header-ai-title')?.querySelector('.hstat-pending')) {
  refreshAITitle();
}

// Warm up the AI model on load and keep it alive with a heartbeat every 4 minutes
apiFetch('/api/augur/warmup', {});
setInterval(() => apiFetch('/api/augur/warmup', {}), 4 * 60 * 1000);

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (menuOpen) closeMenu();
  else if (!document.getElementById('drawer-overlay').classList.contains('hidden')) closeDrawer();
});
