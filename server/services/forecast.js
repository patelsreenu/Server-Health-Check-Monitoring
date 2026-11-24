'use strict';

/**
 * forecast.js
 * ───────────
 * Deterministic trend / anomaly analysis over hourly history buckets.
 * Pure functions — no I/O — so they are cheap, testable and work with no AI key.
 *
 *   diskForecast   Theil–Sen growth rate per drive → days until 95% / 100%
 *   memoryTrend    leak detection on the data since the last reboot
 *   anomaly        current CPU/mem vs this server's own hour-of-week baseline
 *   flapping       repeated status transitions in the last 7 days
 *   riskScore      0–100 roll-up used to rank the fleet
 */

const DAY_MS  = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;

function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Theil–Sen estimator: median of all pairwise slopes.  Robust to the sawtooth
 * pattern disks show after a log cleanup, unlike ordinary least squares.
 * @param {{x:number,y:number}[]} pts  x in days
 * @returns {{slope:number, intercept:number, consistency:number}|null}
 *   consistency = share of pairwise slopes that are positive (1 = steady growth)
 */
function theilSen(pts) {
  const n = pts.length;
  if (n < 3) return null;
  // Cap work at ~400 points (≈ 80k pairs); evenly thin if there are more.
  let p = pts;
  if (n > 400) { const step = n / 400; p = Array.from({ length: 400 }, (_, i) => pts[Math.floor(i * step)]); }
  const slopes = [];
  let pos = 0;
  for (let i = 0; i < p.length; i++) {
    for (let j = i + 1; j < p.length; j++) {
      const dx = p[j].x - p[i].x;
      if (dx <= 0) continue;
      const s = (p[j].y - p[i].y) / dx;
      slopes.push(s);
      if (s > 0) pos++;
    }
  }
  if (!slopes.length) return null;
  const slope = median(slopes);
  const intercept = median(p.map(q => q.y - slope * q.x));
  return { slope, intercept, consistency: pos / slopes.length };
}

const toPts = (rows, key) => rows
  .filter(r => r[key] != null)
  .map(r => ({ x: r.ts / DAY_MS, y: r[key] }));

function confidence(spanDays, consistency, n) {
  if (spanDays >= 5 && n >= 72 && consistency >= 0.8) return 'high';
  if (spanDays >= 2 && n >= 24 && consistency >= 0.65) return 'medium';
  return 'low';
}

// ── Disk ───────────────────────────────────────────────────────────────────────
/**
 * @param {Object<string, {ts:number, used_pct:number, size_gb:number}[]>} byDrive
 * @returns {object[]} one entry per drive, soonest-to-fill first
 */
function diskForecast(byDrive) {
  const out = [];
  for (const [drive, rows] of Object.entries(byDrive || {})) {
    if (rows.length < 12) continue;                       // < ~12 h of data
    const spanDays = (rows[rows.length - 1].ts - rows[0].ts) / DAY_MS;
    if (spanDays < 0.5) continue;
    const current = rows[rows.length - 1].used_pct;
    const sizeGB  = rows[rows.length - 1].size_gb || null;
    const fit = theilSen(toPts(rows, 'used_pct'));
    if (!fit) continue;

    const slopePctPerDay = fit.slope;
    const growing = slopePctPerDay > 0.05 && fit.consistency >= 0.6;
    const daysTo = t => (growing && current < t) ? (t - current) / slopePctPerDay : (current >= t ? 0 : null);

    out.push({
      drive,
      currentPct: round(current, 1),
      sizeGB,
      growthPctPerDay: round(slopePctPerDay, 2),
      growthGBPerDay:  sizeGB ? round(slopePctPerDay / 100 * sizeGB, 2) : null,
      daysTo90: round(daysTo(90), 1),
      daysTo95: round(daysTo(95), 1),
      daysToFull: round(daysTo(100), 1),
      confidence: confidence(spanDays, fit.consistency, rows.length),
      spanDays: round(spanDays, 1)
    });
  }
  const key = d => d.daysTo95 ?? Infinity;
  return out.sort((a, b) => key(a) - key(b));
}

// ── Memory ─────────────────────────────────────────────────────────────────────
/**
 * Only data since the most recent reboot is used — otherwise a restart (which
 * frees memory) would hide a leak.
 */
function memoryTrend(rows) {
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  const bootTs = last.uptime != null ? Date.now() - last.uptime * DAY_MS : rows[0].ts;
  const since = rows.filter(r => r.ts >= bootTs - HOUR_MS && r.mem != null);
  if (since.length < 12) return null;
  const spanDays = (since[since.length - 1].ts - since[0].ts) / DAY_MS;
  if (spanDays < 0.5) return null;

  const fit = theilSen(toPts(since, 'mem'));
  if (!fit) return null;
  const current = since[since.length - 1].mem;
  const perDay = fit.slope;
  const leaking = perDay > 0.5 && fit.consistency >= 0.75 && current > 60;
  return {
    currentPct: round(current, 1),
    growthPctPerDay: round(perDay, 2),
    leakSuspected: leaking,
    daysTo95: leaking && current < 95 ? round((95 - current) / perDay, 1) : null,
    sinceRebootDays: round(last.uptime ?? spanDays, 1),
    confidence: confidence(spanDays, fit.consistency, since.length)
  };
}

