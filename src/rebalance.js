// Rebalance before you buy: conformal tool requirements + exact min-cost transfer/buy/rent plans.
// Pure functions, no dependencies; same module in the browser and in Node.

export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function haversineKm(a, b) {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Point forecast of next-4-week peak concurrent checkouts for one (part, location):
// recent peak-per-worker rate (last 8 weeks, robust mean) x planned headcount over the horizon.
export function pointForecast(peaks, headcount, t, horizon) {
  let num = 0, den = 0;
  for (let w = Math.max(0, t - 8); w < t; w++) { num += peaks[w]; den += headcount[w]; }
  const rate = den > 0 ? num / den : 0;
  let hMax = 0;
  for (let w = t; w < t + horizon; w++) hMax = Math.max(hMax, headcount[w] ?? headcount[headcount.length - 1]);
  return rate * hMax;
}

// Split conformal: from calibration pairs (forecast f, actual y), nonconformity s = y - f scaled by sqrt(f+1)
// (counts are roughly Poisson-like). Quantile at level ceil((n+1)(1-alpha))/n gives >= 1-alpha marginal coverage.
export function conformalQuantile(scores, alpha) {
  const s = [...scores].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return Infinity;
  const k = Math.ceil((n + 1) * (1 - alpha));
  return k > n ? Infinity : s[k - 1];
}
export const score = (f, y) => (y - f) / Math.sqrt(f + 1);
export const requirement = (f, q) => Math.max(0, Math.ceil(f + q * Math.sqrt(f + 1) - 1e-9));

// Exact min-cost flow (successive shortest paths with Bellman-Ford; graphs here are small).
export class MinCostFlow {
  constructor(n) { this.n = n; this.g = Array.from({ length: n }, () => []); }
  add(u, v, cap, cost) {
    const a = { v, cap, cost, rev: this.g[v].length, flow: 0 };
    const b = { v: u, cap: 0, cost: -cost, rev: this.g[u].length, flow: 0, back: true };
    this.g[u].push(a); this.g[v].push(b); return a;
  }
  solve(s, t, maxFlow = Infinity) {
    let flow = 0, cost = 0;
    while (flow < maxFlow) {
      const dist = new Array(this.n).fill(Infinity), inq = new Array(this.n).fill(false), prev = new Array(this.n).fill(null);
      dist[s] = 0; const q = [s]; inq[s] = true;
      while (q.length) {
        const u = q.shift(); inq[u] = false;
        for (const e of this.g[u]) if (e.cap > 0 && dist[u] + e.cost < dist[e.v] - 1e-9) {
          dist[e.v] = dist[u] + e.cost; prev[e.v] = { u, e };
          if (!inq[e.v]) { inq[e.v] = true; q.push(e.v); }
        }
      }
      if (dist[t] === Infinity) break;
      let push = maxFlow - flow;
      for (let v = t; v !== s; v = prev[v].u) push = Math.min(push, prev[v].e.cap);
      for (let v = t; v !== s; v = prev[v].u) {
        const e = prev[v].e; e.cap -= push; e.flow += push;
        const r = this.g[e.v][e.rev]; r.cap += push; r.flow -= push;
      }
      flow += push; cost += push * dist[t];
    }
    return { flow, cost };
  }
}

// Cost of moving one unit of `part` from location a to b.
export function transferCost(part, a, b, rates) {
  const km = haversineKm(a, b);
  return rates.handling + km * rates.perKm * part.freightClass;
}

// Plan for one part. need[i] = required - onHand (positive = deficit), sources may only give
// their surplus. Options per deficit unit: transfer from a surplus location, buy new, or rent for the horizon.
export function planPart(part, locs, required, onHand, rates, horizonWeeks) {
  const L = locs.length;
  const S = 0, T = 2 * L + 3, BUY = 2 * L + 1, RENT = 2 * L + 2;
  const mcf = new MinCostFlow(2 * L + 4);
  let deficit = 0;
  const outArcs = [];
  for (let i = 0; i < L; i++) {
    const surplus = onHand[i] - required[i];
    if (surplus > 0) mcf.add(S, 1 + i, surplus, 0);
    const d = required[i] - onHand[i];
    if (d > 0) { mcf.add(1 + L + i, T, d, 0); deficit += d; }
  }
  mcf.add(S, BUY, deficit, 0);
  mcf.add(S, RENT, deficit, 0);
  for (let j = 0; j < L; j++) {
    if (required[j] - onHand[j] <= 0) continue;
    for (let i = 0; i < L; i++) {
      if (i === j || onHand[i] - required[i] <= 0) continue;
      outArcs.push({ kind: 'transfer', from: i, to: j, arc: mcf.add(1 + i, 1 + L + j, Infinity, transferCost(part, locs[i], locs[j], rates)) });
    }
    outArcs.push({ kind: 'buy', to: j, arc: mcf.add(BUY, 1 + L + j, Infinity, part.price + rates.buyShip) });
    if (part.rentWeek > 0) outArcs.push({ kind: 'rent', to: j, arc: mcf.add(RENT, 1 + L + j, Infinity, part.rentWeek * horizonWeeks + rates.rentDelivery) });
  }
  const res = mcf.solve(S, T, deficit);
  const moves = outArcs.filter((m) => m.arc.flow > 0).map((m) => ({ kind: m.kind, from: m.from, to: m.to, qty: m.arc.flow, unitCost: m.arc.cost }));
  return { deficit, cost: res.cost, moves, covered: res.flow };
}

// Baseline A: each location reorders its own deficit (buy, or rent if cheaper), no transfers.
export function planPerSite(part, locs, required, onHand, rates, horizonWeeks) {
  let cost = 0; const moves = [];
  for (let j = 0; j < locs.length; j++) {
    const d = required[j] - onHand[j];
    if (d <= 0) continue;
    const buy = part.price + rates.buyShip, rent = part.rentWeek > 0 ? part.rentWeek * horizonWeeks + rates.rentDelivery : Infinity;
    const kind = rent < buy ? 'rent' : 'buy';
    cost += d * Math.min(buy, rent); moves.push({ kind, to: j, qty: d, unitCost: Math.min(buy, rent) });
  }
  return { cost, moves };
}

// Baseline B: main-warehouse-first (what a Reorder Worksheet transfer request from one From Location does),
// then buy/rent the rest.
export function planMainFirst(part, locs, required, onHand, rates, horizonWeeks, main = 0) {
  let avail = Math.max(0, onHand[main] - required[main]);
  let cost = 0; const moves = [];
  for (let j = 0; j < locs.length; j++) {
    if (j === main) continue;
    let d = required[j] - onHand[j];
    if (d <= 0) continue;
    const tq = Math.min(avail, d);
    if (tq > 0) { const c = transferCost(part, locs[main], locs[j], rates); cost += tq * c; moves.push({ kind: 'transfer', from: main, to: j, qty: tq, unitCost: c }); avail -= tq; d -= tq; }
    if (d > 0) {
      const buy = part.price + rates.buyShip, rent = part.rentWeek > 0 ? part.rentWeek * horizonWeeks + rates.rentDelivery : Infinity;
      cost += d * Math.min(buy, rent); moves.push({ kind: rent < buy ? 'rent' : 'buy', to: j, qty: d, unitCost: Math.min(buy, rent) });
    }
  }
  const dm = required[main] - onHand[main];
  if (dm > 0) { const buy = part.price + rates.buyShip; cost += dm * buy; moves.push({ kind: 'buy', to: main, qty: dm, unitCost: buy }); }
  return { cost, moves };
}

export function round(x, d = 2) { const p = 10 ** d; return Math.round(x * p) / p; }

export function movesCSV(parts, locs, plans) {
  const rows = ['part_number,description,action,from_location,to_location,qty,unit_cost,line_cost'];
  plans.forEach((pl, k) => pl.moves.forEach((m) => rows.push([parts[k].id, `"${parts[k].name}"`, m.kind, m.from != null ? locs[m.from].id : '', locs[m.to].id, m.qty, round(m.unitCost), round(m.qty * m.unitCost)].join(','))));
  return rows.join('\n');
}

// Conformal requirements at planning week t, calibrated on rolling-origin forecasts whose
// 4-week windows finished before t (no leakage). Mondrian (per part number) calibration: each part gets
// its own quantile, so a rarely used $18k bolt tensioner is not padded like a $290 grinder, and the
// >= 1-alpha coverage guarantee holds for every part separately (under exchangeability of windows).
export function requirementsAt(net, t, alpha, horizon, calFrom = 12) {
  const qs = []; let nCal = 0;
  for (let k = 0; k < net.parts.length; k++) {
    const scores = [];
    for (let c = calFrom; c + horizon <= t; c++) for (let i = 0; i < net.locs.length; i++) {
      const f = pointForecast(net.peaks[k][i], net.headcount[i], c, horizon);
      let y = 0; for (let w = c; w < c + horizon; w++) y = Math.max(y, net.peaks[k][i][w]);
      scores.push(score(f, y));
    }
    nCal += scores.length;
    qs.push(conformalQuantile(scores, alpha));
  }
  const forecast = net.parts.map((p, k) => net.locs.map((l, i) => pointForecast(net.peaks[k][i], net.headcount[i], t, horizon)));
  const required = forecast.map((row, k) => row.map((f) => requirement(f, qs[k])));
  return { q: qs, nCal, forecast, required };
}
