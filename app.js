import { requirementsAt, planPart, planPerSite, planMainFirst, movesCSV, haversineKm, round } from './src/rebalance.js';

const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const STORE = 'toolhound-rebalance-v1';
const saved = JSON.parse(localStorage.getItem(STORE) || '{}');
let net = null, results = null, model = null;
const state = { alpha: saved.alpha ?? 0.05, rentWeeks: saved.rentWeeks ?? 10, docs: saved.docs || [], filter: '', sel: null };
const persist = () => localStorage.setItem(STORE, JSON.stringify({ alpha: state.alpha, rentWeeks: state.rentWeeks, docs: state.docs.slice(0, 60) }));
const money = (x) => '$' + Math.round(x).toLocaleString('en-CA');
const weekLabel = (w) => { const d = new Date(Date.UTC(2025, 10, 10 + 7 * w)); return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' }); };
const icons = () => window.lucide && window.lucide.createIcons();
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2600); }

function compute() {
  const rq = requirementsAt(net, net.now, state.alpha, net.horizon);
  const rates = results.rates;
  const opt = [], ps = [], mf = [];
  net.parts.forEach((p, k) => {
    opt.push(planPart(p, net.locs, rq.required[k], net.onHand[k], rates, state.rentWeeks));
    ps.push(planPerSite(p, net.locs, rq.required[k], net.onHand[k], rates, state.rentWeeks));
    mf.push(planMainFirst(p, net.locs, rq.required[k], net.onHand[k], rates, state.rentWeeks));
  });
  const sum = (a) => a.reduce((s, x) => s + x.cost, 0);
  const count = (a, kind) => a.reduce((s, p) => s + p.moves.filter((m) => m.kind === kind).reduce((t, m) => t + m.qty, 0), 0);
  model = { rq, opt, ps, mf, totals: { opt: sum(opt), ps: sum(ps), mf: sum(mf) }, units: { transfer: count(opt, 'transfer'), buy: count(opt, 'buy'), rent: count(opt, 'rent') }, deficit: opt.reduce((s, p) => s + p.deficit, 0) };
}