// ── Anomaly (hour-of-week baseline) ────────────────────────────────────────────
function mad(arr, med) { return median(arr.map(v => Math.abs(v - med))); }

function anomalyFor(rows, key, { floorMad, minDelta }) {
  const usable = rows.filter(r => r[key] != null);
  if (usable.length < 48) return null;
  const now = usable[usable.length - 1].ts;
  const recent = usable.filter(r => r.ts > now - 3 * HOUR_MS);
  if (!recent.length) return null;
  const cur = recent.reduce((s, r) => s + r[key], 0) / recent.length;

  // Baseline: same hour-of-week ±1 h, excluding the last 3 hours.
  const how = ts => { const d = new Date(ts); return d.getUTCDay() * 24 + d.getUTCHours(); };
  const target = how(now);
  const near = h => { const d = Math.abs(h - target); return Math.min(d, 168 - d) <= 1; };
  const base = usable.filter(r => r.ts <= now - 3 * HOUR_MS && near(how(r.ts))).map(r => r[key]);
  if (base.length < 5) return null;

  const med = median(base);
  const spread = Math.max(1.4826 * mad(base, med), floorMad);
  const z = (cur - med) / spread;
  return {
    metric: key, current: round(cur, 1), baseline: round(med, 1), zScore: round(z, 1),
    anomalous: z > 3.5 && (cur - med) > minDelta
  };
}

function anomaly(rows) {
  const results = [
    anomalyFor(rows, 'cpu', { floorMad: 5, minDelta: 20 }),
    anomalyFor(rows, 'mem', { floorMad: 2, minDelta: 10 })
  ].filter(Boolean);
  return results;
}

// ── CPU / memory load summaries and plain-English insights ─────────────────────
/**
 * How busy a metric has been: now, last 24 h, last 7 days vs the week before, and how many of the
 * last 24 hourly readings were at or above `hotAt`.  `trendPerDay` is the 14-day Theil–Sen slope.
 */
function loadSummary(rows, key, hotAt) {
  const usable = rows.filter(r => r[key] != null);
  if (usable.length < 12) return null;
  const now = usable[usable.length - 1].ts;
  const avg = a => a.length ? a.reduce((t, r) => t + r[key], 0) / a.length : null;
  const d1  = usable.filter(r => r.ts > now - DAY_MS);
  const d7  = usable.filter(r => r.ts > now - 7 * DAY_MS);
  const p7  = usable.filter(r => r.ts <= now - 7 * DAY_MS && r.ts > now - 14 * DAY_MS);
  const recent = usable.filter(r => r.ts > now - 3 * HOUR_MS);
  const fit = theilSen(toPts(usable.filter(r => r.ts > now - 14 * DAY_MS), key));
  return {
    current: round(avg(recent), 1), avg24h: round(avg(d1), 1),
    peak24h: d1.length ? round(Math.max(...d1.map(r => r[key])), 1) : null,
    hoursHot24: d1.filter(r => r[key] >= hotAt).length, hours24: d1.length,
    avg7d: round(avg(d7), 1), avgPrev7d: p7.length >= 48 ? round(avg(p7), 1) : null,
    trendPerDay: fit ? round(fit.slope, 2) : null, trendConsistency: fit ? round(fit.consistency, 2) : null,
    spanDays: round((now - usable[0].ts) / DAY_MS, 1)
  };
}

/**
 * The single most important CPU finding for a server, or null.  Dashboard limits: warning 85 %, critical 90 %.
 *   sustained  hourly average at or above 85 % for 6+ of the last 24 hours
 *   rising     two-week average climbing steadily (with an estimate of when it would reach 90 %)
 *   unusual    far above this server's own normal for this time of week
 */
function cpuInsight(sum, anoms = []) {
  if (!sum) return null;
  if (sum.hoursHot24 >= 6) {
    return { kind: 'sustained', severity: sum.hoursHot24 >= 12 ? 'high' : 'medium',
      text: `Averaged 85% or more for ${sum.hoursHot24} of the last ${sum.hours24} hours (24-hour average ${sum.avg24h}%, peak ${sum.peak24h}%). Look for a runaway process, a stuck job, or a server that needs more CPU.` };
  }
  const rising = sum.trendPerDay != null && sum.trendPerDay >= 0.4 && sum.trendConsistency >= 0.7 && sum.avg24h >= 30;
  if (rising) {
    const days = sum.avg24h < 90 ? (90 - sum.avg24h) / sum.trendPerDay : null;
    return { kind: 'rising', severity: days != null && days <= 30 ? 'medium' : 'low', daysTo90: days != null && days <= 180 ? round(days, 0) : null,
      text: `Average CPU is climbing about ${sum.trendPerDay}% a day over the last two weeks (now ${sum.avg24h}%${sum.avgPrev7d != null ? `, was ${sum.avgPrev7d}% the week before` : ''})${days != null && days <= 180 ? `; at this pace it averages 90% in about ${Math.round(days)} days.` : '.'}` };
  }
  const a = anoms.find(x => x.metric === 'cpu' && x.anomalous);
  if (a) return { kind: 'unusual', severity: 'medium', text: `CPU is ${a.current}% — this server normally runs about ${a.baseline}% at this time of the week.` };
  return null;
}

