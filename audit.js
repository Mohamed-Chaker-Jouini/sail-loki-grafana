// ── Config ────────────────────────────────────────────────────────────────────
const HISTORY_URL = '/history';
const HEALTH_URL  = '/health';
const PAGE_SIZES  = [25, 50, 100];

// ── State ─────────────────────────────────────────────────────────────────────
let allEntries  = [];
let filtered    = [];
let sortCol     = 'ts';
let sortDir     = -1;          // -1 = descending → newest first by default
let currentPage = 1;
let pageSize    = 25;
let openRows    = new Set();
let autoTimer   = null;
let isLoading   = false;
let maxHistory  = 1000;

// ── Robust new_zones parser ───────────────────────────────────────────────────
function parseNewZones(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return [];
  const s = raw.trim();
  if (!s || s === '[]') return [];
  try { return JSON.parse(s); } catch(_) {}
  try { return JSON.parse(s.replace(/'/g, '"')); } catch(_) {}
  return s.replace(/^\[|\]$/g,'').split(',')
          .map(t => t.trim().replace(/^['"]|['"]$/g,''))
          .filter(Boolean);
}

// ── Fetch & parse ─────────────────────────────────────────────────────────────
async function loadHistory(silent=false) {
  if (isLoading) return;
  isLoading = true;
  if (!silent) {
    document.getElementById('loading-indicator').style.display = 'block';
    document.getElementById('audit-body').innerHTML = '';
    document.getElementById('empty-state').style.display = 'none';
  }

  try {
    const [histRes, healthRes] = await Promise.all([
      fetch(HISTORY_URL + '?t=' + Date.now()),
      fetch(HEALTH_URL  + '?t=' + Date.now()),
    ]);

    if (!histRes.ok) throw new Error(`HTTP ${histRes.status}`);

    allEntries = await histRes.json();
    allEntries.forEach(e => { e._nz = parseNewZones(e.new_zones); });

    const health = await healthRes.json().catch(() => ({}));
    maxHistory = health.max_history || 1000;

    document.getElementById('err-banner').style.display = 'none';
    document.getElementById('last-refresh').textContent =
      'Updated: ' + new Date().toLocaleTimeString().toUpperCase();

    populateZoneFilter();
    applyFilters();
    checkHashNav();

  } catch(e) {
    document.getElementById('err-banner').style.display = 'block';
    document.getElementById('err-detail').textContent = e.message;
    showToast('Load failed: ' + e.message);
  } finally {
    isLoading = false;
    document.getElementById('loading-indicator').style.display = 'none';
  }
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function computeStats(src) {
  let drifts=0, added=0, removed=0, newZ=0;
  for (const e of src) {
    if (e.changed) drifts++;
    for (const z of Object.values(e.delta_map||{})) {
      added   += (z.to_add   ||[]).length;
      removed += (z.to_remove||[]).length;
    }
    newZ += (e._nz||[]).length;
  }
  const tot = src.length;
  const pct = n => tot ? ' (' + Math.round(n/tot*100) + '%)' : '';

  set('s-total', tot);
  set('s-total-sub', 'of ' + allEntries.length + ' total');
  set('s-drift', drifts);    set('s-drift-sub', pct(drifts)  + ' of shown');
  set('s-add',   added);     set('s-add-sub',   added   + ' IPs');
  set('s-rem',   removed);   set('s-rem-sub',   removed + ' IPs');
  set('s-zones', newZ);      set('s-zones-sub', 'discovered');
  set('s-ret',   allEntries.length + ' / ' + maxHistory);
}

function set(id, v) { const el=document.getElementById(id); if(el) el.textContent=String(v); }

// ── Zone filter ───────────────────────────────────────────────────────────────
function populateZoneFilter() {
  const zones = new Set();
  allEntries.forEach(e => Object.keys(e.delta_map||{}).forEach(z => zones.add(z)));
  const sel = document.getElementById('f-zone');
  const cur = sel.value;
  sel.innerHTML = '<option value="">All zones</option>';
  [...zones].sort().forEach(z => {
    const o = document.createElement('option');
    o.value = z; o.textContent = z;
    if (z === cur) o.selected = true;
    sel.appendChild(o);
  });
}

// ── Filters ───────────────────────────────────────────────────────────────────
function applyFilters() {
  const q    = document.getElementById('f-search').value.toLowerCase().trim();
  const type = document.getElementById('f-type').value;
  const zone = document.getElementById('f-zone').value;
  const from = document.getElementById('f-from').value;
  const to   = document.getElementById('f-to').value;

  filtered = allEntries.filter(e => {
    if (type==='drift' && !e.changed) return false;
    if (type==='clean' &&  e.changed) return false;
    if (zone && !Object.keys(e.delta_map||{}).includes(zone)) return false;
    if (from || to) {
      const d = new Date(e.ts*1000).toISOString().slice(0,10);
      if (from && d < from) return false;
      if (to   && d > to  ) return false;
    }
    if (q) {
      const hay = [
        e.run_id, e.vsrx_ip,
        new Date(e.ts*1000).toLocaleString(),
        JSON.stringify(e.delta_map),
        (e._nz||[]).join(' ')
      ].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  sortFiltered();
  currentPage = 1;
  computeStats(filtered);
  updateFilterCount(q, type, zone, from, to);
  render();
}

function updateFilterCount(q, type, zone, from, to) {
  const el = document.getElementById('filter-count');
  if (!el) return;
  const active = [q, type, zone, from, to].filter(Boolean).length;
  if (active > 0 && filtered.length !== allEntries.length) {
    el.textContent = filtered.length + ' of ' + allEntries.length + ' records';
    el.style.display = 'inline-block';
  } else {
    el.style.display = 'none';
  }
}

function clearFilters() {
  ['f-search','f-from','f-to'].forEach(id => document.getElementById(id).value='');
  document.getElementById('f-type').value='';
  document.getElementById('f-zone').value='';
  applyFilters();
}

// ── Sort ──────────────────────────────────────────────────────────────────────
function sortBy(col) {
  if (sortCol===col) sortDir*=-1; else { sortCol=col; sortDir=-1; }
  document.querySelectorAll('th[data-col]').forEach(th => {
    const isActive = th.dataset.col===col;
    th.classList.toggle('sorted', isActive);
    const sa = th.querySelector('.sa');
    if (sa) sa.textContent = isActive ? (sortDir===-1?'↓':'↑') : '↕';
  });
  sortFiltered();
  render();
}

function sortFiltered() {
  filtered.sort((a,b) => {
    let av, bv;
    if (sortCol==='status') { av=a.changed?1:0; bv=b.changed?1:0; }
    else { av=a[sortCol]??''; bv=b[sortCol]??''; }
    if (typeof av==='string') { av=av.toLowerCase(); bv=bv.toLowerCase(); }
    return av<bv ? sortDir : av>bv ? -sortDir : 0;
  });
}

// ── Render ────────────────────────────────────────────────────────────────────
function rowKey(e) {
  return 'r-' + String(e.ts||'0') + '-' + String(e.run_id||'x').replace(/[^a-z0-9]/gi,'-');
}

function render() {
  const tbody = document.getElementById('audit-body');
  const empty = document.getElementById('empty-state');
  tbody.innerHTML = '';

  if (!filtered.length) {
    empty.style.display = 'block';
    document.getElementById('empty-msg').textContent =
      allEntries.length===0
        ? 'No audit records yet. Waiting for the first Ansible run…'
        : 'No records match the current filters.';
    renderPag();
    return;
  }
  empty.style.display = 'none';

  const start = (currentPage-1)*pageSize;
  const page  = filtered.slice(start, start+pageSize);

  for (const e of page) {
    const rk     = rowKey(e);
    const ts     = e.ts ? new Date(e.ts*1000).toLocaleString() : '—';
    const dmap   = e.delta_map||{};
    const nz     = e._nz||[];
    const isOpen = openRows.has(rk);

    // Zones cell
    const zoneKeys = Object.keys(dmap);
    const zonesHtml = zoneKeys.length
      ? zoneKeys.map(z => `<span class="badge b-zone">${z}</span>`).join('')
      : '<span style="color:var(--muted)">—</span>';

    // Delta cell
    let deltaHtml = '';
    for (const [z,d] of Object.entries(dmap)) {
      const adds = d.to_add||[], rems=d.to_remove||[];
      if (!adds.length && !rems.length) continue;
      deltaHtml += `<div class="delta-block">
        <div class="delta-zname">${z}</div>
        <div class="chips">
          ${adds.map(ip=>`<span class="chip add">+${ip}</span>`).join('')}
          ${rems.map(ip=>`<span class="chip rem">−${ip}</span>`).join('')}
        </div></div>`;
    }
    if (nz.length) {
      deltaHtml += nz.map(z=>`<span class="badge b-new-zone" style="margin-top:4px;display:inline-block">NEW ZONE: ${z}</span>`).join(' ');
    }
    if (!deltaHtml && e.changed) {
      deltaHtml = '<span style="color:var(--muted);font-style:italic">New zone only — no IP deltas</span>';
    }

    const tr = document.createElement('tr');
    tr.className = 'data-row';
    tr.id = rk;
    tr.innerHTML = `
      <td style="white-space:nowrap;font-family:'Courier New',monospace;font-size:12px">${ts}</td>
      <td style="font-family:'Courier New',monospace;color:var(--hpe-green)" title="${esc(e.run_id||'')}">
        <a href="#${esc(rk)}" onclick="return false;" style="color:inherit;text-decoration:none">${esc((e.run_id||'—').slice(0,14))}</a>
      </td>
      <td style="font-family:'Courier New',monospace">${esc(e.vsrx_ip||'—')}</td>
      <td><span class="badge ${e.changed?'b-drift':'b-clean'}">${e.changed?'DRIFT':'CLEAN'}</span></td>
      <td>${zonesHtml}</td>
      <td>${deltaHtml || '<span style="color:var(--muted)">—</span>'}</td>
      <td>
        <button class="expand-btn" onclick="toggleDetail('${rk}')" id="btn-${rk}">${isOpen?'▲':'▼'}</button>
      </td>`;
    tbody.appendChild(tr);

    // Detail row
    const ipAdded   = Object.values(dmap).flatMap(d=>d.to_add||[]);
    const ipRemoved = Object.values(dmap).flatMap(d=>d.to_remove||[]);
    const det = document.createElement('tr');
    det.className = 'detail-row' + (isOpen?' open':'');
    det.id = 'det-'+rk;
    det.innerHTML = `
      <td colspan="7" class="detail-cell">
        <div class="detail-grid">
          <div class="di"><label>Full Run ID</label><span>${esc(e.run_id||'—')}</span></div>
          <div class="di"><label>Unix Timestamp</label><span>${e.ts||'—'}</span></div>
          <div class="di"><label>vSRX IP</label><span>${esc(e.vsrx_ip||'—')}</span></div>
          <div class="di"><label>Zones in Run</label><span>${zoneKeys.join(', ')||'none'}</span></div>
          <div class="di"><label>New Zones</label><span>${nz.join(', ')||'none'}</span></div>
          <div class="di"><label>IPs Added (${ipAdded.length})</label><span>${ipAdded.join(', ')||'none'}</span></div>
          <div class="di"><label>IPs Removed (${ipRemoved.length})</label><span>${ipRemoved.join(', ')||'none'}</span></div>
        </div>
        <div class="raw-section">
          <button class="raw-toggle" onclick="toggleRaw('raw-${rk}')">{ } View raw delta_map JSON</button>
          <pre class="raw-pre" id="raw-${rk}">${esc(JSON.stringify(dmap,null,2))}</pre>
        </div>
      </td>`;
    tbody.appendChild(det);
  }

  renderPag();
  const hash = location.hash.slice(1);
  if (hash) highlight(hash);
}

function toggleDetail(rk) {
  const det = document.getElementById('det-'+rk);
  const btn = document.getElementById('btn-'+rk);
  if (!det) return;
  const open = det.classList.toggle('open');
  if (open) openRows.add(rk); else openRows.delete(rk);
  if (btn) btn.textContent = open?'▲':'▼';
}

function toggleRaw(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('open');
}

function highlight(rk) {
  document.querySelectorAll('tr.data-row.hl').forEach(r=>r.classList.remove('hl'));
  const row = document.getElementById(rk);
  if (row) { row.classList.add('hl'); row.scrollIntoView({block:'center',behavior:'smooth'}); }
}

function checkHashNav() {
  const hash = location.hash.slice(1);
  if (!hash) return;
  const idx = filtered.findIndex(e => rowKey(e)===hash);
  if (idx===-1) return;
  const pg = Math.floor(idx/pageSize)+1;
  if (pg!==currentPage) { currentPage=pg; render(); }
  setTimeout(()=>highlight(hash), 80);
}

// ── Pagination ────────────────────────────────────────────────────────────────
function renderPag() {
  const total = Math.ceil(filtered.length/pageSize)||1;
  const info  = `Page ${currentPage} of ${total} — ${filtered.length} records`;
  const sizeBtns = PAGE_SIZES.map(n =>
    `<button onclick="setPageSize(${n})" class="${pageSize===n?'active':''}">${n}</button>`
  ).join('');
  const html = `
    <button onclick="goPage(1)"                ${currentPage<=1?'disabled':''}>«</button>
    <button onclick="goPage(${currentPage-1})" ${currentPage<=1?'disabled':''}>‹ Prev</button>
    <span class="pag-info">${info}</span>
    <button onclick="goPage(${currentPage+1})" ${currentPage>=total?'disabled':''}>Next ›</button>
    <button onclick="goPage(${total})"         ${currentPage>=total?'disabled':''}>»</button>
    <span class="page-size-wrap">Show: ${sizeBtns}</span>`;
  document.getElementById('pag-top').innerHTML    = html;
  document.getElementById('pag-bottom').innerHTML = html;
}

function goPage(p) {
  const total = Math.ceil(filtered.length/pageSize)||1;
  currentPage = Math.max(1, Math.min(p, total));
  render();
  window.scrollTo({top:0, behavior:'smooth'});
}

function setPageSize(n) {
  pageSize    = n;
  currentPage = 1;
  render();
}

// ── Auto-refresh ──────────────────────────────────────────────────────────────
function toggleAutoRefresh() {
  const btn   = document.getElementById('btn-auto');
  const badge = document.getElementById('auto-badge');
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
    btn.textContent     = 'Enable Auto-Refresh';
    badge.style.display = 'none';
  } else {
    autoTimer = setInterval(() => loadHistory(true), 30000);
    btn.textContent     = 'Disable Auto-Refresh';
    badge.style.display = 'inline-block';
    showToast('Auto-refresh every 30s enabled');
  }
}

// ── CSV Export ────────────────────────────────────────────────────────────────
function exportCSV() {
  const cols = ['timestamp','run_id','vsrx_ip','status','zones','ips_added','ips_removed','new_zones'];
  const rows = [cols.join(',')];
  for (const e of filtered) {
    const dmap  = e.delta_map||{};
    const added = Object.values(dmap).flatMap(d=>d.to_add   ||[]).join(';');
    const remd  = Object.values(dmap).flatMap(d=>d.to_remove||[]).join(';');
    rows.push([
      new Date((e.ts||0)*1000).toISOString(),
      e.run_id||'', e.vsrx_ip||'',
      e.changed?'DRIFT':'CLEAN',
      Object.keys(dmap).join(';'),
      added, remd,
      (e._nz||[]).join(';'),
    ].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(','));
  }
  const blob = new Blob([rows.join('\r\n')], {type:'text/csv'});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `sail-audit-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Exported ' + filtered.length + ' records');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

// ── Init ──────────────────────────────────────────────────────────────────────
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('hashchange', checkHashNav);

  // Set initial sort arrow — ts descending (newest first)
  const tsth = document.querySelector('th[data-col="ts"]');
  if (tsth) {
    tsth.classList.add('sorted');
    tsth.querySelector('.sa').textContent = '↓';
  }

  loadHistory();
}

// ── Test exports ──────────────────────────────────────────────────────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseNewZones, rowKey, esc, computeStats, applyFilters,
    loadHistory, sortBy, toggleAutoRefresh,
    setAllEntries: (entries) => { allEntries = entries; },
    getFiltered: () => filtered,
  };
}