function route() {
  const h = location.hash || '#/purchasing/rebalance';
  const parts = h.replace(/^#\//, '').split('/');
  document.querySelectorAll('.m-sub a').forEach((a) => a.classList.toggle('active', a.dataset.nav === parts[1] || (parts[1] === 'rebalance' && a.dataset.nav === 'rebalance')));
  if (!net) return;
  if (parts[0] !== 'purchasing' || !['rebalance', 'transfers'].includes(parts[1])) return renderEmpty(parts[1] || parts[0]);
  if (parts[1] === 'transfers') return renderDocs();
  if (parts[2] === 'part' && parts[3]) return renderPart(decodeURIComponent(parts[3]));
  renderPlan(parts[2] || 'summary');
}
window.addEventListener('hashchange', () => { route(); icons(); });

function win(title, crumb, body, toolbar = true) {
  return `<div class="win"><div class="win-h">${title}${crumb ? `<span class="crumb">· ${crumb}</span>` : ''}</div>
  ${toolbar ? `<div class="toolbar"><button class="tb" id="tbRefresh" title="Refresh" aria-label="Refresh"><i data-lucide="refresh-cw"></i></button><button class="tb" title="Copy" aria-label="Copy"><i data-lucide="copy"></i></button><span class="sep"></span><button class="tb" id="tbSave" title="Save" aria-label="Save settings"><i data-lucide="save"></i></button><button class="tb" id="tbExport" title="Export to Excel" aria-label="Export to Excel"><i data-lucide="sheet"></i></button><button class="tb" id="tbPrint" title="Print" aria-label="Print"><i data-lucide="printer"></i></button><span class="sep"></span><button class="tb" id="tbSearch" title="Search" aria-label="Search"><i data-lucide="search"></i></button></div>` : ''}${body}</div>`;
}

function renderEmpty(which) {
  view.innerHTML = win(which ? which[0].toUpperCase() + which.slice(1) : 'ToolHound', '', `<div class="empty"><i data-lucide="lock"></i><p>This concept demo only rebuilds <b>Purchasing → Rebalance Network</b> and the transfer requests it creates.</p><p><a class="btn primary" href="#/purchasing/rebalance">Open Rebalance Network</a></p></div>`, false);
  icons();
}

function form() {
  return `<div class="form">
    <div class="f"><label>Plan Week</label><div class="ro">${weekLabel(net.now)} – ${weekLabel(net.now + net.horizon - 1)} (${net.horizon} wks)</div></div>
    <div class="f"><label for="alpha">Service Target</label><select id="alpha">${[0.1, 0.05, 0.02].map((a) => `<option value="${a}" ${a === state.alpha ? 'selected' : ''}>${Math.round((1 - a) * 100)}% per part / location</option>`).join('')}</select></div>
    <div class="f"><label for="rent">Rental Horizon</label><select id="rent">${[4, 8, 10, 16].map((w) => `<option value="${w}" ${w === state.rentWeeks ? 'selected' : ''}>${w} weeks</option>`).join('')}</select></div>
    <div class="f"><label>Stocking Points</label><div class="ro">${net.locs.length} (1 warehouse, ${net.locs.length - 1} job sites)</div></div>
    <div class="f"><label>Usage Basis</label><div class="ro">Peak concurrent checkouts, 52 wks</div></div>
    <div class="f"><label>Headcount Plan</label><div class="ro">From job schedules</div></div>
    <div class="f"><label>Include Rentals?</label><div><input type="checkbox" class="chk" checked disabled aria-label="Include rentals" /></div></div>
    <div class="f"><label>Serialized Only?</label><div><input type="checkbox" class="chk" checked disabled aria-label="Serialized only" /></div></div>
  </div>`;
}
function tabs(active) {
  const t = [['summary', 'Summary', 1], ['lines', 'Transfers & Orders', 2], ['locations', 'By Location', 3], ['backtest', 'Backtest', 4]];
  return `<div class="tabs" role="tablist">${t.map(([id, l]) => `<a role="tab" aria-selected="${id === active}" class="${id === active ? 'active' : ''}" href="#/purchasing/rebalance/${id}">${l}</a>`).join('')}</div>`;
}

function renderPlan(tab) {
  const m = model;
  const saveVsPs = 100 * (1 - m.totals.opt / m.totals.ps), saveVsMf = 100 * (1 - m.totals.opt / m.totals.mf);
  let body = '';
  if (tab === 'summary') body = summaryTab(saveVsPs, saveVsMf);
  else if (tab === 'lines') body = linesTab();
  else if (tab === 'locations') body = locationsTab();
  else if (tab === 'backtest') body = backtestTab();
  else body = `<div class="err">Unknown tab "${tab}". <a href="#/purchasing/rebalance">Back to the plan</a></div>`;
  view.innerHTML = win('Rebalance Network', 'Purchasing', `${form()}${tabs(tab)}<div class="pad">${body}</div>
    <div class="dlg-f" style="justify-content:space-between"><span style="color:#666">Optimal plan solved as a min-cost flow per part number · ${net.parts.length} parts · ${m.deficit} units short</span><span style="display:flex;gap:8px"><button class="btn" id="expBtn"><i data-lucide="sheet"></i>Export</button><button class="btn primary" id="procBtn" ${m.deficit ? '' : 'disabled'}><i data-lucide="check"></i>Process</button></span></div>`);
  bind(tab);
  icons();
}

function summaryTab(saveVsPs, saveVsMf) {
  const m = model;
  const docsFromPlan = state.docs.filter((d) => d.week === net.now);
  return `${docsFromPlan.length ? `<div class="note ok"><i data-lucide="circle-check"></i><div><b>Processed:</b> ${docsFromPlan.length} documents created for this plan week (${docsFromPlan.filter((d) => d.type === 'Transfer Request').length} transfer requests). <a href="#/purchasing/transfers">View transfer requests</a></div></div>`
    : `<div class="note"><i data-lucide="lightbulb"></i><div>Moving idle tools between your stocking points before buying or renting covers the next ${net.horizon} weeks at a ${Math.round((1 - state.alpha) * 100)}% service target for <b>${money(m.totals.opt)}</b>, versus ${money(m.totals.ps)} if each location reorders on its own (<b>${saveVsPs.toFixed(1)}% less</b>) and ${money(m.totals.mf)} transferring from the main warehouse first (${saveVsMf.toFixed(1)}% less).</div></div>`}
  <div class="sum">
    <div class="card"><div class="h">Units Short (next ${net.horizon} wks)</div><div class="b"><div class="v">${m.deficit}</div><div class="s">across ${new Set(m.opt.flatMap((p) => p.moves.map((x) => x.to))).size} locations</div></div></div>
    <div class="card"><div class="h">Covered by Transfer</div><div class="b"><div class="v good">${m.units.transfer}</div><div class="s">idle tools moved between cribs</div></div></div>
    <div class="card"><div class="h">Buy / Rent</div><div class="b"><div class="v">${m.units.buy} / ${m.units.rent}</div><div class="s">only where moving costs more</div></div></div>
    <div class="card"><div class="h">Plan Cost</div><div class="b"><div class="v">${money(m.totals.opt)}</div><div class="s good">−${money(m.totals.ps - m.totals.opt)} vs per-location reorder</div></div></div>
    <div class="card"><div class="h">Forecast Coverage (backtest)</div><div class="b"><div class="v">${(100 * results.coverage.overall).toFixed(1)}%</div><div class="s">of part/location 4-wk peaks covered, target 95%</div></div></div>
  </div>
  <div class="cols">
    <div><div class="map">${mapSVG()}</div><div class="legend"><span><i style="background:#1a5fb4"></i>Transfer (line width = units)</span><span><i style="background:#dc0707"></i>Short after transfers (buy/rent)</span><span><i style="background:#2e8b3e"></i>Surplus remaining</span></div></div>
    <div><table class="grid"><thead><tr><th>Fulfilment strategy</th><th class="num">Transfers</th><th class="num">Buy</th><th class="num">Rent</th><th class="num">Cost</th></tr></thead><tbody>
      ${[['Optimal network plan (proposed)', m.opt, m.totals.opt], ['Each location reorders (Reorder Worksheet)', m.ps, m.totals.ps], ['Main warehouse first, then buy/rent', m.mf, m.totals.mf]].map(([n, pl, c], i) => `<tr${i === 0 ? ' class="sel"' : ''}><td>${i === 0 ? '<b>' + n + '</b>' : n}</td>${['transfer', 'buy', 'rent'].map((k) => `<td class="num">${pl.reduce((s, p) => s + p.moves.filter((x) => x.kind === k).reduce((t, x) => t + x.qty, 0), 0)}</td>`).join('')}<td class="num">${money(c)}</td></tr>`).join('')}
    </tbody></table>
    <table class="grid mt"><thead><tr><th>Top savings by part number</th><th class="num">Short</th><th class="num">Per-location</th><th class="num">Optimal</th></tr></thead><tbody>
      ${net.parts.map((p, k) => ({ p, k, d: m.ps[k].cost - m.opt[k].cost })).sort((a, b) => b.d - a.d).slice(0, 8).map(({ p, k }) => `<tr data-part="${p.id}" tabindex="0"><td>${p.id} · ${p.name.slice(0, 34)}${p.name.length > 34 ? '…' : ''}</td><td class="num">${m.opt[k].deficit}</td><td class="num">${money(m.ps[k].cost)}</td><td class="num">${money(m.opt[k].cost)}</td></tr>`).join('')}
    </tbody></table></div>
  </div>`;
}

function mapSVG() {
  const W = 640, H = 470, lat0 = 48.8, lat1 = 57.4, lon0 = -120.3, lon1 = -109.4;
  const ky = (H - 30) / (lat1 - lat0), kx = ky * Math.cos((54 * Math.PI) / 180);
  const x0 = (W - kx * (lon1 - lon0)) / 2;
  const X = (lon) => x0 + (lon - lon0) * kx;
  const Y = (lat) => 15 + (lat1 - lat) * ky;
  const border = [[49, -110.005], [60, -110.005], [60, -120], [53.8, -120], [52.8, -118.6], [51.4, -116.6], [50.6, -115.3], [49, -114.06]];
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Alberta stocking locations and planned transfers"><polygon points="${border.map(([a, o]) => `${X(o)},${Y(a)}`).join(' ')}" fill="#fff" stroke="#bbb" stroke-width="1.2"/>`;
  s += `<defs><marker id="ar" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto"><path d="M0,0L10,5L0,10z" fill="#1a5fb4"/></marker></defs><text x="${W - 12}" y="${H - 10}" text-anchor="end" font-family="Verdana" font-size="10" fill="#999">Alberta · north of 57.4° not shown</text>`;
  const flows = {};
  model.opt.forEach((p) => p.moves.filter((m) => m.kind === 'transfer').forEach((m) => { const key = m.from + '-' + m.to; flows[key] = (flows[key] || 0) + m.qty; }));
  Object.entries(flows).forEach(([key, q]) => {
    const [a, b] = key.split('-').map(Number); const A = net.locs[a], B = net.locs[b];
    s += `<line x1="${X(A.lon)}" y1="${Y(A.lat)}" x2="${X(B.lon)}" y2="${Y(B.lat)}" stroke="#1a5fb4" stroke-opacity=".75" stroke-width="${Math.min(6, 1 + q / 5)}" marker-end="url(#ar)"><title>${A.id} → ${B.id}: ${q} units (${Math.round(haversineKm(A, B))} km)</title></line>`;
  });
  net.locs.forEach((l, i) => {
    let short = 0, sur = 0;
    model.opt.forEach((p, k) => {
      let after = net.onHand[k][i]; p.moves.forEach((m) => { if (m.to === i && m.kind === 'transfer') after += m.qty; if (m.from === i) after -= m.qty; });
      const d = model.rq.required[k][i] - after; if (d > 0) short += d; else sur += -d;
    });
    const col = short > 0 ? '#dc0707' : '#2e8b3e';
    s += `<circle cx="${X(l.lon)}" cy="${Y(l.lat)}" r="${l.kind === 'Warehouse' ? 8 : 6}" fill="${col}" stroke="#fff" stroke-width="2"><title>${l.name}: ${short} short after transfers, ${sur} surplus</title></circle>`;
    const left = l.id === 'STA-WH' || l.id === 'GPR-05';
    s += `<text x="${X(l.lon) + (left ? -10 : 10)}" y="${Y(l.lat) + (l.id === 'STA-WH' ? -6 : 4)}" text-anchor="${left ? 'end' : 'start'}" font-family="Verdana" font-size="10.5" fill="#222" paint-order="stroke" stroke="#fff" stroke-width="3">${l.id}${short ? ` (${short} short)` : ''}</text>`;
  });
  return s + '</svg>';
}

function linesTab() {
  const rows = [];
  model.opt.forEach((p, k) => p.moves.forEach((m) => rows.push({ part: net.parts[k], m })));
  const f = state.filter.toLowerCase();
  const shown = rows.filter((r) => !f || (r.part.id + ' ' + r.part.name).toLowerCase().includes(f));
  return `<div class="filter"><label for="flt">Filter</label><input id="flt" placeholder="Part number or description" value="${state.filter}" /><span style="color:#666">${shown.length} of ${rows.length} lines</span></div>
  <div class="scroll"><table class="grid"><thead><tr><th>Part No</th><th>Description</th><th>Action</th><th>From Location</th><th>To Location</th><th class="num">Qty</th><th class="num">Unit Cost</th><th class="num">Line Cost</th></tr></thead><tbody>
  ${shown.map(({ part, m }) => `<tr data-part="${part.id}" tabindex="0"><td>${part.id}</td><td>${part.name}</td><td><span class="tag ${m.kind}">${m.kind === 'transfer' ? 'Transfer Request' : m.kind === 'buy' ? 'Purchase Order' : 'Rental'}</span></td><td>${m.from != null ? net.locs[m.from].id : '–'}</td><td>${net.locs[m.to].id}</td><td class="num">${m.qty}</td><td class="num">${money(m.unitCost)}</td><td class="num">${money(m.qty * m.unitCost)}</td></tr>`).join('') || '<tr><td colspan="8" style="color:#666">No lines match this filter.</td></tr>'}
  </tbody><tfoot><tr><td colspan="7">Total</td><td class="num">${money(shown.reduce((s, r) => s + r.m.qty * r.m.unitCost, 0))}</td></tr></tfoot></table></div>`;
}

function locationsTab() {
  return `<table class="grid"><thead><tr><th>Location ID</th><th>Name</th><th>Type</th><th class="num">Headcount now → peak</th><th class="num">On Hand</th><th class="num">Required (${Math.round((1 - state.alpha) * 100)}%)</th><th class="num">Ships Out</th><th class="num">Receives</th><th class="num">Buy/Rent</th></tr></thead><tbody>
  ${net.locs.map((l, i) => {
    let oh = 0, rq = 0, out = 0, inn = 0, br = 0;
    net.parts.forEach((p, k) => { oh += net.onHand[k][i]; rq += model.rq.required[k][i]; model.opt[k].moves.forEach((m) => { if (m.from === i) out += m.qty; if (m.to === i) { if (m.kind === 'transfer') inn += m.qty; else br += m.qty; } }); });
    const hc = net.headcount[i]; let pk = 0; for (let w = net.now; w < net.now + net.horizon; w++) pk = Math.max(pk, hc[w]);
    return `<tr><td>${l.id}</td><td>${l.name}</td><td>${l.kind}</td><td class="num">${hc[net.now - 1]} → ${pk}</td><td class="num">${oh}</td><td class="num">${rq}</td><td class="num">${out ? `<span class="tag sur">${out}</span>` : '–'}</td><td class="num">${inn ? `<span class="tag transfer">${inn}</span>` : '–'}</td><td class="num">${br ? `<span class="tag def">${br}</span>` : '–'}</td></tr>`;
  }).join('')}</tbody></table>`;
}

function backtestTab() {
  const bc = results.coverage.byCutoff;
  const W = 900, H = 200, pl = 40, pb = 26;
  const X = (i) => pl + (i / (bc.length - 1)) * (W - pl - 10);
  const Y = (v) => 8 + (H - 8 - pb) * (1 - (v - 0.8) / 0.2);
  let s = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;background:#fff;border:1px solid #c8c8c8" role="img" aria-label="Backtest coverage">`;
  [0.8, 0.85, 0.9, 0.95, 1].forEach((v) => { s += `<line x1="${pl}" x2="${W - 10}" y1="${Y(v)}" y2="${Y(v)}" stroke="${v === 0.95 ? '#dc0707' : '#e3e3e3'}" ${v === 0.95 ? 'stroke-dasharray="4 3"' : ''}/><text x="${pl - 6}" y="${Y(v) + 3}" font-size="10" text-anchor="end" font-family="Verdana" fill="#666">${Math.round(v * 100)}%</text>`; });
  s += `<polyline fill="none" stroke="#1a5fb4" stroke-width="2" points="${bc.map((c, i) => `${X(i)},${Y(c.coverage)}`).join(' ')}"/>`;
  bc.forEach((c, i) => { if (i % 3 === 0) s += `<text x="${X(i)}" y="${H - 8}" font-size="10" text-anchor="middle" font-family="Verdana" fill="#666">${weekLabel(c.week)}</text>`; s += `<circle cx="${X(i)}" cy="${Y(c.coverage)}" r="3" fill="#1a5fb4"><title>${weekLabel(c.week)}: ${(100 * c.coverage).toFixed(1)}%</title></circle>`; });
  s += '</svg>';
  return `<div class="note"><i data-lucide="info"></i><div>Each week from ${weekLabel(bc[0].week)} on, requirements were re-computed using only data available that week and compared with the actual 4-week peak of concurrent checkouts at every part/location. Overall <b>${(100 * results.coverage.overall).toFixed(1)}%</b> of ${results.coverage.n.toLocaleString()} windows were covered (target 95%; split-conformal guarantees at least the target on average when weeks are exchangeable).</div></div>${s}
  <div class="legend"><span><i style="background:#1a5fb4"></i>Share of part/location windows where actual peak ≤ required</span><span><i style="background:#dc0707"></i>95% target</span></div>`;
}

function renderPart(id) {
  const k = net.parts.findIndex((p) => p.id === id);
  if (k < 0) { view.innerHTML = win('Rebalance Network', 'Part', `<div class="pad"><div class="err">Part number <b>${id}</b> is not in this plan. <a href="#/purchasing/rebalance">Back to the plan</a></div></div>`, false); icons(); return; }
  const p = net.parts[k], pl = model.opt[k];
  const rows = net.locs.map((l, i) => {
    const pk = net.peaks[k][i]; const spark = pk.slice(-20);
    const mx = Math.max(1, ...spark, model.rq.required[k][i]);
    const sv = `<svg class="spark" width="120" height="22">${spark.map((v, j) => `<rect x="${j * 6}" y="${22 - (v / mx) * 20}" width="4" height="${(v / mx) * 20}" fill="#9db7d6"/>`).join('')}<line x1="0" x2="120" y1="${22 - (model.rq.required[k][i] / mx) * 20}" y2="${22 - (model.rq.required[k][i] / mx) * 20}" stroke="#dc0707" stroke-dasharray="3 2"/></svg>`;
    const d = model.rq.required[k][i] - net.onHand[k][i];
    const act = pl.moves.filter((m) => m.to === i || m.from === i).map((m) => m.from === i ? `<span class="tag sur">→ ${net.locs[m.to].id} ×${m.qty}</span>` : `<span class="tag ${m.kind}">${m.kind === 'transfer' ? '← ' + net.locs[m.from].id : m.kind} ×${m.qty}</span>`).join(' ');
    return `<tr><td>${l.id}</td><td>${l.name}</td><td>${sv}</td><td class="num">${model.rq.forecast[k][i].toFixed(1)}</td><td class="num">${model.rq.required[k][i]}</td><td class="num">${net.onHand[k][i]}</td><td class="num">${d > 0 ? `<span class="tag def">−${d}</span>` : d < 0 ? `<span class="tag sur">+${-d}</span>` : '<span class="tag ok">0</span>'}</td><td>${act || '–'}</td></tr>`;
  }).join('');
  view.innerHTML = win('Part Number ' + p.id, p.name, `<div class="form" style="grid-template-columns:repeat(3,minmax(0,1fr))">
    <div class="f"><label>Description</label><div class="ro">${p.name}</div></div><div class="f"><label>Unit Cost</label><div class="ro">${money(p.price)}</div></div><div class="f"><label>Weekly Rental</label><div class="ro">${money(p.rentWeek)}</div></div>
    <div class="f"><label>Freight Class</label><div class="ro">${p.freightClass}</div></div><div class="f"><label>Units Short</label><div class="ro">${pl.deficit}</div></div><div class="f"><label>Plan Cost</label><div class="ro">${money(pl.cost)} (per-location ${money(model.ps[k].cost)})</div></div></div>
    <div class="tabs"><a class="active" href="#/purchasing/rebalance/part/${p.id}">Stocking Points</a><a href="#/purchasing/rebalance/lines">All Plan Lines</a></div>
    <div class="pad"><table class="grid"><thead><tr><th>Location</th><th>Name</th><th>Weekly peak out (20 wks) · required</th><th class="num">Forecast</th><th class="num">Required</th><th class="num">On Hand</th><th class="num">Short/Surplus</th><th>Plan</th></tr></thead><tbody>${rows}</tbody></table>
    <p style="color:#666;margin:10px 0 0">Required = forecast + conformal margin q·√(forecast+1); q = ${model.rq.q[k].toFixed(3)} for this part, calibrated on its own ${(model.rq.nCal / net.parts.length).toLocaleString()} past forecast windows (8 locations × ${model.rq.nCal / net.parts.length / 8} weeks). <a href="#/purchasing/rebalance">Back to the plan</a></p></div>`, false);
  icons();
}

function renderDocs() {
  const docs = state.docs;
  view.innerHTML = win('Transfer Requests', 'Purchasing', `<div class="pad">${docs.length ? `<table class="grid"><thead><tr><th>Document</th><th>Type</th><th>From</th><th>To</th><th class="num">Lines</th><th class="num">Units</th><th>Created</th><th>Status</th></tr></thead><tbody>${docs.map((d) => `<tr><td>${d.no}</td><td>${d.type}</td><td>${d.from || '–'}</td><td>${d.to}</td><td class="num">${d.lines}</td><td class="num">${d.units}</td><td>${d.at}</td><td><span class="tag ok">Open</span></td></tr>`).join('')}</tbody></table><p><button class="btn" id="clearDocs"><i data-lucide="trash-2"></i>Delete demo documents</button></p>` : `<div class="empty"><i data-lucide="inbox"></i><p>No transfer requests yet. Process a plan from <a href="#/purchasing/rebalance">Rebalance Network</a>.</p></div>`}</div>`, false);
  const c = $('#clearDocs'); if (c) c.onclick = () => { state.docs = []; persist(); renderDocs(); icons(); toast('Demo documents deleted'); };
  icons();
}

function bind(tab) {
  $('#alpha').onchange = (e) => { state.alpha = +e.target.value; persist(); compute(); renderPlan(tab); };
  $('#rent').onchange = (e) => { state.rentWeeks = +e.target.value; persist(); compute(); renderPlan(tab); };
  $('#procBtn').onclick = openProcess;
  $('#expBtn').onclick = exportCSV; $('#tbExport').onclick = exportCSV;
  $('#tbRefresh').onclick = () => { compute(); renderPlan(tab); toast('Plan recalculated'); };
  $('#tbSave').onclick = () => { persist(); toast('Settings saved'); };
  $('#tbPrint').onclick = () => window.print();
  $('#tbSearch').onclick = () => { location.hash = '#/purchasing/rebalance/lines'; setTimeout(() => $('#flt')?.focus(), 50); };
  const flt = $('#flt');
  if (flt) flt.oninput = (e) => { state.filter = e.target.value; const pos = e.target.selectionStart; renderPlan('lines'); const n = $('#flt'); n.focus(); n.setSelectionRange(pos, pos); };
  document.querySelectorAll('tr[data-part]').forEach((tr) => { tr.onclick = () => (location.hash = `#/purchasing/rebalance/part/${tr.dataset.part}`); tr.onkeydown = (e) => { if (e.key === 'Enter') tr.onclick(); }; });
}

function exportCSV() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([movesCSV(net.parts, net.locs, model.opt)], { type: 'text/csv' }));
  a.download = `rebalance-plan-${weekLabel(net.now).replace(' ', '')}.csv`; a.click();
  toast('Exported plan lines (CSV)');
}

