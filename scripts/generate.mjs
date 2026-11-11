// Seeded tool-crib network + committed results.  node scripts/generate.mjs
import { writeFileSync } from 'node:fs';
import { rng, planPart, planPerSite, planMainFirst, round, requirementsAt as coreRequirementsAt } from '../src/rebalance.js';

export const SEED = 20261111;
export const WEEKS = 52;          // history: weeks 0..51 (week 51 = w/e 8 Nov 2026)
export const NOW = 52;            // planning week (9 Nov 2026)
export const HORIZON = 4;         // plan the next 4 weeks
export const ALPHA = 0.05;        // 95% service target per (part, location)
export const RATES = { handling: 45, perKm: 0.22, buyShip: 60, rentDelivery: 120 };
export const RENT_WEEKS = 10;     // a short-fall unit is needed for the rest of the season (~10 weeks) if rented

// Real Alberta locations (approximate public coordinates). Projects and headcounts are synthetic.
export const LOCS = [
  { id: 'STA-WH', name: 'St. Albert Main Warehouse', lat: 53.630, lon: -113.626, kind: 'Warehouse' },
  { id: 'FMM-01', name: 'Fort McMurray Oil Sands Turnaround', lat: 56.726, lon: -111.381, kind: 'Job site' },
  { id: 'FSK-02', name: 'Fort Saskatchewan Upgrader', lat: 53.713, lon: -113.213, kind: 'Job site' },
  { id: 'CGY-03', name: 'Calgary Hospital Expansion', lat: 51.045, lon: -114.072, kind: 'Job site' },
  { id: 'RDR-04', name: 'Red Deer Gas Plant', lat: 52.269, lon: -113.811, kind: 'Job site' },
  { id: 'GPR-05', name: 'Grande Prairie Pulp Mill', lat: 55.171, lon: -118.795, kind: 'Job site' },
  { id: 'CLK-06', name: 'Cold Lake SAGD Pad', lat: 54.464, lon: -110.182, kind: 'Job site' },
  { id: 'LLM-07', name: 'Lloydminster Heavy Oil', lat: 53.278, lon: -110.005, kind: 'Job site' },
];

// Serialized tools: approximate list prices / weekly rental rates in CAD (assumptions), freight class 0.3-3.
export const PARTS = [
  ['2DA1SA', 'Hammer, Chipping, Hex Shank 0.58" (15mm)', 1450, 95, 1.2, 0.020],
  ['TW-34-600', 'Torque Wrench 3/4" Dr 100-600 ft-lb (calibrated)', 980, 70, 0.6, 0.012],
  ['HTW-5MXT', 'Hydraulic Torque Wrench 5MXT + Pump', 14800, 650, 2.4, 0.004],
  ['GD-4GAS', 'Gas Detector, 4-Gas (calibrated)', 1150, 85, 0.3, 0.030],
  ['MD-CS-2', 'Magnetic Drill 2" Capacity', 2350, 140, 1.4, 0.008],
  ['RH-SDSMAX', 'Rotary Hammer SDS-Max 1-3/4"', 1290, 90, 1.0, 0.014],
  ['IMP-M18-1', 'Impact Wrench 1" Cordless High Torque', 1180, 75, 0.7, 0.016],
  ['WLD-BC260', 'Engine Welder 260A', 9800, 420, 3.0, 0.006],
  ['BS-PORT-5', 'Portable Band Saw 5"', 690, 55, 0.6, 0.010],
  ['PT-300', 'Power Pipe Threader 1/8"-2"', 5200, 260, 2.2, 0.004],
  ['LL-ROT-2', 'Rotary Laser Level + Detector', 2650, 160, 0.5, 0.005],
  ['GEN-7K', 'Generator 7 kW', 3900, 210, 2.6, 0.005],
  ['HTR-400K', 'Indirect Fired Heater 400k BTU', 11900, 520, 3.0, 0.004],
  ['PMP-3TR', 'Trash Pump 3"', 1750, 120, 1.8, 0.004],
  ['CH-2T-20', 'Chain Hoist 2-Ton, 20 ft Lift (inspected)', 1350, 80, 1.3, 0.010],
  ['LCH-3T', 'Lever Hoist 3-Ton (inspected)', 520, 40, 0.8, 0.012],
  ['GR-7-DW', 'Angle Grinder 7" Corded', 290, 30, 0.4, 0.028],
  ['FAH-FULL', 'Full Body Harness w/ SRL (inspected)', 640, 45, 0.4, 0.035],
  ['MW-SCOPE', 'Multimeter, True RMS (calibrated)', 760, 55, 0.3, 0.010],
  ['BT-BOLTTEN', 'Bolt Tensioner Set M36-M52', 18500, 900, 2.0, 0.002],
];

