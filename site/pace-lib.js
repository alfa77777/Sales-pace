/**
 * Sales Pace — shared calculation + rendering helpers.
 * Every number on every screen comes from here, so team, seller and admin
 * views can never disagree. Loaded before app.js.
 */

function pad(n){ return String(n).padStart(2,'0'); }

/* Text shown by these helpers goes through paceT, so the app can translate
   it (app.js sets window.paceTranslate). English is the fallback. */
function paceT(s, vars){
  if (typeof window !== 'undefined' && typeof window.paceTranslate === 'function') return window.paceTranslate(s, vars);
  return vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m)) : s;
}
function todayStr(){ const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function fmt(n){
  const v = Number(n);
  if (!isFinite(v)) return '—'; // never show "NaN" (ru-RU prints it as "не число")
  return Math.round(v).toLocaleString('ru-RU');
}

function getMonthInfo(d){
  const year = d.getFullYear(), month = d.getMonth();
  const daysInMonth = new Date(year, month+1, 0).getDate();
  return {
    year, month, daysInMonth,
    dayOfMonth: d.getDate(),
    monthKey: `${year}-${pad(month+1)}`,
    monthName: d.toLocaleString('en-US', {month:'long'}),
  };
}
function entryDay(dateStr){ return parseInt(String(dateStr).split('-')[2], 10); }

const DECADES = [
  { label: 'First 10 days',  short: 'Days 1–10',  pct: 0.25, start: 1  },
  { label: 'Second 10 days', short: 'Days 11–20', pct: 0.55, start: 11 },
  { label: 'Third 10 days',  short: 'Days 21–end', pct: 0.80, start: 21 },
];
function monthInfoFor(monthKey){
  const p = String(monthKey).split('-').map(Number);
  return getMonthInfo(new Date(p[0], p[1] - 1, 1));
}
function decadeEnd(idx, daysInMonth){ return idx === 2 ? daysInMonth : (idx === 0 ? 10 : 20); }

function monthEntries(allEntries, monthKey){
  return allEntries
    .filter(e => String(e.date).startsWith(monthKey))
    .sort((a,b)=> String(a.date).localeCompare(String(b.date)));
}
function cumulativeThroughDay(entries, day){
  return entries.filter(e => entryDay(e.date) <= day).reduce((s,e)=> s + e.amount, 0);
}

function computeLeaderboard(entries, names){
  const totals = {};
  (names || []).forEach(name => { totals[name] = 0; });
  entries.forEach(e => {
    const name = e.seller || 'Unassigned';
    totals[name] = (totals[name] || 0) + e.amount;
  });
  return Object.entries(totals)
    .map(([name, amount]) => ({ name, amount }))
    .sort((a, b) => b.amount - a.amount);
}

/**
 * Core stats for ONE target — the whole team's plan, or a single seller's
 * personal target. allEntries should already be scoped (team entries, or
 * one seller's own entries) before calling this.
 */
/* A seller who starts mid-month gets a fair share of the monthly plan:
   plan ÷ days in month × days from the start date to month end.
   Before the start month: not working yet (plan 0). After it: full plan. */
function planForMonth(plan, monthKey, startDate){
  const info = monthInfoFor(monthKey);
  const dim = info.daysInMonth;
  const full = { plan: plan, full: plan, startDay: 1, days: dim, dim: dim, prorated: false, notStarted: false };
  if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return full;
  const sm = startDate.slice(0, 7);
  if (sm < monthKey) return full;
  if (sm > monthKey) return { plan: 0, full: plan, startDay: dim + 1, days: 0, dim: dim, prorated: false, notStarted: true };
  const startDay = Number(startDate.slice(8, 10));
  if (startDay <= 1) return full;
  const days = dim - startDay + 1;
  return { plan: Math.round(plan * days / dim), full: plan, startDay: startDay, days: days, dim: dim, prorated: true, notStarted: false };
}

/* opts.startDay: first working day in this month (mid-month starters) — the
   pace, the per-day need and the forecast only count days from then on. */
function computeStats(allEntries, plan, monthKey, opts){
  opts = opts || {};
  const now = new Date();
  const current = getMonthInfo(now);
  // A past month is "closed": every day has happened, nothing is left to forecast.
  const closed = !!monthKey && monthKey < current.monthKey;
  const info = closed ? monthInfoFor(monthKey) : current;
  if (closed) info.dayOfMonth = info.daysInMonth;
  info.closed = closed;
  const entries = monthEntries(allEntries, info.monthKey);
  const totalSold = entries.reduce((s,e)=> s + e.amount, 0);
  const remaining = Math.max(plan - totalSold, 0);
  const startDay = Math.min(Math.max(1, Number(opts.startDay) || 1), info.daysInMonth + 1);
  if (closed) return Object.assign(closedStats(info, entries, plan, totalSold, remaining, startDay), { startDay });
  const daysLeft = Math.max(info.daysInMonth - Math.max(info.dayOfMonth, startDay) + 1, 0);
  const dailyTarget = daysLeft > 0 ? remaining / daysLeft : 0;
  const pctComplete = plan > 0 ? (totalSold / plan * 100) : 0;

  // Recent pace: average daily sales over the last up to 7 elapsed days.
  const RECENT_WINDOW = 7;
  const windowStart = Math.max(startDay, info.dayOfMonth - RECENT_WINDOW + 1);
  const recentDays = Math.max(info.dayOfMonth - windowStart + 1, 0);
  const recentSum = entries
    .filter(e => { const day = entryDay(e.date); return day >= windowStart && day <= info.dayOfMonth; })
    .reduce((s,e)=> s + e.amount, 0);
  const recentAvgDaily = recentDays > 0 ? recentSum / recentDays : 0;

  const daysRemainingAfterToday = Math.max(info.daysInMonth - Math.max(info.dayOfMonth, startDay - 1), 0);
  const forecastTotal = totalSold + recentAvgDaily * daysRemainingAfterToday;
  const forecastPct = plan > 0 ? (forecastTotal / plan * 100) : 0;
  const paceStatus = forecastPct >= 100 ? 'good' : (forecastPct >= 80 ? 'warn' : 'bad');

  const planReached = remaining <= 0;
  const paceRatio = dailyTarget > 0 ? recentAvgDaily / dailyTarget : 1;
  const neededStatus = planReached ? 'good' : (paceRatio >= 1 ? 'good' : (paceRatio >= 0.7 ? 'warn' : 'bad'));

  const decades = DECADES.map((d, idx) => {
    const endDay = decadeEnd(idx, info.daysInMonth);
    const targetAmount = plan * d.pct;
    let status, extra = {};
    if (info.dayOfMonth > endDay){
      const cum = cumulativeThroughDay(entries, endDay);
      const diff = cum - targetAmount;
      status = diff >= 0 ? 'achieved' : 'missed';
      extra = { cumAtEnd: cum, diff };
    } else {
      // Not yet passed: every so'm sold from today onward counts toward
      // this decade's cumulative target, so spread the gap over ALL days
      // left until the decade's end date (not just its own window length).
      const daysUntilEnd = Math.max(endDay - info.dayOfMonth + 1, 1);
      const remainingForReward = targetAmount - totalSold;
      const isActiveWindow = info.dayOfMonth >= d.start;
      status = remainingForReward <= 0 ? 'achieved' : (isActiveWindow ? 'active' : 'upcoming');
      extra = {
        remainingForReward: Math.max(remainingForReward, 0),
        daysLeftInDecade: daysUntilEnd,
        dailyNeeded: remainingForReward > 0 ? remainingForReward / daysUntilEnd : 0,
        aheadBy: remainingForReward < 0 ? -remainingForReward : 0,
        daysUntilStart: Math.max(d.start - info.dayOfMonth, 0),
      };
    }
    return { ...d, idx, endDay, targetAmount, status, ...extra };
  });

  return {
    info, entries, plan, totalSold, remaining, daysLeft, dailyTarget, pctComplete, decades,
    recentAvgDaily, recentDays, forecastTotal, forecastPct, paceStatus, paceRatio, neededStatus,
    startDay, started: info.dayOfMonth >= startDay,
  };
}

function closedStats(info, entries, plan, totalSold, remaining, startDay){
  const workDays = Math.max(info.daysInMonth - (startDay || 1) + 1, 1);
  const pctComplete = plan > 0 ? (totalSold / plan * 100) : 0;
  const paceStatus = pctComplete >= 100 ? 'good' : (pctComplete >= 80 ? 'warn' : 'bad');
  const decades = DECADES.map((d, idx) => {
    const endDay = decadeEnd(idx, info.daysInMonth);
    const targetAmount = plan * d.pct;
    const cum = cumulativeThroughDay(entries, endDay);
    const diff = cum - targetAmount;
    return { ...d, idx, endDay, targetAmount, status: diff >= 0 ? 'achieved' : 'missed', cumAtEnd: cum, diff };
  });
  const byDay = {};
  entries.forEach(e => { const k = entryDay(e.date); byDay[k] = (byDay[k] || 0) + e.amount; });
  const bestDay = Object.keys(byDay).reduce((b, k) => (byDay[k] > (b ? byDay[b] : -1) ? k : b), null);
  return {
    info, entries, plan, totalSold, remaining, daysLeft: 0, dailyTarget: 0, pctComplete, decades,
    recentAvgDaily: totalSold / workDays, recentDays: workDays, started: true,
    forecastTotal: totalSold, forecastPct: pctComplete, paceStatus, paceRatio: 1,
    neededStatus: remaining <= 0 ? 'good' : 'bad', closed: true,
    bestDay: bestDay ? { day: Number(bestDay), amount: byDay[bestDay] } : null,
    activeDays: Object.keys(byDay).length,
  };
}

/* ---------- plans per month ----------
   payConfigs: [{ month: 'YYYY-MM', config }] sorted; a month uses the latest
   row at or before it. payBase: rules before any row was saved. */
function effectivePayConfig(payConfigs, payBase, monthKey){
  let found = null;
  (payConfigs || []).forEach(r => { if (r.month <= monthKey) found = r.config; });
  return found || payBase || null;
}
/* A seller's category, plan and pay tiers in one month's rules. */
function sellerPayInfo(cfg, name){
  const a = (cfg && cfg.sellers && cfg.sellers[name]) || { cat: '', plan: 0 };
  const cat = cfg && cfg.categories && cfg.categories[a.cat] ? a.cat : '';
  const own = Number(a.plan) > 0;
  const plan = own ? Number(a.plan) : (cat ? Number(cfg.categories[cat].plan) || 0 : 0);
  return { cat, plan, own, tiers: cat ? cfg.categories[cat].tiers : null };
}

/* ---------- pay (salary) tiers ----------
   tiers: [{ from: 0, fix, pct }, { from: 40, ... }] sorted by "from" (% of plan).
   The tier is the last one whose "from" the seller has reached; its % applies
   to ALL sales of the month. Leader tiers use "bonus" instead of "fix". */
function payTierIndex(sold, plan, tiers){
  let idx = 0;
  for (let i = 0; i < tiers.length; i++){
    // compare amounts, not rounded percentages: 20 000 000 of 50 000 000 is exactly 40%
    if (sold * 100 >= plan * tiers[i].from) idx = i;
  }
  return idx;
}
function computePay(sold, plan, tiers, kind){
  if (!tiers || !tiers.length || !(plan > 0)) return null;
  const index = payTierIndex(sold, plan, tiers);
  const tier = tiers[index];
  const fixed = kind === 'leader' ? (Number(tier.bonus) || 0) : (Number(tier.fix) || 0);
  const commission = sold * (Number(tier.pct) || 0) / 100;
  const next = tiers[index + 1] || null;
  const toNext = next ? Math.max(Math.ceil(plan * next.from / 100 - sold), 0) : 0;
  let nextTotal = 0;
  if (next){
    const at = plan * next.from / 100;
    nextTotal = (kind === 'leader' ? (Number(next.bonus) || 0) : (Number(next.fix) || 0)) + at * (Number(next.pct) || 0) / 100;
  }
  return { pct: sold / plan * 100, index, tier, fixed, commission, total: fixed + commission, next, toNext, nextTotal, plan, sold };
}

function expectedRewardPct(day, daysInMonth){
  const pts = [[1,0],[10,25],[20,55],[daysInMonth,80]];
  for (let i=0;i<pts.length-1;i++){
    const [d0,p0] = pts[i], [d1,p1] = pts[i+1];
    if (day >= d0 && day <= d1){
      const t = (day-d0) / ((d1-d0) || 1);
      return p0 + t*(p1-p0);
    }
  }
  return pts[pts.length-1][1];
}

/* Short money label for tight spaces: 16 300 000 -> "16.3M". */
function fmtShort(n){
  const v = Number(n);
  if (!isFinite(v)) return '—';
  const a = Math.abs(v);
  const trim = (x) => (Math.round(x * 10) / 10).toString().replace(/\.0$/, '');
  if (a >= 1e9) return trim(v / 1e9) + paceT('B');
  if (a >= 1e6) return trim(v / 1e6) + paceT('M');
  if (a >= 1e3) return Math.round(v / 1e3) + paceT('K');
  return String(Math.round(v));
}

let chartSeq = 0;
/* Cumulative pace chart. Colours come from CSS classes (ch-*), so it follows
   the dark/light theme. Renders a wide and a compact version; CSS shows the
   one that fits the screen. */
/* opts.reward: draw the team 25/55/80% reward line (team charts only).
   opts.guides: extra % lines, e.g. a seller's pay tiers [40, 70, 100, 130]. */
function buildChart(stats, opts){
  opts = opts || {};
  return `<div class="chart">${buildChartSvg(stats, false, opts)}${buildChartSvg(stats, true, opts)}</div>`;
}
function buildChartSvg(stats, compact, opts){
  opts = opts || {};
  const showReward = opts.reward !== false;
  const closed = !!stats.closed;
  const { info, entries, plan } = stats;
  const dim = info.daysInMonth;
  const W = compact ? 360 : 880, H = compact ? 250 : 270;
  const padL = compact ? 36 : 46, padR = compact ? 10 : 18, padT = 18, padB = 30;
  const fs = compact ? 12 : 12;
  const chartW = W - padL - padR, chartH = H - padT - padB;
  const maxPct = Math.max(100, Math.ceil((Math.max(stats.pctComplete, stats.forecastPct) + 8) / 10) * 10);
  const x = (day) => padL + (day - 1) / Math.max(dim - 1, 1) * chartW;
  const y = (pct) => padT + chartH - (Math.min(Math.max(pct, 0), maxPct) / maxPct) * chartH;
  const f = (n) => n.toFixed(1);
  const gid = 'chg' + (++chartSeq);

  const marks = showReward ? [25, 55, 80] : (opts.guides || []).filter(g => g > 0 && g !== 100);
  const guideSet = Array.from(new Set([0, 100].concat(marks).concat(maxPct > 100 ? [maxPct] : []))).filter(p => p <= maxPct).sort((a, b) => a - b);
  const guides = guideSet.map(p => `
    <line class="ch-grid" x1="${padL}" y1="${f(y(p))}" x2="${W - padR}" y2="${f(y(p))}"/>
    <text class="ch-axis" x="${padL - 7}" y="${f(y(p) + 4)}" text-anchor="end" font-size="${fs}">${p}%</text>`).join('');
  const bounds = [10, 20].filter(d => d < dim).map(d =>
    `<line class="ch-bound" x1="${f(x(d))}" y1="${padT}" x2="${f(x(d))}" y2="${H - padB}"/>`).join('');
  const dayTicks = (compact ? [1, 10, 20, dim] : [1, 5, 10, 15, 20, 25, dim]).filter((d, i, a) => a.indexOf(d) === i && d <= dim).map(d =>
    `<text class="ch-axis" x="${f(x(d))}" y="${H - padB + 19}" text-anchor="middle" font-size="${fs}">${d}</text>`).join('');

  const rewardPath = [[1, 0], [10, 25], [20, 55], [dim, 80]].map(([d, p], i) => `${i ? 'L' : 'M'} ${f(x(d))} ${f(y(p))}`).join(' ');
  const sd = Math.min(Math.max(1, stats.startDay || 1), dim);
  const planPath = `M ${f(x(sd))} ${f(y(0))} L ${f(x(dim))} ${f(y(100))}`;

  const byDay = {};
  entries.forEach(e => { const d = entryDay(e.date); byDay[d] = (byDay[d] || 0) + e.amount; });
  let running = 0;
  const pts = [[1, 0]];
  for (let d = 1; d <= info.dayOfMonth; d++){
    running += byDay[d] || 0;
    pts.push([d, plan > 0 ? running / plan * 100 : 0]);
  }
  const actualPath = pts.map(([d, p], i) => `${i ? 'L' : 'M'} ${f(x(d))} ${f(y(p))}`).join(' ');
  const last = pts[pts.length - 1];
  const areaPath = `${actualPath} L ${f(x(last[0]))} ${f(y(0))} L ${f(x(1))} ${f(y(0))} Z`;
  const expected = showReward ? expectedRewardPct(info.dayOfMonth, dim)
    : (Math.max(info.dayOfMonth - sd + 1, 0) / Math.max(dim - sd + 1, 1) * 100) * 0.8;
  const tone = closed ? (stats.pctComplete >= 100 ? 'good' : 'bad') : (stats.pctComplete >= expected ? 'good' : 'bad');
  const forecastPath = `M ${f(x(info.dayOfMonth))} ${f(y(stats.pctComplete))} L ${f(x(dim))} ${f(y(stats.forecastPct))}`;
  const tx = x(info.dayOfMonth);

  return `
  <svg class="${compact ? 'chart-compact' : 'chart-wide'}" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${paceT('Cumulative sales: {pct}% of plan by day {day}, forecast {fc}%', { pct: stats.pctComplete.toFixed(0), day: info.dayOfMonth, fc: stats.forecastPct.toFixed(0) })}">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" class="ch-area-top ${tone}"/><stop offset="100%" class="ch-area-bottom"/>
    </linearGradient></defs>
    ${guides}${bounds}${dayTicks}
    ${closed ? '' : `<line class="ch-today" x1="${f(tx)}" y1="${padT}" x2="${f(tx)}" y2="${H - padB}"/>
    <text class="ch-today-label" x="${f(Math.min(Math.max(tx, padL + 18), W - padR - 18))}" y="${padT - 5}" text-anchor="middle" font-size="${fs - 1}">${paceT('Today')}</text>`}
    ${sd > 1 ? `<line class="ch-bound" x1="${f(x(sd))}" y1="${padT}" x2="${f(x(sd))}" y2="${H - padB}"/><text class="ch-today-label" x="${f(x(sd) + 4)}" y="${padT + 12}" text-anchor="start" font-size="${fs - 1}">${paceT('Start')}</text>` : ''}
    <path class="ch-plan" d="${planPath}"/>
    ${showReward ? `<path class="ch-reward" d="${rewardPath}"/>` : ''}
    <path d="${areaPath}" fill="url(#${gid})" stroke="none"/>
    ${closed ? '' : `<path class="ch-forecast ${stats.paceStatus}" d="${forecastPath}"/>
    <circle class="ch-dot ch-forecast-dot ${stats.paceStatus}" cx="${f(x(dim))}" cy="${f(y(stats.forecastPct))}" r="4"/>`}
    <path class="ch-actual ${tone}" d="${actualPath}"/>
    <circle class="ch-dot ch-actual-dot ${tone}" cx="${f(x(last[0]))}" cy="${f(y(last[1]))}" r="5"/>
  </svg>`;
}

/* ---------- daily sales (bars) + call time (line) ----------
   days: [{ day, sales, minutes }] for every day of the month.
   lastDay: the last day that has happened (later days are left empty). */
function fmtHM(min){
  const m = Math.max(0, Math.round(Number(min) || 0));
  return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0');
}
function niceCeil(v){
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * p;
}
/* firstDay: a mid-month starter's first day — the call line starts there. */
function buildSalesCallsChart(days, lastDay, firstDay){
  return `<div class="chart">${salesCallsSvg(days, lastDay, false, firstDay || 1)}${salesCallsSvg(days, lastDay, true, firstDay || 1)}</div>`;
}
function salesCallsSvg(days, lastDay, compact, firstDay){
  const dim = days.length;
  const W = compact ? 360 : 880, H = compact ? 240 : 260;
  const padL = compact ? 38 : 52, padR = compact ? 40 : 52, padT = 14, padB = 30;
  const fs = 12;
  const cw = W - padL - padR, chH = H - padT - padB;
  const band = cw / dim;
  const f = (n) => n.toFixed(1);
  // four even steps on both axes, each step a round number
  const maxSales = niceCeil(Math.max(1000000, ...days.map(d => d.sales)) * 1.05 / 4) * 4;
  const maxMinRaw = Math.max(60, ...days.map(d => d.minutes)) * 1.05 / 4;
  const minStep = [15, 30, 45, 60, 90, 120, 180, 240, 300, 360, 480, 600, 720].find(v => v >= maxMinRaw) || Math.ceil(maxMinRaw / 60) * 60;
  const maxMin = minStep * 4;
  const xc = (day) => padL + (day - 0.5) * band;
  const yS = (v) => padT + chH - (v / maxSales) * chH;
  const yM = (v) => padT + chH - (v / maxMin) * chH;
  const grid = [0, 0.25, 0.5, 0.75, 1].map(k => `
    <line class="ch-grid" x1="${padL}" y1="${f(padT + chH - k * chH)}" x2="${W - padR}" y2="${f(padT + chH - k * chH)}"/>
    <text class="ch-axis" x="${padL - 6}" y="${f(padT + chH - k * chH + 4)}" text-anchor="end" font-size="${fs}">${k ? fmtShort(maxSales * k) : '0'}</text>
    <text class="ch-axis cc-axis-r" x="${W - padR + 6}" y="${f(padT + chH - k * chH + 4)}" text-anchor="start" font-size="${fs}">${fmtHM(maxMin * k)}</text>`).join('');
  const tickEvery = compact ? 5 : (dim > 15 ? 2 : 1);
  const ticks = days.filter(d => d.day === 1 || d.day % tickEvery === (compact ? 0 : 1) || d.day === dim)
    .map(d => `<text class="ch-axis" x="${f(xc(d.day))}" y="${H - padB + 18}" text-anchor="middle" font-size="${fs}">${d.day}</text>`).join('');
  const bw = Math.max(2, band * 0.62);
  const bars = days.filter(d => d.sales > 0).map(d =>
    `<rect class="cc-bar" x="${f(xc(d.day) - bw / 2)}" y="${f(yS(d.sales))}" width="${f(bw)}" height="${f(padT + chH - yS(d.sales))}" rx="2"/>`).join('');
  const upto = days.filter(d => d.day <= lastDay && d.day >= firstDay);
  const line = upto.length ? `<path class="cc-line" d="${upto.map((d, i) => `${i ? 'L' : 'M'} ${f(xc(d.day))} ${f(yM(d.minutes))}`).join(' ')}"/>` : '';
  const dots = upto.map(d => `<circle class="cc-dot ${d.minutes ? '' : 'zero'}" cx="${f(xc(d.day))}" cy="${f(yM(d.minutes))}" r="${compact ? 3 : 4}"/>`).join('');
  const hits = days.map(d => `<rect class="cc-hit" x="${f(xc(d.day) - band / 2)}" y="${padT}" width="${f(band)}" height="${chH}"><title>${paceT('Day {d}', { d: d.day })}: ${fmt(d.sales)} so'm · ${paceT('calls')} ${fmtHM(d.minutes)}</title></rect>`).join('');
  return `
  <svg class="${compact ? 'chart-compact' : 'chart-wide'}" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${paceT('Daily sales and call time')}">
    ${grid}${ticks}${bars}${line}${dots}${hits}
  </svg>`;
}

/**
 * Classifies a seller into one of four states using signals already
 * computed by computeStats (forecastPct/paceStatus), plus two simple
 * derived facts the caller supplies. This is deliberately NOT a full
 * momentum/trend system — just a transparent read of existing numbers.
 *   options.daysSinceLastSale: number|null — null if never sold
 *   options.compliantToday: true|false|null — null if no standards defined
 */
function classifyRisk(stats, options){
  options = options || {};
  const daysSinceLastSale = options.daysSinceLastSale;
  const compliantToday = options.compliantToday;
  const stale = daysSinceLastSale != null && daysSinceLastSale >= 3;

  const L = { ontrack: paceT('On track'), needsattention: paceT('Needs attention'), atrisk: paceT('At risk'), critical: paceT('Critical') };
  const fc = Math.round(stats.forecastPct);
  if (stats.remaining <= 0){
    if (compliantToday === false){
      return { level: 'needsattention', label: L.needsattention, reason: paceT("Plan reached, but missed today's standards.") };
    }
    return { level: 'ontrack', label: L.ontrack, reason: paceT('Plan already reached.') };
  }
  if (stats.paceStatus === 'bad' && (stats.forecastPct < 50 || stale)){
    return {
      level: 'critical', label: L.critical,
      reason: stale
        ? paceT('No sales logged in {n} days.', { n: daysSinceLastSale })
        : paceT('Forecast ({fc}%) is far below plan at the current pace.', { fc }),
    };
  }
  if (stats.paceStatus === 'bad'){
    return { level: 'atrisk', label: L.atrisk, reason: paceT('Current pace is not enough to reach the plan (forecast {fc}%).', { fc }) };
  }
  if (stats.paceStatus === 'warn' && compliantToday === false){
    return { level: 'atrisk', label: L.atrisk, reason: paceT("Behind pace, and missed today's standards.") };
  }
  if (stats.paceStatus === 'warn'){
    return { level: 'needsattention', label: L.needsattention, reason: paceT('Trending slightly below plan (forecast {fc}%).', { fc }) };
  }
  if (compliantToday === false){
    return { level: 'needsattention', label: L.needsattention, reason: paceT("On pace, but missed today's standards.") };
  }
  return { level: 'ontrack', label: L.ontrack, reason: paceT('On pace to hit the plan.') };
}

/** Most recent date (YYYY-MM-DD) among a seller's own entries, or null. */
function lastSaleDate(entries){
  if (!entries.length) return null;
  return entries.reduce((max, e) => (String(e.date) > max ? String(e.date) : max), entries[0].date);
}
function daysBetween(dateStrEarlier, dateStrLater){
  const a = new Date(dateStrEarlier + 'T00:00:00');
  const b = new Date(dateStrLater + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

/* ---------- number input formatting (thousands separators live) ---------- */

/* Reformats as you type ("5000000" -> "5 000 000") and keeps the caret next
   to the same digit, so fixing a digit in the middle doesn't jump to the end. */
function formatThousandsLive(inputEl){
  const raw = String(inputEl.value);
  let caret = null;
  try{ caret = inputEl.selectionStart; }catch(e){ caret = null; }
  const digitsBefore = caret == null ? null : raw.slice(0, caret).replace(/[^\d]/g, '').length;
  let digits = raw.replace(/[^\d]/g, '');
  const stripped = digits.length - digits.replace(/^0+(?=\d)/, '').length;
  digits = digits.slice(stripped, stripped + 15);
  const formatted = digits ? Number(digits).toLocaleString('ru-RU') : '';
  if (formatted === raw) return formatted;
  inputEl.value = formatted;
  if (digitsBefore != null && typeof document !== 'undefined' && document.activeElement === inputEl){
    const want = Math.max(0, digitsBefore - stripped);
    let pos = 0, seen = 0;
    while (pos < formatted.length && seen < want){ if (/\d/.test(formatted[pos])) seen++; pos++; }
    try{ inputEl.setSelectionRange(pos, pos); }catch(e){}
  }
  return formatted;
}
function parseFormattedNumber(str){
  return Number(String(str).replace(/[^\d]/g, '')) || 0;
}

function statusLabel(status){
  return paceT({ upcoming: 'Upcoming', active: 'Active', achieved: 'Achieved', missed: 'Missed' }[status]);
}

function decadeProgress(d){
  if (!(d.targetAmount > 0)) return 0;
  if (d.cumAtEnd !== undefined) return Math.min(Math.max(d.cumAtEnd / d.targetAmount, 0), 1);
  return Math.min(Math.max((d.targetAmount - d.remainingForReward) / d.targetAmount, 0), 1);
}
function renderDecadeCard(d){
  const pctPlan = Math.round(d.pct * 100);
  const days = (n) => paceT(n === 1 ? '{n} day' : '{n} days', { n });
  const prog = decadeProgress(d);
  const label = paceT(d.label);
  let main = '', detail = '';
  if (d.cumAtEnd !== undefined){
    main = d.status === 'achieved'
      ? paceT('Hit {a} · {b} over', { a: fmtShort(d.cumAtEnd), b: fmtShort(d.diff) })
      : paceT('Hit {a} · {b} short', { a: fmtShort(d.cumAtEnd), b: fmtShort(Math.abs(d.diff)) });
    detail = d.status === 'achieved' ? paceT('Reward earned') : paceT('Reward missed');
  } else if (d.status === 'achieved'){
    main = paceT('Secured · {a} ahead', { a: fmtShort(d.aheadBy) });
    detail = d.daysUntilStart > 0 ? paceT('Already reached · opens in {d}', { d: days(d.daysUntilStart) }) : paceT('{d} left in this window', { d: days(d.daysLeftInDecade) });
  } else if (d.status === 'active'){
    main = paceT('{a}/day', { a: fmtShort(d.dailyNeeded) });
    detail = paceT('{a} left · {d} to go', { a: fmtShort(d.remainingForReward), d: days(d.daysLeftInDecade) });
  } else {
    main = paceT('{a}/day', { a: fmtShort(d.dailyNeeded) });
    detail = paceT('From today until day {e} · opens in {d}', { e: d.endDay, d: days(d.daysUntilStart) });
  }
  return `
    <div class="decade-card is-${d.status}">
      <div class="d-head">
        <div>
          <div class="d-title">${label}</div>
          <div class="d-pct">${paceT(d.short)} · ${paceT('{p}% of plan', { p: pctPlan })}</div>
        </div>
        <span class="pill ${d.status}">${statusLabel(d.status)}</span>
      </div>
      <div class="d-main num">${main}</div>
      <div class="d-target num">${fmtShort(Math.min(prog, 1) * d.targetAmount)} / ${fmtShort(d.targetAmount)} so'm</div>
      <div class="d-bar" role="progressbar" aria-valuenow="${Math.round(prog * 100)}" aria-valuemin="0" aria-valuemax="100" aria-label="${label}"><span style="width:${(prog * 100).toFixed(1)}%"></span></div>
      <div class="d-detail">${detail}</div>
    </div>`;
}