function openProcess() {
  const m = model;
  const lanes = {}; let po = 0, rent = 0;
  m.opt.forEach((p) => p.moves.forEach((x) => { if (x.kind === 'transfer') { const key = net.locs[x.from].id + '>' + net.locs[x.to].id; lanes[key] = lanes[key] || { lines: 0, units: 0 }; lanes[key].lines++; lanes[key].units += x.qty; } else if (x.kind === 'buy') po += x.qty; else rent += x.qty; }));
  $('#procBody').innerHTML = `<p>This creates the documents below for plan week ${weekLabel(net.now)}. Nothing ships until each transfer request is approved.</p>
  <table class="grid"><thead><tr><th>Document type</th><th class="num">Documents</th><th class="num">Units</th></tr></thead><tbody>
  <tr><td>Transfer Request (one per lane)</td><td class="num">${Object.keys(lanes).length}</td><td class="num">${m.units.transfer}</td></tr>
  <tr><td>Purchase Order</td><td class="num">${po ? 1 : 0}</td><td class="num">${po}</td></tr>
  <tr><td>Rental Order</td><td class="num">${rent ? 1 : 0}</td><td class="num">${rent}</td></tr></tbody></table>`;
  const d = $('#procDlg'); d.showModal();
  d.onclose = () => {
    if (d.returnValue !== 'ok') return;
    const at = new Date().toLocaleString('en-CA');
    let n = 1240 + state.docs.length;
    const docs = Object.entries(lanes).map(([key, v]) => { const [f, t] = key.split('>'); return { no: 'TR-' + n++, type: 'Transfer Request', from: f, to: t, lines: v.lines, units: v.units, at, week: net.now }; });
    if (po) docs.push({ no: 'PO-' + n++, type: 'Purchase Order', to: 'Multiple', lines: m.opt.filter((p) => p.moves.some((x) => x.kind === 'buy')).length, units: po, at, week: net.now });
    if (rent) docs.push({ no: 'RO-' + n++, type: 'Rental Order', to: 'Multiple', lines: m.opt.filter((p) => p.moves.some((x) => x.kind === 'rent')).length, units: rent, at, week: net.now });
    state.docs = [...docs, ...state.docs]; persist();
    toast(`${docs.length} documents created`); location.hash = '#/purchasing/transfers';
  };
}

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey) return;
  const map = { 1: 'summary', 2: 'lines', 3: 'locations', 4: 'backtest' };
  if (map[e.key]) { location.hash = '#/purchasing/rebalance/' + map[e.key]; return; }
  if (e.key === '?') return $('#keysDlg').showModal();
  if (e.key === '/') { e.preventDefault(); location.hash = '#/purchasing/rebalance/lines'; setTimeout(() => $('#flt')?.focus(), 50); return; }
  if (e.key === 'Escape') { location.hash = '#/purchasing/rebalance'; return; }
  if (e.key === 'p' || e.key === 'P') { if (model.deficit) openProcess(); }
  if (e.key === 'e' || e.key === 'E') exportCSV();
});
$('#helpBtn').onclick = () => $('#keysDlg').showModal();

(async function boot() {
  try {
    const [a, b] = await Promise.all([fetch('data/network.json'), fetch('data/results.json')]);
    if (!a.ok || !b.ok) throw new Error(`HTTP ${a.status}/${b.status}`);
    net = await a.json(); results = await b.json();
    $('#spSel').innerHTML = '<option>All Stocking Locations</option>' + net.locs.map((l) => `<option>${l.id} · ${l.name}</option>`).join('');
    compute();
    if (!location.hash) history.replaceState(null, '', '#/purchasing/rebalance');
    route();
  } catch (err) {
    view.innerHTML = `<div class="err"><b>Could not load ToolHound data.</b> ${err.message || err}. <button class="btn" onclick="location.reload()">Retry</button></div>`;
  }
  icons();
})();
