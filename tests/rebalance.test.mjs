import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rng, haversineKm, pointForecast, conformalQuantile, score, requirement, MinCostFlow, planPart, planPerSite, planMainFirst, transferCost, movesCSV } from '../src/rebalance.js';
import { build, computeResults, requirementsAt, plans, RATES, RENT_WEEKS, HORIZON, LOCS } from '../scripts/generate.mjs';

const net = build();

test('haversine: Edmonton area to Calgary is ~290 km, symmetric, zero to self', () => {
  const d = haversineKm(LOCS[0], LOCS[3]);
  assert.ok(d > 270 && d < 310, String(d));
  assert.ok(Math.abs(d - haversineKm(LOCS[3], LOCS[0])) < 1e-9);
  assert.equal(haversineKm(LOCS[2], LOCS[2]), 0);
});

test('conformal quantile uses the ceil((n+1)(1-alpha)) order statistic', () => {
  const s = Array.from({ length: 19 }, (_, i) => i + 1); // 1..19
  assert.equal(conformalQuantile(s, 0.1), 18); // ceil(20*0.9)=18
  assert.equal(conformalQuantile(s, 0.05), 19);
  assert.equal(conformalQuantile([1, 2, 3], 0.05), Infinity);
});

test('split conformal covers exchangeable data at >= 1 - alpha on average (randomized)', () => {
  const R = rng(1);
  let cover = 0, N = 2000;
  for (let rep = 0; rep < N; rep++) {
    const cal = Array.from({ length: 60 }, () => R() ** 2 * 10 - 3);
    const q = conformalQuantile(cal, 0.1);
    if (R() ** 2 * 10 - 3 <= q) cover++;
  }
  assert.ok(cover / N >= 0.88, String(cover / N));
});

test('min-cost flow matches brute force on small transportation problems (randomized)', () => {
  const R = rng(2);
  for (let trial = 0; trial < 150; trial++) {
    const sup = [1 + Math.floor(R() * 3), 1 + Math.floor(R() * 3)];
    const dem = [1 + Math.floor(R() * 2), 1 + Math.floor(R() * 2)];
    const c = [[R() * 10, R() * 10], [R() * 10, R() * 10]];
    const D = dem[0] + dem[1];
    if (sup[0] + sup[1] < D) continue;
    let best = Infinity;
    for (let a = 0; a <= dem[0]; a++) for (let b = 0; b <= dem[1]; b++) {
      const x = [[a, b], [dem[0] - a, dem[1] - b]];
      if (x[1][0] < 0 || x[1][1] < 0 || a + b > sup[0] || x[1][0] + x[1][1] > sup[1]) continue;
      best = Math.min(best, a * c[0][0] + b * c[0][1] + x[1][0] * c[1][0] + x[1][1] * c[1][1]);
    }
    const g = new MinCostFlow(6);
    g.add(0, 1, sup[0], 0); g.add(0, 2, sup[1], 0);
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) g.add(1 + i, 3 + j, Infinity, c[i][j]);
    g.add(3, 5, dem[0], 0); g.add(4, 5, dem[1], 0);
    const r = g.solve(0, 5);
    assert.equal(r.flow, D);
    assert.ok(Math.abs(r.cost - best) < 1e-9, `${r.cost} vs ${best}`);
  }
});

const randomInstance = (R) => {
  const locs = LOCS;
  const part = { price: 500 + R() * 5000, rentWeek: 20 + R() * 200, freightClass: 0.3 + R() * 2.5 };
  const required = locs.map(() => Math.floor(R() * 8));
  const onHand = locs.map(() => Math.floor(R() * 8));
  return { locs, part, required, onHand };
};