/**
 * The single most important memory finding, or null.  Dashboard limits: warning 90 %, critical 95 %.
 *   leak       steady growth since the last reboot (from memoryTrend)
 *   sustained  hourly average at or above 90 % for 12+ of the last 24 hours — little or no headroom
 *   unusual    far above this server's own normal for this time of week
 */
function memoryInsight(trend, sum, anoms = []) {
  if (trend?.leakSuspected) {
    return { kind: 'leak', severity: trend.daysTo95 != null && trend.daysTo95 <= 14 ? 'high' : 'medium', daysTo95: trend.daysTo95,
      text: `Memory has grown ${trend.growthPctPerDay}% a day since the last reboot (${trend.sinceRebootDays} days ago), now ${trend.currentPct}%${trend.daysTo95 != null ? `; at this pace it reaches 95% in about ${trend.daysTo95} days. A restart would free it, but find the process that is growing.` : '.'}` };
  }
  if (sum && sum.hoursHot24 >= 12) {
    return { kind: 'sustained', severity: sum.hoursHot24 >= 20 || sum.avg24h >= 95 ? 'high' : 'medium',
      text: `Used 90% or more for ${sum.hoursHot24} of the last ${sum.hours24} hours (24-hour average ${sum.avg24h}%, 7-day average ${sum.avg7d}%). Steady rather than growing, so it has little headroom — check what is using it or add memory.` };
  }
  const a = anoms.find(x => x.metric === 'mem' && x.anomalous);
  if (a) return { kind: 'unusual', severity: 'medium', text: `Memory is ${a.current}% — this server normally uses about ${a.baseline}% at this time of the week.` };
  return null;
}

// ── Flapping ───────────────────────────────────────────────────────────────────
function flapping(events) {
  const bad = new Set(['critical', 'error']);
  const entries = events.filter(e => e.kind === 'status_change' && bad.has(e.to_status) && !bad.has(e.from_status));
  return { count7d: entries.length, flapping: entries.length >= 4 };
}

// ── Risk score ─────────────────────────────────────────────────────────────────
function riskScore({ status, disks = [], memory, anomalies = [], flap }) {
  const reasons = [];
  let score = 0;
  const add = (pts, why) => { score += pts; reasons.push(why); };

  if (status === 'critical')      add(40, 'currently critical');
  else if (status === 'error')    add(30, 'health check failing');
  else if (status === 'warning')  add(20, 'currently warning');

  const d = disks.find(x => x.daysTo95 != null);
  if (d) {
    if (d.daysTo95 <= 7)        add(30, `${d.drive} reaches 95% in ${d.daysTo95}d`);
    else if (d.daysTo95 <= 14)  add(15, `${d.drive} reaches 95% in ${d.daysTo95}d`);
    else if (d.daysTo95 <= 30)  add(5,  `${d.drive} reaches 95% in ${d.daysTo95}d`);
  }
  if (memory?.leakSuspected) add(memory.daysTo95 != null && memory.daysTo95 <= 14 ? 20 : 10, 'memory growing since last reboot');
  if (anomalies.some(a => a.anomalous)) add(10, 'abnormal vs usual load for this hour');
  if (flap?.flapping) add(15, `${flap.count7d} failures in 7 days`);

  return { score: Math.min(100, score), reasons };
}

function round(v, dp) { return v == null ? null : Math.round(v * 10 ** dp) / 10 ** dp; }

/** Full analysis for one server from its stored history. */
function analyze({ status, hourly, diskByDrive, events }) {
  const disks     = diskForecast(diskByDrive);
  const memory    = memoryTrend(hourly);
  const anomalies = anomaly(hourly);
  const flap      = flapping(events);
  const risk      = riskScore({ status, disks, memory, anomalies, flap });
  const cpuLoad   = loadSummary(hourly, 'cpu', 85);
  const memLoad   = loadSummary(hourly, 'mem', 90);
  return {
    status, risk, disks, memory, anomalies, flapping: flap, samples: hourly.length,
    cpuLoad, memLoad, cpuInsight: cpuInsight(cpuLoad, anomalies), memInsight: memoryInsight(memory, memLoad, anomalies)
  };
}

module.exports = { analyze, diskForecast, memoryTrend, anomaly, flapping, riskScore, theilSen, loadSummary, cpuInsight, memoryInsight };