export function build(seed = SEED) {
  const R = rng(seed);
  const gauss = () => { let u = 0; for (let i = 0; i < 6; i++) u += R(); return (u - 3) / Math.sqrt(0.5); };
  const poisson = (lam) => { if (lam <= 0) return 0; if (lam > 30) return Math.max(0, Math.round(lam + Math.sqrt(lam) * gauss())); let k = 0, p = Math.exp(-lam), c = p; const u = R(); while (u > c) { k++; p *= lam / k; c += p; } return k; };
  const W = WEEKS + 12;
  // Headcount plans per location (warehouse issues few tools). Turnaround at FMM ramps up now; CGY winds down.
  const shapes = {
    'STA-WH': (w) => 12,
    'FMM-01': (w) => 60 + (w >= 46 ? Math.min(260, (w - 46) * 45) : 0),
    'FSK-02': (w) => 140 + 20 * Math.sin(w / 6),
    'CGY-03': (w) => Math.max(20, 210 - Math.max(0, w - 34) * 9),
    'RDR-04': (w) => 80 + (w >= 50 ? 60 : 0),
    'GPR-05': (w) => 110,
    'CLK-06': (w) => 40 + (w >= 49 ? 70 : 0),
    'LLM-07': (w) => Math.max(15, 120 - Math.max(0, w - 40) * 6),
  };
  const headcount = LOCS.map((l) => Array.from({ length: W }, (_, w) => Math.round(shapes[l.id](w) * (1 + 0.04 * gauss()))));
  const parts = PARTS.map(([id, name, price, rentWeek, freightClass, perWorker]) => ({ id, name, price, rentWeek, freightClass, perWorker }));
  const peaks = parts.map((p) => LOCS.map((l, i) => {
    const site = 0.6 + 0.8 * R(); // site-specific usage intensity
    const mult = l.kind === 'Warehouse' ? 0.3 : site;
    return Array.from({ length: W }, (_, w) => poisson(p.perWorker * mult * headcount[i][w] * Math.exp(0.15 * gauss())));
  }));
  // On-hand: what each crib owns now (history of past projects): roughly last year's peak + random leftovers.
  const onHand = parts.map((p, k) => LOCS.map((l, i) => {
    let mx = 0; for (let w = 30; w < 46; w++) mx = Math.max(mx, peaks[k][i][w]);
    const extra = l.kind === 'Warehouse' ? Math.round(2 + 4 * R()) : Math.round(R() * 2);
    return mx + extra;
  }));
  return { locs: LOCS, parts, headcount, peaks, onHand, weeks: WEEKS, now: NOW, horizon: HORIZON };
}

export function requirementsAt(net, t, alpha = ALPHA, calFrom = 12) { return coreRequirementsAt(net, t, alpha, HORIZON, calFrom); }

export function plans(net, required) {
  const out = { optimal: [], perSite: [], mainFirst: [] };
  net.parts.forEach((p, k) => {
    out.optimal.push(planPart(p, net.locs, required[k], net.onHand[k], RATES, RENT_WEEKS));
    out.perSite.push(planPerSite(p, net.locs, required[k], net.onHand[k], RATES, RENT_WEEKS));
    out.mainFirst.push(planMainFirst(p, net.locs, required[k], net.onHand[k], RATES, RENT_WEEKS));
  });
  return out;
}

export function computeResults(net) {
  // Coverage backtest: for cutoffs 30..48, does actual 4-week peak <= conformal requirement?
  let hit = 0, n = 0; const byCut = [];
  for (let t = 30; t + HORIZON <= WEEKS; t++) {
    const { required } = requirementsAt(net, t);
    let h = 0, m = 0;
    for (let k = 0; k < net.parts.length; k++) for (let i = 0; i < net.locs.length; i++) {
      let y = 0; for (let w = t; w < t + HORIZON; w++) y = Math.max(y, net.peaks[k][i][w]);
      m++; if (y <= required[k][i]) h++;
    }
    hit += h; n += m; byCut.push({ week: t, coverage: round(h / m, 4) });
  }
  const now = requirementsAt(net, NOW);
  const pl = plans(net, now.required);
  const sum = (arr) => arr.reduce((a, x) => a + x.cost, 0);
  const tally = (arr) => { const c = { transfer: 0, buy: 0, rent: 0 }; arr.forEach((p) => p.moves.forEach((m) => (c[m.kind] += m.qty))); return c; };
  const totals = { optimal: sum(pl.optimal), perSite: sum(pl.perSite), mainFirst: sum(pl.mainFirst) };
  const deficitUnits = pl.optimal.reduce((a, p) => a + p.deficit, 0);
  const purchaseValue = (arr) => arr.reduce((a, p) => a + p.moves.filter((m) => m.kind === 'buy').reduce((b, m) => b + m.qty * m.unitCost, 0), 0);
  return {
    seed: SEED, now: NOW, horizon: HORIZON, alpha: ALPHA, rates: RATES, rentWeeks: RENT_WEEKS,
    conformal: { qByPart: Object.fromEntries(net.parts.map((p, k) => [p.id, round(now.q[k], 4)])), nCal: now.nCal },
    coverage: { overall: round(hit / n, 4), n, byCutoff: byCut },
    totals: { optimal: round(totals.optimal), perSite: round(totals.perSite), mainFirst: round(totals.mainFirst) },
    moves: { optimal: tally(pl.optimal), perSite: tally(pl.perSite), mainFirst: tally(pl.mainFirst) },
    purchases: { optimal: round(purchaseValue(pl.optimal)), perSite: round(purchaseValue(pl.perSite)), mainFirst: round(purchaseValue(pl.mainFirst)) },
    deficitUnits,
    headline: {
      savingsVsPerSitePct: round(100 * (1 - totals.optimal / totals.perSite), 1),
      savingsVsMainFirstPct: round(100 * (1 - totals.optimal / totals.mainFirst), 1),
      optimalCost: round(totals.optimal, 0), perSiteCost: round(totals.perSite, 0), mainFirstCost: round(totals.mainFirst, 0),
      coveragePct: round(100 * hit / n, 1),
      unitsTransferred: tally(pl.optimal).transfer,
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const net = build();
  writeFileSync(new URL('../data/network.json', import.meta.url), JSON.stringify(net));
  const res = computeResults(net);
  writeFileSync(new URL('../data/results.json', import.meta.url), JSON.stringify(res, null, 2));
  console.log(JSON.stringify({ ...res, coverage: { overall: res.coverage.overall, n: res.coverage.n } }, null, 1));
}