test('optimal plan is never more expensive than per-site or main-warehouse-first (randomized)', () => {
  const R = rng(3);
  for (let trial = 0; trial < 300; trial++) {
    const { locs, part, required, onHand } = randomInstance(R);
    const o = planPart(part, locs, required, onHand, RATES, RENT_WEEKS);
    const a = planPerSite(part, locs, required, onHand, RATES, RENT_WEEKS);
    const b = planMainFirst(part, locs, required, onHand, RATES, RENT_WEEKS);
    assert.ok(o.cost <= a.cost + 1e-6 && o.cost <= b.cost + 1e-6);
  }
});

test('plans cover every deficit and never draw a source below its own requirement', () => {
  const R = rng(4);
  for (let trial = 0; trial < 200; trial++) {
    const { locs, part, required, onHand } = randomInstance(R);
    const o = planPart(part, locs, required, onHand, RATES, RENT_WEEKS);
    const after = [...onHand];
    for (const m of o.moves) { after[m.to] += m.qty; if (m.kind === 'transfer') after[m.from] -= m.qty; }
    for (let i = 0; i < locs.length; i++) assert.ok(after[i] >= Math.min(required[i], onHand[i]) && after[i] >= required[i]);
  }
});

test('cheap transfers are used; prohibitive freight falls back to buy/rent', () => {
  const locs = LOCS.slice(0, 3);
  const part = { price: 4000, rentWeek: 300, freightClass: 1 };
  const cheap = planPart(part, locs, [0, 3, 0], [5, 0, 0], RATES, RENT_WEEKS);
  assert.ok(cheap.moves.every((m) => m.kind === 'transfer') && cheap.moves[0].qty === 3);
  const pricey = planPart({ ...part, freightClass: 1000 }, locs, [0, 3, 0], [5, 0, 0], RATES, RENT_WEEKS);
  assert.ok(pricey.moves.every((m) => m.kind !== 'transfer'));
  assert.ok(transferCost(part, locs[0], locs[1], RATES) > RATES.handling);
});

test('requirement grows with the conformal quantile and the point forecast scales with headcount', () => {
  let prev = -1;
  for (const q of [0, 0.5, 1, 2, 3]) { const r = requirement(4, q); assert.ok(r >= prev); prev = r; }
  const peaks = Array(12).fill(4), hc = Array(16).fill(100);
  const f1 = pointForecast(peaks, hc, 10, 4);
  const f2 = pointForecast(peaks, hc.map((h, w) => (w >= 10 ? 200 : h)), 10, 4);
  assert.ok(Math.abs(f2 - 2 * f1) < 1e-9);
  assert.ok(Math.abs(score(4, 4)) < 1e-12);
});

test('no leakage: calibration at week t only uses windows that ended before t', () => {
  const t = 40;
  const { nCal } = requirementsAt(net, t);
  const windows = t - HORIZON - 12 + 1;
  assert.equal(nCal, windows * net.parts.length * net.locs.length);
});

test('rolling backtest coverage meets the 95% target', () => {
  const res = computeResults(net);
  assert.ok(res.coverage.overall >= 0.95, String(res.coverage.overall));
  assert.ok(res.coverage.byCutoff.every((c) => c.coverage >= 0.85));
});

test('generator is deterministic and matches committed data', () => {
  const committed = JSON.parse(readFileSync(new URL('../data/network.json', import.meta.url)));
  assert.deepEqual(JSON.parse(JSON.stringify(build())), committed);
});

test('headline reproduces data/results.json', () => {
  const committed = JSON.parse(readFileSync(new URL('../data/results.json', import.meta.url)));
  const res = computeResults(net);
  assert.deepEqual(res.headline, committed.headline);
  assert.deepEqual(res.totals, committed.totals);
  assert.ok(res.headline.savingsVsPerSitePct > 30);
});

test('CSV export lists one row per move', () => {
  const now = requirementsAt(net, 52);
  const pl = plans(net, now.required);
  const csv = movesCSV(net.parts, net.locs, pl.optimal).split('\n');
  const n = pl.optimal.reduce((a, p) => a + p.moves.length, 0);
  assert.equal(csv.length, n + 1);
  assert.ok(csv[0].startsWith('part_number,description,action'));
});
