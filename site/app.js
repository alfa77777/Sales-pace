/* ============================================================
   Sales Pace — single-page app (v3: pay plans, history, Uzbek)
   One site and one login for everyone:
     · guests see the team dashboard and leaderboard
     · sellers get their sales, pay, entries and daily standards
     · the admin (team leader) gets everything, plus a workspace for
       every seller, salaries, and the pay-plan editor
   Routes live in the URL hash: #/dashboard, #/seller?name=Malika&tab=entries
   Runs against Google Apps Script, or against the in-browser demo backend
   when window.SalesPaceDemo is present (sales-pace-demo.html).
   Calculations come from pace-lib.js; Uzbek text from i18n.js (UZ).
   ============================================================ */

const DEMO = typeof window !== 'undefined' && !!window.SalesPaceDemo;
const SCRIPT_URL = (typeof window !== 'undefined' && window.SALES_PACE_SCRIPT_URL) || '';
const REFRESH_MS = 20000;
const SESSION_KEY = DEMO ? 'salesPace.demoSession.v1' : 'salesPace.session.v1';
const THEME_KEY = 'salesPace.theme';
const LANG_KEY = 'salesPace.lang';
const BULK_LIMIT = 200;
const AMOUNT_LIMIT = 1e12;
const CLASSES = ['C', 'G', 'O', 'A', 'B'];
const CATS = ['C', 'OTHER'];

function isConfigured(){ return DEMO || (!!SCRIPT_URL && SCRIPT_URL.indexOf('PASTE_YOUR') === -1); }

/* ---------- safe storage (blocked in some sandboxes / private modes) ---------- */

function storeGet(k){ try{ return window.localStorage.getItem(k); }catch(e){ return null; } }
function storeSet(k, v){ try{ window.localStorage.setItem(k, v); }catch(e){} }
function storeDel(k){ try{ window.localStorage.removeItem(k); }catch(e){} }

/* ---------- language ---------- */

let lang = storeGet(LANG_KEY) === 'uz' ? 'uz' : 'en';
const UZ_DICT = (typeof UZ !== 'undefined' && UZ) || {};
/* t('English text {name}', { name }) — English is the key; Uzbek comes from i18n.js. */
function t(s, vars){
  let out = s;
  if (lang === 'uz'){
    if (Object.prototype.hasOwnProperty.call(UZ_DICT, s)) out = UZ_DICT[s];
    else if (typeof MISSING_UZ !== 'undefined' && s && /[A-Za-z]{2}/.test(s)) MISSING_UZ.add(s);
  }
  if (vars) out = String(out).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
  return out;
}
window.paceTranslate = t;
/* Count phrases: cnt(3, '{n} day', '{n} days'). Uzbek needs no plural form. */
function cnt(n, one, many){ return t(n === 1 ? one : many, { n }); }
const MONTHS = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  uz: ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'],
};
const MONTHS_SHORT = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  uz: ['yan', 'fev', 'mar', 'apr', 'may', 'iyn', 'iyl', 'avg', 'sen', 'okt', 'noy', 'dek'],
};
const WEEKDAYS = {
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  uz: ['Ya', 'Du', 'Se', 'Ch', 'Pa', 'Ju', 'Sh'],
};
function monthName(m){ return MONTHS[lang][m]; }
function monthLabel(key){ const p = String(key).split('-').map(Number); return monthName(p[1] - 1) + ' ' + p[0]; }
function setLang(l){
  if (l !== 'en' && l !== 'uz') return;
  lang = l;
  storeSet(LANG_KEY, l);
  document.documentElement.setAttribute('lang', l);
  render();
}
function toggleLang(){ setLang(lang === 'en' ? 'uz' : 'en'); }

/* Server messages arrive in English; show them in the chosen language. */
const hasUz = (k) => Object.prototype.hasOwnProperty.call(UZ_DICT, k);
const MISSING_UZ = new Set(); // filled while browsing in Uzbek; used by the tests
function trServer(msg){
  msg = String(msg || '');
  if (lang !== 'uz') return msg;
  if (hasUz(msg)) return UZ_DICT[msg];
  let m;
  if ((m = msg.match(/^(New p|P)assword must be at least (\d+) characters\.$/))) return t(m[1] === 'P' ? 'Password must be at least {n} characters.' : 'New password must be at least {n} characters.', { n: m[2] });
  if ((m = msg.match(/^Unknown seller: (.*)\.$/))) return t('Unknown seller: {name}.', { name: m[1] });
  if ((m = msg.match(/^(.*) appears twice\. Combine the amounts into one row\.$/))) return t('{name} appears twice. Combine the amounts into one row.', { name: m[1] });
  if ((m = msg.match(/^Too many rows in one save \(max (\d+)\)\.$/))) return t('Too many rows in one save (max {n}).', { n: m[1] });
  if ((m = msg.match(/^A pay table can have at most (\d+) rows\.$/))) return t('A pay table can have at most {n} rows.', { n: m[1] });
  if ((m = msg.match(/^Server error: (.*)$/))) return t('Server error: {e}', { e: m[1] });
  if ((m = msg.match(/^([^:]+): (.+)$/))){
    const rest = m[2].charAt(0).toUpperCase() + m[2].slice(1);
    if (hasUz(m[2])) return m[1] + ': ' + UZ_DICT[m[2]];
    if (hasUz(rest)) return m[1] + ': ' + UZ_DICT[rest];
  }
  MISSING_UZ.add('server: ' + msg);
  return msg;
}

/* ---------- state ---------- */

const data = { plan: 0, sellers: [], entries: [], standards: [], activity: [], calls: [], auditLog: [], adminExists: true, payConfigs: [], payBase: null };
let callIndex = new Map();
let dataVersion = 0;
let activityIndex = new Map();
let loaded = false;
let loading = false;
let syncError = null;
let lastSynced = null;
let loadSeq = 0;
let appliedSeq = 0;

let session = readSession(); // { token, role, name, exp }
let route = { name: 'dashboard', params: {} };
let afterLogin = null;
let sidebarOpen = false;

let busy = false;
let pendingKey = null;
let errors = {};
let authBusy = false;
let authBanner = null;
let modal = null;
let toastState = null;
let toastTimer = null;
let focusAfter = null;
const resetFields = new Set();
const pendingRequests = {};

const ui = {
  month: currentMonthKey(),
  openRiskLevel: 'auto',
  editingEntryId: null,
  editingStandardName: null,
  activityDate: {},
  complianceDate: '',
  entrySeller: '',
  entryPeriod: 'month',
  entriesTab: 'list',
  bulkDate: '',
  settingsTab: 'pay',
  teamQuery: '',
  teamFilter: 'all',
  keepSaleOpen: false,
  newSellerLogin: true,
  payMonth: '',
  payDraft: null,
};
function resetEditing(){
  ui.editingEntryId = null;
  ui.editingStandardName = null;
}

/* ---------- small helpers ---------- */

function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function jsArg(s){ return esc(JSON.stringify(String(s == null ? '' : s))); }
function val(id){ const el = document.getElementById(id); return el ? String(el.value) : ''; }
function isChecked(id){ const el = document.getElementById(id); return !!(el && el.checked); }
function newRequestId(){ return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }
function isDateStr(s){ return /^\d{4}-\d{2}-\d{2}$/.test(s); }
function initial(name){ return String(name || '?').trim().charAt(0).toUpperCase() || '?'; }
function money(n){ return fmt(n) + " so'm"; }
function pctText(p){ return (Math.round(p * 10) / 10).toString().replace(/\.0$/, '') + '%'; }
function sellerByName(name){ return data.sellers.find(s => s.name === name) || null; }
function sellerNames(){ return data.sellers.map(s => s.name); }
function sumAmounts(list){ return list.reduce((s, e) => s + e.amount, 0); }
function parseYmd(s){ const p = String(s).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
function ymdOf(d){ return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function addDaysStr(s, n){ const d = parseYmd(s); d.setDate(d.getDate() + n); return ymdOf(d); }
function currentMonthKey(){ return todayStr().slice(0, 7); }
function addMonths(key, n){
  const p = key.split('-').map(Number);
  const d = new Date(p[0], p[1] - 1 + n, 1);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1);
}
function dayLabel(s){
  const d = parseYmd(s);
  if (isNaN(d.getTime())) return esc(s);
  if (lang === 'uz') return `${WEEKDAYS.uz[d.getDay()]}, ${d.getDate()}-${MONTHS_SHORT.uz[d.getMonth()]}`;
  return `${WEEKDAYS.en[d.getDay()]}, ${d.getDate()} ${MONTHS_SHORT.en[d.getMonth()]}`;
}
function shortDay(s){
  const d = parseYmd(s);
  return lang === 'uz' ? `${d.getDate()}-${MONTHS_SHORT.uz[d.getMonth()]}` : `${d.getDate()} ${MONTHS_SHORT.en[d.getMonth()]}`;
}
function weekday(s){ return WEEKDAYS[lang][parseYmd(s).getDay()]; }
function newestFirst(list){
  return list.map((e, i) => [e, i])
    .sort((a, b) => String(b[0].date).localeCompare(String(a[0].date)) || b[1] - a[1])
    .map(x => x[0]);
}
function requestIdFor(key, fp){
  const p = pendingRequests[key];
  if (p && p.fp === fp) return p.id;
  const id = newRequestId();
  pendingRequests[key] = { fp, id };
  return id;
}
function clearRequest(key){ if (key) delete pendingRequests[key]; }
function errorHtml(key){
  return errors[key] ? `<div class="banner banner-error" role="alert">${esc(errors[key])}</div>` : '';
}
function fail(key, text){ errors[key] = text; render(); return null; }

/* ---------- pay plans ---------- */

function cfgFor(month){
  return effectivePayConfig(data.payConfigs, data.payBase, month)
    || { teamPlan: data.plan || 0, leaderPlan: 0, categories: {}, leader: { tiers: [] }, sellers: {} };
}
function teamPlanFor(month){ return Number(cfgFor(month).teamPlan) || 0; }
function leaderPlanFor(month){ const c = cfgFor(month); return Number(c.leaderPlan) > 0 ? Number(c.leaderPlan) : (Number(c.teamPlan) || 0); }
/* A seller's category, tiers and plan for one month. plan is the FAIR plan:
   prorated by days worked when they started mid-month (fullPlan = whole month). */
function sellerInfo(name, month){
  const base = sellerPayInfo(cfgFor(month), name);
  const s = sellerByName(name);
  const pf = planForMonth(base.plan, month, s ? s.startDate : '');
  return Object.assign({}, base, { fullPlan: base.plan, plan: pf.plan, pf, _start: s ? s.startDate : '' });
}
function sellerStats(name, month){
  const info = sellerInfo(name, month);
  return computeStats(data.entries.filter(e => e.seller === name), info.plan, month, { startDay: info.pf.startDay });
}
function startNote(info, month){
  if (!info.pf) return '';
  if (info.pf.notStarted) return t('Starts on {d}', { d: shortDay(sellerStartOf(info)) });
  if (info.pf.prorated) return t('From {d}: {n} of {m} days', { d: shortDay(month + '-' + pad(info.pf.startDay)), n: info.pf.days, m: info.pf.dim });
  return '';
}
function sellerStartOf(info){ return info && info._start ? info._start : ''; }
function monthSales(month, seller){ return data.entries.filter(e => e.date.startsWith(month) && (!seller || e.seller === seller)); }
function payFor(name, month){
  const info = sellerInfo(name, month);
  if (!info.tiers) return null;
  return computePay(sumAmounts(monthSales(month, name)), info.plan, info.tiers, 'seller');
}
function leaderPayFor(month){
  const c = cfgFor(month);
  return computePay(sumAmounts(monthSales(month)), leaderPlanFor(month), (c.leader || {}).tiers, 'leader');
}
function catLabel(cat){ return cat === 'C' ? t('C · Demo class') : cat === 'OTHER' ? t('Other · G, O, A, B') : t('No category'); }
const CLASS_NAMES = { C: 'Demo class', G: 'Global', O: 'Organic (Telegram, Instagram…)', A: 'Web application · A', B: 'Web application · B' };
function classLabel(c){ return c + ' — ' + t(CLASS_NAMES[c] || ''); }
function classPill(c){ return c ? `<span class="pill cls cls-${c}" title="${esc(t(CLASS_NAMES[c] || ''))}">${c}</span>` : '<span class="muted">—</span>'; }
function defaultClass(name){
  const last = newestFirst(data.entries.filter(e => e.seller === name && e.cls))[0];
  if (last) return last.cls;
  return sellerInfo(name, currentMonthKey()).cat === 'C' ? 'C' : 'O';
}
function classSelect(id, selected, cls, extra){
  return `<select id="${id}" class="${cls || ''}" ${extra || ''}>${CLASSES.map(c => `<option value="${c}" ${c === selected ? 'selected' : ''}>${esc(classLabel(c))}</option>`).join('')}</select>`;
}
function tierRange(tiers, i){
  const from = tiers[i].from;
  const next = tiers[i + 1];
  if (!next) return `${pctText(from)}+`;
  const step = Number.isInteger(from) && Number.isInteger(next.from) ? 1 : 0.1;
  return `${pctText(from).replace('%', '')}–${pctText(next.from - step)}`;
}

/* ---------- icons ---------- */

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
  trophy: '<path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3"/><path d="M7 5H4v2a3 3 0 0 0 3 3"/>',
  chart: '<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
  receipt: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  check: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  checkCircle: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
  settings: '<path d="M4 21v-7"/><path d="M4 10V3"/><path d="M12 21v-9"/><path d="M12 8V3"/><path d="M20 21v-5"/><path d="M20 12V3"/><path d="M1 14h6"/><path d="M9 8h6"/><path d="M17 16h6"/>',
  login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  menu: '<path d="M3 6h18"/><path d="M3 12h18"/><path d="M3 18h18"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
  alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  trendDown: '<path d="M3 7l6 6 4-4 8 8"/><path d="M14 17h7v-7"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7l10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  refresh: '<path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  wallet: '<path d="M20 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-4a2 2 0 0 0 0 4h4v4a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V5"/><path d="M17 14h.01"/>',
  crown: '<path d="M2 18h20"/><path d="m3 7 5 5 4-7 4 7 5-5-2 11H5z"/>',
  chevL: '<path d="m15 18-6-6 6-6"/>',
  chevR: '<path d="m9 18 6-6-6-6"/>',
  pie: '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
};
function icon(name){
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
}

/* ---------- theme ---------- */

function currentTheme(){ return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; }
function applyTheme(th){
  document.documentElement.setAttribute('data-theme', th);
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', th === 'light' ? '#EEF2F8' : '#070B14');
}
function setTheme(th){
  if (th !== 'light' && th !== 'dark') return;
  applyTheme(th);
  storeSet(THEME_KEY, th);
  render();
}
function toggleTheme(){ setTheme(currentTheme() === 'dark' ? 'light' : 'dark'); }

/* ---------- session ---------- */

function readSession(){
  try{
    const s = JSON.parse(storeGet(SESSION_KEY) || 'null');
    if (s && s.token && s.role && s.exp > Date.now()) return s;
  }catch(e){}
  storeDel(SESSION_KEY);
  return null;
}
function saveSession(s){ storeSet(SESSION_KEY, JSON.stringify(s)); }
function clearSession(){ storeDel(SESSION_KEY); }
function isAdmin(){ return !!session && session.role === 'admin'; }
function isSeller(){ return !!session && session.role === 'seller'; }
function endSession(message){
  session = null;
  clearSession();
  resetEditing();
  modal = null;
  data.auditLog = [];
  data.sellers.forEach(s => { s.username = ''; });
  authBanner = message ? { type: 'error', text: message } : null;
}

/* ---------- API ---------- */

function networkErrorText(){
  return DEMO ? t('Something went wrong in the demo. Please try again.')
    : t('Could not reach Google Sheets. Check your connection and try again — retrying won’t save anything twice.');
}
async function apiGet(){
  if (DEMO) return window.SalesPaceDemo.get(session ? session.token : null);
  let url = SCRIPT_URL;
  if (session) url += (url.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(session.token);
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error('Request failed (' + res.status + ')');
  return res.json();
}
async function apiPost(payload, requestId){
  const body = Object.assign({}, payload, { clientRequestId: requestId || newRequestId() });
  if (session) body.token = session.token;
  let json;
  if (DEMO){
    json = await window.SalesPaceDemo.post(body);
  } else {
    const res = await fetch(SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error('Request failed (' + res.status + ')');
    json = await res.json();
  }
  json = json || { ok: false, error: 'Empty response from the server.' };
  if (json.authError && session){
    endSession(t('Your session has ended. Please log in again.'));
    afterLogin = { name: route.name, params: route.params };
    navigate('login');
  }
  return json;
}

function applyData(d){
  data.plan = Number(d.plan) || 0;
  data.sellers = (d.sellers || []).map(s => ({ name: String(s.name), hasLogin: !!s.hasLogin, username: s.username || '', startDate: isDateStr(s.startDate || '') ? s.startDate : '' }));
  data.entries = (d.entries || []).map(e => ({
    id: String(e.id), date: String(e.date), seller: String(e.seller || ''), amount: Number(e.amount) || 0, cls: CLASSES.indexOf(e.cls) !== -1 ? e.cls : '',
  }));
  data.standards = (d.standards || []).map(s => ({ name: String(s.name), unit: String(s.unit || ''), minPerDay: Number(s.minPerDay) || 0 }));
  data.activity = (d.activity || []).map(a => ({ date: String(a.date), seller: String(a.seller), standard: String(a.standard), value: Number(a.value) || 0 }));
  data.auditLog = d.auditLog || [];
  data.adminExists = d.adminExists !== false;
  data.payConfigs = (d.payConfigs || []).slice().sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
  data.payBase = d.payBase || null;
  activityIndex = new Map();
  data.activity.forEach(a => activityIndex.set(a.date + '\u0001' + a.seller + '\u0001' + a.standard, a));
  data.calls = (d.calls || []).map(c => ({ date: String(c.date), seller: String(c.seller), minutes: Number(c.minutes) || 0 }));
  callIndex = new Map();
  data.calls.forEach(c => callIndex.set(c.date + '\u0001' + c.seller, c.minutes));
  dataVersion++;
}
function findActivity(date, seller, standard){ return activityIndex.get(date + '\u0001' + seller + '\u0001' + standard) || null; }
/* Logged call minutes for one seller on one day, or null when nothing was logged. */
function callMinutes(date, seller){ const v = callIndex.get(date + '\u0001' + seller); return v === undefined ? null : v; }

async function load(silent){
  if (!isConfigured()){ render(); return; }
  const seq = ++loadSeq;
  loading = true;
  if (!silent) render();
  let toLogin = false;
  try{
    const d = await apiGet();
    if (seq >= appliedSeq){
      appliedSeq = seq;
      applyData(d);
      if (session){
        if (d.me && d.me.role){
          session.role = d.me.role;
          session.name = d.me.name;
          saveSession(session);
        } else {
          endSession(t('Your session has ended. Please log in again.'));
          if (!canAccess(route.name)){ afterLogin = { name: route.name, params: route.params }; toLogin = true; }
        }
      }
      loaded = true;
      syncError = null;
      lastSynced = new Date();
    }
  }catch(err){
    if (seq >= appliedSeq) syncError = (err && err.message) || String(err);
  }
  if (seq === loadSeq) loading = false;
  if (toLogin){ navigate('login'); return; }
  if (!silent || isPassiveView()) render();
}
function syncNow(){ load(false); }

function isPassiveView(){
  if (busy || authBusy || modal) return false;
  if (ui.editingEntryId || ui.editingStandardName) return false;
  const a = document.activeElement;
  if (a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return false;
  if (route.name === 'seller') return (route.params.tab || 'sales') === 'sales';
  return ['dashboard', 'leaderboard', 'mysales', 'compliance', 'team', 'salaries'].indexOf(route.name) !== -1;
}

async function runAction(payload, successText, opts){
  if (busy) return null;
  opts = opts || {};
  busy = true;
  pendingKey = opts.pendingKey || null;
  if (opts.formKey) delete errors[opts.formKey];
  render();
  let res = null;
  try{
    res = await apiPost(payload, opts.requestId);
    clearRequest(opts.requestKey);
    if (res.ok){
      if (opts.closeModal) modal = null;
      if (opts.onSuccess) opts.onSuccess(res);
      showToast(typeof successText === 'function' ? successText(res) : successText);
      busy = false;
      pendingKey = null;
      await load(true);
      if (opts.afterLoad) opts.afterLoad(res);
    } else if (!res.authError){
      errors[opts.formKey || 'page'] = trServer(res.error) || t('Could not save. Please try again.');
    }
  }catch(err){
    errors[opts.formKey || 'page'] = networkErrorText();
  }
  busy = false;
  pendingKey = null;
  render();
  return res;
}

/* ---------- toast ---------- */

function showToast(text, kind){
  if (!text) return;
  toastState = { text, kind: kind || 'success' };
  renderToast();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastState = null; renderToast(); }, 3600);
}
function renderToast(){
  let root = document.getElementById('toast-root');
  if (!root){
    root = document.createElement('div');
    root.id = 'toast-root';
    root.className = 'toast-wrap';
    root.setAttribute('aria-live', 'polite');
    document.body.appendChild(root);
  }
  root.innerHTML = toastState
    ? `<div class="toast ${toastState.kind}" role="status">${icon(toastState.kind === 'error' ? 'alert' : 'checkCircle')}<span>${esc(toastState.text)}</span></div>`
    : '';
}

/* ---------- routing ---------- */

const ROUTES = {
  dashboard:   { access: 'public', icon: 'home',     label: 'Dashboard' },
  leaderboard: { access: 'public', icon: 'trophy',   label: 'Leaderboard' },
  mysales:     { access: 'seller', icon: 'chart',    label: 'My sales & pay' },
  myentries:   { access: 'seller', icon: 'receipt',  label: 'My entries' },
  standards:   { access: 'seller', icon: 'check',    label: 'Daily standards' },
  entries:     { access: 'admin',  icon: 'receipt',  label: 'Entries' },
  team:        { access: 'admin',  icon: 'users',    label: 'Team' },
  salaries:    { access: 'admin',  icon: 'wallet',   label: 'Salaries' },
  seller:      { access: 'admin',  icon: 'user',     label: 'Seller workspace' },
  compliance:  { access: 'admin',  icon: 'check',    label: 'Compliance' },
  settings:    { access: 'user',   icon: 'settings', label: 'Settings' },
  login:       { access: 'guest',  icon: 'login',    label: 'Log in' },
};
const WS_TABS = [['sales', 'Sales & pay'], ['entries', 'Entries'], ['standards', 'Standards'], ['account', 'Account']];

function hrefFor(name, params){
  let h = '#/' + name;
  if (params){
    const q = new URLSearchParams();
    Object.keys(params).forEach(k => { if (params[k] != null && params[k] !== '') q.set(k, params[k]); });
    const s = q.toString();
    if (s) h += '?' + s;
  }
  return h;
}
/* The route lives in the URL hash, mirrored in memory: inside sandboxed
   frames (published artifacts) history/hash changes can be refused. */
let memHash = null;
function currentHash(){ return memHash != null ? memHash : String(location.hash || ''); }
function parseHash(){
  const raw = currentHash().replace(/^#\/?/, '');
  const qi = raw.indexOf('?');
  const path = qi === -1 ? raw : raw.slice(0, qi);
  const params = {};
  if (qi !== -1){
    try{ new URLSearchParams(raw.slice(qi + 1)).forEach((v, k) => { params[k] = v; }); }catch(e){}
  }
  return ROUTES[path] ? { name: path, params } : { name: 'dashboard', params: {} };
}
function canAccess(name){
  const a = (ROUTES[name] || {}).access;
  if (a === 'public') return true;
  if (a === 'guest') return !session;
  if (!session) return false;
  if (a === 'user') return true;
  return session.role === a;
}
function homeFor(){ return isSeller() ? 'mysales' : 'dashboard'; }
function resolveRoute(r){
  if (canAccess(r.name)) return r;
  if (!session && r.name !== 'login'){ afterLogin = r; return { name: 'login', params: {} }; }
  return { name: homeFor(), params: {} };
}
function replaceHash(h){
  memHash = h;
  try{ history.replaceState(null, '', h); }catch(e){}
}
function onRouteChange(){
  const r = resolveRoute(parseHash());
  const h = hrefFor(r.name, r.params);
  if (currentHash() !== h) replaceHash(h);
  const changed = r.name !== route.name || JSON.stringify(r.params) !== JSON.stringify(route.params);
  if (changed){ resetEditing(); errors = {}; }
  route = r;
  sidebarOpen = false;
  render({ fresh: changed });
  if (changed && typeof window.scrollTo === 'function') window.scrollTo(0, 0);
}
function navigate(name, params){ goTo(hrefFor(name, params)); }
function goTo(h){
  if (currentHash() !== h){
    memHash = h;
    try{ history.pushState(null, '', h); }catch(e){}
  }
  onRouteChange();
}
function onBrowserNav(){ memHash = null; onRouteChange(); }
function onLinkClick(e){
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target && e.target.closest ? e.target.closest('a[href^="#/"]') : null;
  if (!a) return;
  e.preventDefault();
  goTo(a.getAttribute('href'));
}
function toggleSidebar(force){
  sidebarOpen = typeof force === 'boolean' ? force : !sidebarOpen;
  render();
}

function navItemsFor(){
  if (!session) return ['dashboard', 'leaderboard'];
  if (session.role === 'seller') return ['dashboard', 'leaderboard', 'mysales', 'myentries', 'standards', 'settings'];
  return ['dashboard', 'leaderboard', 'entries', 'team', 'salaries', 'compliance', 'settings'];
}
function shortLabel(r){
  return t(({ dashboard: 'Home', leaderboard: 'Ranking', mysales: 'My sales', myentries: 'Entries', entries: 'Entries', login: 'Log in' })[r] || ROUTES[r].label);
}
function crumbLabel(){
  if (route.name === 'seller' && route.params.name) return route.params.name + ' · ' + t('workspace');
  return t(ROUTES[route.name].label);
}

/* ---------- month switcher (past results) ---------- */

function firstMonth(){
  let first = currentMonthKey();
  data.entries.forEach(e => { const m = e.date.slice(0, 7); if (m < first) first = m; });
  return first;
}
function viewMonth(){
  const cur = currentMonthKey();
  if (!ui.month || ui.month > cur) ui.month = cur;
  return ui.month;
}
function isPast(month){ return month < currentMonthKey(); }
function setMonth(m){
  if (!/^\d{4}-\d{2}$/.test(m)) return;
  const cur = currentMonthKey();
  ui.month = m > cur ? cur : (m < firstMonth() ? firstMonth() : m);
  render({ fresh: true });
}
function monthSwitch(){
  const m = viewMonth();
  const cur = currentMonthKey();
  const first = firstMonth();
  const months = [];
  for (let k = cur; k >= first && months.length < 36; k = addMonths(k, -1)) months.push(k);
  return `
    <div class="month-switch" role="group" aria-label="${esc(t('Month'))}">
      <button type="button" class="icon-btn" onclick="setMonth('${addMonths(m, -1)}')" ${m <= first ? 'disabled' : ''} aria-label="${esc(t('Previous month'))}">${icon('chevL')}</button>
      <label class="sr-only" for="month-pick">${esc(t('Month'))}</label>
      <select id="month-pick" data-fixed onchange="setMonth(this.value)">${months.map(k => `<option value="${k}" ${k === m ? 'selected' : ''}>${esc(monthLabel(k))}</option>`).join('')}</select>
      <button type="button" class="icon-btn" onclick="setMonth('${addMonths(m, 1)}')" ${m >= cur ? 'disabled' : ''} aria-label="${esc(t('Next month'))}">${icon('chevR')}</button>
      ${m !== cur ? `<button type="button" class="btn btn-sm btn-ghost" onclick="setMonth('${cur}')">${esc(t('This month'))}</button>` : ''}
    </div>`;
}
function pastBanner(m){
  return isPast(m) ? `<div class="banner banner-info" role="note"><span>${esc(t('You are looking at {month}. These are final results for that month.', { month: monthLabel(m) }))}</span><button type="button" class="btn btn-sm btn-ghost" onclick="setMonth('${currentMonthKey()}')">${esc(t('Back to this month'))}</button></div>` : '';
}

/* ---------- render core ---------- */

function captureUi(root){
  const snap = { values: {}, checks: {}, scroll: {}, focus: null };
  root.querySelectorAll('input[id], select[id], textarea[id]').forEach(el => {
    if (el.type === 'checkbox' || el.type === 'radio') snap.checks[el.id] = el.checked;
    else snap.values[el.id] = el.value;
  });
  root.querySelectorAll('[data-scroll]').forEach(el => { snap.scroll[el.getAttribute('data-scroll')] = el.scrollTop; });
  const a = document.activeElement;
  if (a && a.id && root.contains(a)){
    snap.focus = { id: a.id, start: null, end: null };
    try{ snap.focus.start = a.selectionStart; snap.focus.end = a.selectionEnd; }catch(e){}
  }
  return snap;
}
function restoreUi(snap){
  Object.keys(snap.values).forEach(id => {
    if (resetFields.has(id)) return;
    const el = document.getElementById(id);
    if (!el || !('value' in el)) return;
    if (el.hasAttribute('data-fixed')) return;
    if (el.tagName === 'SELECT' && !Array.prototype.some.call(el.options, o => o.value === snap.values[id])) return;
    el.value = snap.values[id];
  });
  Object.keys(snap.checks).forEach(id => {
    if (resetFields.has(id)) return;
    const el = document.getElementById(id);
    if (el) el.checked = snap.checks[id];
  });
  Object.keys(snap.scroll).forEach(k => {
    const el = document.querySelector(`[data-scroll="${k}"]`);
    if (el) el.scrollTop = snap.scroll[k];
  });
  if (snap.focus && !focusAfter){
    const el = document.getElementById(snap.focus.id);
    if (el && !el.disabled){
      try{ el.focus({ preventScroll: true }); }catch(e){ el.focus(); }
      if (snap.focus.start != null){ try{ el.setSelectionRange(snap.focus.start, snap.focus.end); }catch(e){} }
    }
  }
}
function applyFocusAfter(){
  if (!focusAfter) return;
  const el = document.getElementById(focusAfter);
  focusAfter = null;
  if (!el) return;
  try{ el.focus({ preventScroll: true }); }catch(e){ el.focus(); }
  if (el.tagName === 'INPUT' && el.type === 'text'){
    try{ const n = el.value.length; el.setSelectionRange(n, n); }catch(e){}
  }
}
function render(opts){
  const app = document.getElementById('app');
  if (!app) return;
  const fresh = !!(opts && opts.fresh);
  const snap = fresh ? null : captureUi(app);
  const y = window.scrollY || 0;
  app.className = '';
  app.innerHTML = renderShell();
  if (snap) restoreUi(snap);
  resetFields.clear();
  if (Math.abs((window.scrollY || 0) - y) > 1) window.scrollTo(0, y);
  applyFocusAfter();
  if (document.getElementById('bulk-total')) updateBulkTotal();
  document.body.classList.toggle('modal-open', !!modal);
  if (loaded || !isConfigured()) markLoaded();
}
function markLoaded(){
  if (document.body && !document.body.classList.contains('loaded')){
    setTimeout(() => document.body.classList.add('loaded'), 700);
  }
}

/* ---------- shell ---------- */

function renderShell(){
  return `
  <div class="app ${sidebarOpen ? 'sidebar-open' : ''}">
    ${renderSidebar()}
    <div class="scrim" onclick="toggleSidebar(false)"></div>
    <div class="main">
      ${renderTopbar()}
      <main class="content" id="main-content">${renderView()}</main>
    </div>
    ${renderBottomNav()}
  </div>
  ${renderModal()}`;
}

function renderSidebar(){
  const items = navItemsFor().map(r => {
    const active = route.name === r;
    return `<a class="nav-item ${active ? 'active' : ''}" href="${hrefFor(r)}" ${active ? 'aria-current="page"' : ''}>${icon(ROUTES[r].icon)}<span>${esc(t(ROUTES[r].label))}</span></a>`;
  }).join('');
  let workspaces = '';
  if (isAdmin() && loaded && data.sellers.length){
    const risks = teamRisks();
    workspaces = `
      <div class="nav-label">${esc(t('Seller workspaces'))}</div>
      <nav class="seller-nav" aria-label="${esc(t('Seller workspaces'))}">
        ${data.sellers.map(s => {
          const r = risks[s.name].risk;
          const active = route.name === 'seller' && route.params.name === s.name;
          return `<a class="seller-link ${active ? 'active' : ''}" href="${hrefFor('seller', { name: s.name })}" ${active ? 'aria-current="page"' : ''} title="${esc(r ? r.label : t('No plan'))}">
            <span class="risk-dot ${r ? r.level : ''}" aria-hidden="true"></span><span class="name">${esc(s.name)}</span>
          </a>`;
        }).join('')}
      </nav>`;
  }
  const foot = session ? `
    <div class="sidebar-user">
      <span class="avatar ${isAdmin() ? 'admin' : ''}">${esc(initial(session.name))}</span>
      <div class="who">
        <div class="who-name">${esc(session.name)}</div>
        <div class="who-role">${esc(isAdmin() ? t('Team leader') : t('Seller'))}</div>
      </div>
      <button type="button" class="icon-btn" onclick="logOut()" aria-label="${esc(t('Log out'))}" title="${esc(t('Log out'))}">${icon('logout')}</button>
    </div>` : `<a class="btn btn-block" href="${hrefFor('login')}">${icon('login')}<span>${esc(t('Log in'))}</span></a>`;
  return `
    <aside class="sidebar" aria-label="${esc(t('Main navigation'))}">
      <a class="brand" href="${hrefFor('dashboard')}">
        <span class="brand-mark" aria-hidden="true">${icon('bolt')}</span>
        <span class="brand-name">Sales <b>Pace</b></span>
      </a>
      <div>
        <div class="nav-label">${esc(t('Menu'))}</div>
        <nav class="nav">${items}</nav>
      </div>
      ${workspaces ? `<div>${workspaces}</div>` : ''}
      <div class="sidebar-foot">
        ${DEMO ? `<span class="pill demo">${esc(t('Demo mode'))}</span>` : ''}
        ${foot}
      </div>
    </aside>`;
}

function syncStatusHtml(){
  if (DEMO || !isConfigured() || !loaded) return '';
  if (loading) return `<span class="sync-status">${esc(t('Syncing…'))}</span>`;
  if (syncError) return `<span class="sync-status err">${esc(t('Offline'))} · <button type="button" class="btn-link" onclick="syncNow()">${esc(t('Retry'))}</button></span>`;
  if (lastSynced){
    const tm = pad(lastSynced.getHours()) + ':' + pad(lastSynced.getMinutes());
    return `<span class="sync-status">${esc(t('Synced {time}', { time: tm }))} · <button type="button" class="btn-link" onclick="syncNow()">${esc(t('Sync'))}</button></span>`;
  }
  return '';
}
function renderTopbar(){
  const dark = currentTheme() === 'dark';
  const right = session ? `
      ${route.name !== 'login' ? `<button type="button" class="btn btn-sm add-sale-btn" onclick="openSaleModal()">${icon('plus')}<span>${esc(t('Add sale'))}</span></button>` : ''}
      <a class="user-chip" href="${hrefFor('settings')}" title="${esc(t('Account settings'))}">
        <span class="avatar sm ${isAdmin() ? 'admin' : ''}">${esc(initial(session.name))}</span>
        <span class="chip-name">${esc(session.name)}</span>
        <span class="pill ${isAdmin() ? 'role-admin' : 'role-seller'}">${esc(isAdmin() ? t('Admin') : t('Seller'))}</span>
      </a>`
    : (route.name === 'login' ? '' : `<a class="btn btn-sm" href="${hrefFor('login')}">${icon('login')}<span>${esc(t('Log in'))}</span></a>`);
  return `
    <header class="topbar">
      <button type="button" class="icon-btn menu-btn" onclick="toggleSidebar()" aria-label="${esc(sidebarOpen ? t('Close menu') : t('Open menu'))}" aria-expanded="${sidebarOpen}">${icon('menu')}</button>
      <div class="topbar-title"><span class="crumb">${esc(crumbLabel())} <span>· ${esc(monthLabel(currentMonthKey()))}</span></span></div>
      <div class="topbar-right">
        ${syncStatusHtml()}
        <button type="button" class="icon-btn lang-toggle" onclick="toggleLang()" aria-label="${esc(lang === 'en' ? 'O‘zbek tiliga o‘tish' : 'Switch to English')}" title="${esc(lang === 'en' ? 'O‘zbekcha' : 'English')}">${lang === 'en' ? 'UZ' : 'EN'}</button>
        <button type="button" class="icon-btn theme-toggle" onclick="toggleTheme()" aria-label="${esc(dark ? t('Switch to light theme') : t('Switch to dark theme'))}" title="${esc(dark ? t('Light theme') : t('Dark theme'))}">${icon(dark ? 'sun' : 'moon')}</button>
        ${right}
      </div>
    </header>`;
}

function renderBottomNav(){
  let items;
  if (!session) items = ['dashboard', 'leaderboard', 'login'];
  else if (isSeller()) items = ['dashboard', 'mysales', 'add', 'myentries', 'more'];
  else items = ['dashboard', 'salaries', 'add', 'entries', 'more'];
  return `<nav class="bottom-nav" aria-label="${esc(t('Quick navigation'))}">${items.map(it => {
    if (it === 'more') return `<button type="button" class="bottom-item ${sidebarOpen ? 'active' : ''}" onclick="toggleSidebar()" aria-expanded="${sidebarOpen}">${icon('more')}<span>${esc(t('More'))}</span></button>`;
    if (it === 'add') return `<button type="button" class="bottom-add" onclick="openSaleModal()" aria-label="${esc(t('Add sale'))}"><span class="plus">${icon('plus')}</span><span>${esc(t('Add sale'))}</span></button>`;
    const active = route.name === it;
    return `<a class="bottom-item ${active ? 'active' : ''}" href="${hrefFor(it)}" ${active ? 'aria-current="page"' : ''}>${icon(ROUTES[it].icon)}<span>${esc(it === 'salaries' ? t('Salaries') : shortLabel(it))}</span></a>`;
  }).join('')}</nav>`;
}

function renderView(){
  if (!isConfigured()) return viewNotConfigured();
  if (route.name === 'login') return viewLogin();
  if (!loaded){
    if (syncError) return viewLoadError();
    return `<section class="card" aria-busy="true"><p>${esc(DEMO ? t('Loading demo data…') : t('Loading data from Google Sheets…'))}</p></section>`;
  }
  const refreshBanner = syncError ? `
    <div class="banner banner-error" role="alert">
      <span>${esc(t('Could not refresh data. Showing the last successfully loaded data.'))}</span>
      <button type="button" class="btn btn-sm btn-ghost" onclick="syncNow()">${esc(t('Retry'))}</button>
    </div>` : '';
  let body;
  switch (route.name){
    case 'dashboard':   body = viewDashboard(); break;
    case 'leaderboard': body = viewLeaderboard(); break;
    case 'mysales':     body = viewMySales(); break;
    case 'myentries':   body = viewMyEntries(); break;
    case 'standards':   body = viewMyStandards(); break;
    case 'entries':     body = viewEntries(); break;
    case 'team':        body = viewTeam(); break;
    case 'salaries':    body = viewSalaries(); break;
    case 'seller':      body = viewWorkspace(); break;
    case 'compliance':  body = viewCompliance(); break;
    case 'settings':    body = viewSettings(); break;
    default:            body = viewDashboard();
  }
  return refreshBanner + errorHtml('page') + body;
}

/* ---------- shared view pieces ---------- */

function pageHead(eyebrow, title, sub, actions){
  return `<header class="page-head">
    <div>
      ${eyebrow ? `<div class="eyebrow">${eyebrow}</div>` : ''}
      <h1>${title}</h1>
      ${sub ? `<div class="sub">${sub}</div>` : ''}
    </div>
    ${actions ? `<div class="page-actions">${actions}</div>` : ''}
  </header>`;
}
function cardHead(iconName, title, right){
  return `<div class="card-head"><h2 class="card-title">${iconName ? icon(iconName) : ''}${title}</h2>${right || ''}</div>`;
}
function riskPill(r){ return r ? `<span class="pill ${r.level}">${esc(r.label)}</span>` : `<span class="pill">${esc(t('No plan'))}</span>`; }
function catPill(cat){ return `<span class="pill plain cat-${cat || 'none'}">${esc(catLabel(cat))}</span>`; }
function paceTone(status){ return { good: 'ok', warn: 'needsattention', bad: 'critical' }[status] || ''; }
function sellerSelect(id, selected, cls, placeholder, extra){
  return `<select id="${id}" class="${cls || ''}" ${extra || ''}>
    ${placeholder ? `<option value="">${esc(placeholder)}</option>` : ''}
    ${data.sellers.map(s => `<option value="${esc(s.name)}" ${s.name === selected ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
  </select>`;
}
function personCell(name, opts){
  opts = opts || {};
  const inner = `<span class="avatar sm">${esc(initial(name))}</span><span>${esc(name)}</span>${opts.me ? ` <span class="pill role-seller">${esc(t('You'))}</span>` : ''}`;
  if (isAdmin() && sellerByName(name)) return `<a class="person" href="${hrefFor('seller', { name, tab: opts.tab })}">${inner}</a>`;
  return `<span class="person">${inner}</span>`;
}

function renderTrack(pctComplete, label, marks){
  const pct = Math.min(Math.max(pctComplete, 0), 100);
  const ms = (marks || [25, 55, 80]).filter(m => m > 0 && m < 100).map(m =>
    `<div class="checkpoint ${pctComplete >= m ? 'hit' : ''}" style="left:${m}%" data-label="${pctText(m)}"></div>`).join('');
  return `
    <div class="track" role="progressbar" aria-valuenow="${pctComplete.toFixed(1)}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(label)}">
      <div class="track-fill ${pctComplete >= 100 ? 'done' : ''}" style="width:${pct.toFixed(1)}%"></div>
      ${ms}
    </div>`;
}

function renderHero(label, amount, stats, marks, note){
  const info = stats.info;
  const m = info.monthKey;
  const daysText = stats.closed
    ? esc(t('Month closed'))
    : esc(t('Day {d} of {n}', { d: info.dayOfMonth, n: info.daysInMonth })) + ' · ' + esc(cnt(stats.daysLeft, '{n} day left', '{n} days left'));
  return `
    <section class="card slash hero" aria-label="${esc(label)}">
      <div class="hero-top">
        <div>
          <div class="hero-label">${esc(label)}${note ? ` <span class="pill plain">${esc(note)}</span>` : ''}</div>
          <div class="hero-amount num">${fmt(amount)}<small>so'm</small></div>
        </div>
        <div class="hero-days">
          <div>
            <div class="big">${esc(monthLabel(m))}</div>
            <div class="small">${daysText}</div>
          </div>
          <span class="icon-box">${icon('calendar')}</span>
        </div>
      </div>
      <div class="track-row">
        ${renderTrack(stats.pctComplete, label, marks)}
        <div class="track-pct num">${stats.pctComplete.toFixed(stats.pctComplete < 10 ? 1 : 0)}%</div>
      </div>
      <div class="hero-foot">
        <span>${esc(t('Sold'))} <strong class="num">${money(stats.totalSold)}</strong></span>
        <span>${stats.remaining > 0 ? `${esc(t('Remaining'))} <strong class="num">${money(stats.remaining)}</strong>` : `<strong>${esc(t('Plan reached'))} 🎉</strong>`}</span>
      </div>
    </section>`;
}

function renderStatTiles(stats, todaySold, isTeam){
  if (stats.closed){
    const best = stats.bestDay;
    return `
      <section class="stat-grid" aria-label="${esc(t('Key numbers'))}">
        <div class="stat-tile status-${stats.paceStatus}">
          <div class="stat-label">${esc(t('Plan completed'))}</div>
          <div class="stat-value num">${stats.pctComplete.toFixed(1)}%</div>
          <div class="stat-sub">${esc(t('{sold} of {plan}', { sold: fmtShort(stats.totalSold), plan: fmtShort(stats.plan) }))}</div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">${esc(t('Average per day'))}</div>
          <div class="stat-value num">${fmt(stats.recentAvgDaily)}</div>
          <div class="stat-sub">${esc(t('over {n} days', { n: stats.info.daysInMonth }))}</div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">${esc(t('Best day'))}</div>
          <div class="stat-value num">${best ? fmt(best.amount) : '—'}</div>
          <div class="stat-sub">${best ? esc(shortDay(stats.info.monthKey + '-' + pad(best.day))) : esc(t('No sales'))}</div>
        </div>
        <div class="stat-tile">
          <div class="stat-label">${esc(t('Sales logged'))}</div>
          <div class="stat-value num">${stats.entries.length}</div>
          <div class="stat-sub">${esc(t('on {n} days', { n: stats.activeDays }))}</div>
        </div>
      </section>`;
  }
  const done = stats.remaining <= 0;
  const need = stats.dailyTarget;
  const todayGood = done || (need > 0 && todaySold >= need);
  const todaySub = done ? t('Plan already reached') : (need > 0 ? t('{p}% of today’s {need} need', { p: Math.round(todaySold / need * 100), need: fmtShort(need) }) : '—');
  const avgSub = done ? t("so'm/day recent pace") : t("so'm/day · {p}% of what’s needed", { p: Math.round(stats.paceRatio * 100) });
  return `
    <section class="stat-grid" aria-label="${esc(t('Key numbers'))}">
      <div class="stat-tile ${todayGood ? 'status-good' : ''}">
        <div class="stat-label">${esc(t('Sold today'))}</div>
        <div class="stat-value num">${fmt(todaySold)}</div>
        <div class="stat-sub">${esc(todaySub)}</div>
      </div>
      <div class="stat-tile status-${done ? 'good' : stats.neededStatus}">
        <div class="stat-label">${esc(t('Needed per day'))}</div>
        <div class="stat-value num">${done ? '🎉' : fmt(need)}</div>
        <div class="stat-sub">${esc(done ? t('Plan complete') : t("so'm/day to reach 100% of the plan"))}</div>
      </div>
      <div class="stat-tile">
        <div class="stat-label">${esc(t('{n}-day average', { n: stats.recentDays }))}</div>
        <div class="stat-value num">${fmt(stats.recentAvgDaily)}</div>
        <div class="stat-sub">${esc(avgSub)}</div>
      </div>
      <div class="stat-tile status-${stats.paceStatus}">
        <div class="stat-label">${esc(t('Projected finish'))}</div>
        <div class="stat-value num">${stats.forecastPct.toFixed(0)}%</div>
        <div class="stat-sub">${esc(t("≈ {amount} so'm by month end", { amount: fmtShort(stats.forecastTotal) }))}</div>
      </div>
    </section>`;
}

function renderChartCard(stats, title, opts){
  opts = opts || {};
  const team = opts.reward !== false;
  const fcColor = { good: 'var(--good-solid)', warn: '#E8A522', bad: 'var(--bad-solid)' }[stats.paceStatus];
  return `
    <section class="card slash" aria-label="${esc(title)}">
      ${cardHead('chart', esc(title), stats.closed ? `<span class="pill ${paceTone(stats.paceStatus)}">${esc(t('Final {p}%', { p: stats.pctComplete.toFixed(0) }))}</span>` : `<span class="pill ${paceTone(stats.paceStatus)}">${esc(t('Forecast {p}%', { p: stats.forecastPct.toFixed(0) }))}</span>`)}
      ${buildChart(stats, opts)}
      <div class="legend">
        <span><i style="border-color:var(--good-solid)"></i>${esc(t('Actual'))}</span>
        ${stats.closed ? '' : `<span><i class="dash" style="border-color:${fcColor}"></i>${esc(t('Forecast'))}</span>`}
        ${team ? `<span><i class="dash" style="border-color:var(--ch-reward)"></i>${esc(t('Reward pace 25 / 55 / 80%'))}</span>` : `<span><i style="border-color:var(--ch-grid)"></i>${esc(t('Pay tier lines'))}</span>`}
        <span><i class="dot" style="border-color:var(--ch-plan)"></i>${esc(t('Even pace to 100%'))}</span>
      </div>
    </section>`;
}

function renderDecadesCard(stats){
  return `
    <section class="card slash" aria-label="${esc(t('Team reward milestones'))}">
      ${cardHead('target', esc(t('Team reward milestones')), `<span class="kicker">${esc(t('25% by day 10 · 55% by day 20 · 80% by month end'))}</span>`)}
      <div class="decade-grid">${stats.decades.map(renderDecadeCard).join('')}</div>
    </section>`;
}

function monthLeaderboard(month){
  const board = computeLeaderboard(monthEntries(data.entries, month), sellerNames());
  let prev = null, rank = 0;
  return board.map((x, i) => {
    if (prev === null || x.amount !== prev){ rank = i + 1; prev = x.amount; }
    return { name: x.name, amount: x.amount, rank };
  });
}
function medal(l){ return `<span class="medal ${l.amount > 0 && l.rank <= 3 ? 'm' + l.rank : ''}">${l.rank}</span>`; }
function pctCell(amount, plan){
  if (!(plan > 0)) return `<span class="muted">${esc(t('No plan'))}</span>`;
  const p = amount / plan * 100;
  return `<div class="pct-cell"><div class="mini-track"><span class="${p >= 100 ? 'done' : ''}" style="width:${Math.min(p, 100).toFixed(1)}%"></span></div><span class="num">${p.toFixed(0)}%</span></div>`;
}

function renderClassMix(list, title){
  const total = sumAmounts(list);
  const by = {};
  list.forEach(e => { const k = e.cls || '—'; by[k] = (by[k] || 0) + e.amount; });
  const keys = CLASSES.concat(by['—'] ? ['—'] : []);
  const rows = keys.map(k => {
    const amt = by[k] || 0;
    const share = total > 0 ? amt / total * 100 : 0;
    return `<div class="mix-row">
      <span class="mix-name">${k === '—' ? `<span class="pill">—</span> ${esc(t('No class'))}` : `${classPill(k)} ${esc(t(CLASS_NAMES[k]))}`}</span>
      <span class="mini-track"><span class="mix-${k === '—' ? 'none' : k}" style="width:${share.toFixed(1)}%"></span></span>
      <span class="mix-amt num">${fmtShort(amt)} <span class="muted">${share.toFixed(0)}%</span></span>
    </div>`;
  }).join('');
  return `
    <section class="card" aria-label="${esc(title)}">
      ${cardHead('pie', esc(title), `<span class="kicker num">${money(total)}</span>`)}
      <div class="mix">${rows}</div>
    </section>`;
}

/* ---------- risk ---------- */

let riskMemo = null;
function teamRisks(){
  const today = todayStr();
  if (riskMemo && riskMemo.v === dataVersion && riskMemo.today === today && riskMemo.lang === lang) return riskMemo.map;
  const map = {};
  const month = today.slice(0, 7);
  data.sellers.forEach(s => {
    const mine = data.entries.filter(e => e.seller === s.name);
    const info = sellerInfo(s.name, month);
    const stats = computeStats(mine, info.plan, month, { startDay: info.pf.startDay });
    const todaySold = sumAmounts(mine.filter(e => e.date === today));
    const last = lastSaleDate(mine);
    const compliantToday = data.standards.length
      ? data.standards.every(std => { const r = findActivity(today, s.name, std.name); return !!r && r.value >= std.minPerDay; })
      : null;
    const daysSinceLastSale = last ? daysBetween(last < s.startDate ? s.startDate : last, today) : (s.startDate && s.startDate <= today ? daysBetween(s.startDate, today) : null);
    const risk = info.plan > 0 && stats.started ? classifyRisk(stats, { daysSinceLastSale, compliantToday }) : null;
    map[s.name] = { seller: s, info, stats, todaySold, last, compliantToday, risk };
  });
  riskMemo = { v: dataVersion, today, map, lang };
  return map;
}
const RISK_LEVELS = [['critical', 'Critical', 'alert'], ['atrisk', 'At risk', 'trendDown'], ['needsattention', 'Need attention', 'eye'], ['ontrack', 'On track', 'checkCircle']];
function toggleRiskList(level){ ui.openRiskLevel = ui.openRiskLevel === level ? null : level; render(); }
function renderActionCenter(){
  const map = teamRisks();
  const snaps = data.sellers.map(s => map[s.name]);
  const withPlan = snaps.filter(x => x.risk);
  const noPlan = snaps.filter(x => !x.risk);
  if (!withPlan.length){
    return `<section class="card" aria-label="${esc(t('Action Center'))}">${cardHead('bolt', esc(t('Action Center')))}<p>${esc(t('Give sellers a category to start tracking who’s on pace.'))}</p></section>`;
  }
  const buckets = { critical: [], atrisk: [], needsattention: [], ontrack: [] };
  withPlan.forEach(x => buckets[x.risk.level].push(x));
  let open = ui.openRiskLevel;
  if (open === 'auto') open = ['critical', 'atrisk', 'needsattention'].find(l => buckets[l].length) || null;
  const tiles = RISK_LEVELS.map(([level, label, ic]) => {
    const n = buckets[level].length;
    const isOpen = open === level;
    return `
      <button type="button" class="action-tile tone-${level} ${n ? 'has' : ''} ${isOpen ? 'open' : ''}" onclick="toggleRiskList('${level}')" ${n ? '' : 'disabled'} aria-expanded="${isOpen}">
        <span class="tile-icon">${icon(ic)}</span>
        <span><span class="count num" style="display:block">${n}</span><span class="label" style="display:block">${esc(t(label))}</span></span>
      </button>`;
  }).join('');
  const list = open && buckets[open].length ? `
    <div class="risk-list">
      ${buckets[open].map(x => `
        <a class="risk-row" href="${hrefFor('seller', { name: x.seller.name })}">
          <span class="who-cell"><span class="avatar sm">${esc(initial(x.seller.name))}</span>${esc(x.seller.name)} ${riskPill(x.risk)}</span>
          <span class="reason">${esc(x.risk.reason)}</span>
          <span class="go">${esc(t('Open workspace'))} →</span>
        </a>`).join('')}
    </div>` : '';
  const np = noPlan.length ? `<p class="hint">${noPlan.map(x => `<a href="${hrefFor('seller', { name: x.seller.name, tab: 'account' })}">${esc(x.seller.name)}</a>`).join(', ')} — ${esc(t('no category or plan yet.'))}</p>` : '';
  return `
    <section class="card" aria-label="${esc(t('Action Center'))}">
      ${cardHead('bolt', esc(t('Action Center')), `<span class="kicker">${esc(t('Tap a group, then a seller to open their workspace'))}</span>`)}
      <div class="action-grid">${tiles}</div>
      ${list}${np}
    </section>`;
}

/* ---------- views: public ---------- */

function viewNotConfigured(){
  return pageHead(esc(t('Setup')), esc(t('Connect Google Sheets')), '') + `
    <section class="card"><p>Paste your Apps Script Web App URL (it ends in <code>/exec</code>) into <code>index.html</code>, at the line <code>window.SALES_PACE_SCRIPT_URL = …</code>, then reload this page.</p></section>`;
}
function viewLoadError(){
  return pageHead('Sales Pace', esc(DEMO ? t('Demo could not start') : t('Can’t reach Google Sheets')), '') + `
    <section class="card">
      <div class="banner banner-error" role="alert"><span>${esc(syncError)}</span></div>
      <button type="button" class="btn" onclick="syncNow()">${icon('refresh')}<span>${esc(t('Try again'))}</span></button>
    </section>`;
}

function viewDashboard(){
  const m = viewMonth();
  const plan = teamPlanFor(m);
  const addBtn = session && !isPast(m) ? `<button type="button" class="btn" onclick="openSaleModal()">${icon('plus')}<span>${esc(t('Add sale'))}</span></button>` : '';
  const head = pageHead(esc(t('Team overview')), esc(t('Dashboard')), '', monthSwitch() + addBtn);
  if (!plan){
    return head + pastBanner(m) + `
      <section class="card">${cardHead('target', esc(t('No team plan for this month')))}
        <p>${isAdmin() ? `${esc(t('Set the team plan in'))} <a href="${hrefFor('settings')}" onclick="ui.settingsTab='pay'">${esc(t('Settings → Plans & pay'))}</a>.` : esc(t('The team leader hasn’t set this month’s plan yet.'))}</p>
      </section>` + (isAdmin() && !isPast(m) ? renderActionCenter() : '');
  }
  const stats = computeStats(data.entries, plan, m);
  const todaySold = sumAmounts(stats.entries.filter(e => e.date === todayStr()));
  return head + pastBanner(m)
    + renderHero(t('Team plan'), plan, stats)
    + (isAdmin() && !isPast(m) ? renderActionCenter() : '')
    + renderStatTiles(stats, todaySold, true)
    + renderChartCard(stats, t('Team pace'), { reward: true })
    + (session ? renderSalesCallsCard(t('Team sales & call time'), stats.entries, data.calls, m) : '')
    + renderDecadesCard(stats)
    + `<div class="grid-2">${renderLeaderboardCard(m)}${renderLatestSalesCard(stats.entries, m)}</div>`
    + renderClassMix(stats.entries, t('Sales by client class'));
}

function renderLeaderCard(m){
  const lp = leaderPayFor(m);
  const c = cfgFor(m);
  const tiers = (c.leader || {}).tiers || [];
  if (!lp) return `<section class="card">${cardHead('crown', esc(t('Team leader bonus')))}<p>${esc(t('Set the leader plan and bonus table in Settings → Plans & pay.'))}</p></section>`;
  const past = isPast(m);
  const ladder = tiers.map((tr, i) => `
    <tr class="${i === lp.index ? 'is-me' : ''}">
      <td>${esc(tierRange(tiers, i))}</td>
      <td class="num">${pctText(tr.pct)}</td>
      <td class="num">${tr.bonus ? fmt(tr.bonus) : '—'}</td>
    </tr>`).join('');
  return `
    <section class="card slash pay-card" aria-label="${esc(t('Team leader bonus'))}">
      ${cardHead('crown', esc(t('Team leader bonus')), `<span class="pill ok">${esc(tierRange(tiers, lp.index))}</span>`)}
      <div class="kicker">${esc(past ? t('Final for {month}', { month: monthLabel(m) }) : t('So far this month'))}</div>
      <div class="pay-total num">${money(lp.total)}</div>
      <div class="pay-break">${esc(t('{pct} of all team sales ({sold}) = {com}', { pct: pctText(lp.tier.pct), sold: fmt(lp.sold), com: fmt(lp.commission) }))}${lp.fixed ? ' + ' + esc(t('bonus {b}', { b: fmt(lp.fixed) })) : ''}</div>
      <div class="kicker" style="margin-top:6px">${esc(t('Team sold {p} of the leader plan ({plan})', { p: pctText(lp.pct), plan: fmtShort(lp.plan) }))}</div>
      ${!past && lp.next ? `<div class="next-tier">${icon('target')}<span>${esc(t('{amount} more team sales to reach {p}: {pct} of all sales{bonus}.', { amount: money(lp.toNext), p: pctText(lp.next.from), pct: pctText(lp.next.pct), bonus: lp.next.bonus ? ' + ' + t('bonus {b}', { b: fmt(lp.next.bonus) }) : '' }))}</span></div>` : ''}
      <div class="table-wrap free"><table class="ladder">
        <thead><tr><th scope="col">${esc(t('Plan completed'))}</th><th scope="col">${esc(t('% of all sales'))}</th><th scope="col">${esc(t('Bonus'))}</th></tr></thead>
        <tbody>${ladder}</tbody>
      </table></div>
    </section>`;
}

function renderLeaderboardCard(m){
  const board = monthLeaderboard(m);
  const showPlan = !!session;
  const rows = board.length ? board.slice(0, 8).map(l => {
    const me = isSeller() && session.name === l.name;
    return `
      <tr class="${me ? 'is-me' : ''}">
        <td class="rank-cell">${medal(l)}</td>
        <td>${personCell(l.name, { me })}</td>
        <td class="amt-cell num">${fmt(l.amount)}</td>
        ${showPlan ? `<td class="hide-sm">${pctCell(l.amount, sellerInfo(l.name, m).plan)}</td>` : ''}
      </tr>`;
  }).join('') : `<tr class="empty-row"><td colspan="4">${esc(t('No sellers yet.'))}</td></tr>`;
  return `
    <section class="card slash" aria-label="${esc(t('Leaderboard'))}">
      ${cardHead('trophy', esc(t('Leaderboard')), `<a href="${hrefFor('leaderboard')}" class="view-all">${esc(t('Full ranking'))} →</a>`)}
      <div class="table-wrap free"><table>
        <thead><tr><th scope="col">#</th><th scope="col">${esc(t('Seller'))}</th><th scope="col">${esc(t("Sales (so'm)"))}</th>${showPlan ? `<th scope="col" class="hide-sm">${esc(t('Of plan'))}</th>` : ''}</tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </section>`;
}

function renderLatestSalesCard(monthList, m){
  const latest = newestFirst(monthList).slice(0, 8);
  const rows = latest.length ? latest.map(e => `
    <tr>
      <td class="date-cell">${esc(shortDay(e.date))}</td>
      <td>${personCell(e.seller || '—', { tab: 'entries' })}</td>
      <td>${classPill(e.cls)}</td>
      <td class="amt-cell num">${fmt(e.amount)}</td>
    </tr>`).join('') : `<tr class="empty-row"><td colspan="4">${esc(t('No sales logged in this month.'))}</td></tr>`;
  return `
    <section class="card" aria-label="${esc(t('Latest sales'))}">
      ${cardHead('receipt', esc(t('Latest sales')), isAdmin() ? `<a href="${hrefFor('entries')}" class="view-all">${esc(t('Manage all'))} →</a>` : (isSeller() ? `<a href="${hrefFor('myentries')}" class="view-all">${esc(t('My entries'))} →</a>` : ''))}
      <div class="table-wrap free"><table>
        <thead><tr><th scope="col">${esc(t('Date'))}</th><th scope="col">${esc(t('Seller'))}</th><th scope="col">${esc(t('Class'))}</th><th scope="col">${esc(t("Amount (so'm)"))}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </section>`;
}

function viewLeaderboard(){
  const m = viewMonth();
  const board = monthLeaderboard(m);
  const total = board.reduce((s, b) => s + b.amount, 0);
  const past = isPast(m);
  const today = todayStr();
  const todayBy = {};
  if (!past) data.entries.forEach(e => { if (e.date === today) todayBy[e.seller] = (todayBy[e.seller] || 0) + e.amount; });
  const showPlan = !!session;
  const head = pageHead(esc(t('Leaderboard')), esc(t('Sales ranking')), esc(t('Ranked by total sales in the month. Tied sellers share a rank.')), monthSwitch());
  if (!board.length) return head + `<section class="card"><p class="empty">${esc(t('No sellers yet.'))}</p></section>`;
  const rows = board.map(l => {
    const plan = sellerInfo(l.name, m).plan;
    const share = total > 0 ? l.amount / total * 100 : 0;
    const me = isSeller() && session.name === l.name;
    return `
      <tr class="${me ? 'is-me' : ''}">
        <td class="rank-cell">${medal(l)}</td>
        <td>${personCell(l.name, { me })}</td>
        <td class="amt-cell num">${fmt(l.amount)}</td>
        ${past ? '' : `<td class="num hide-sm">${todayBy[l.name] ? fmt(todayBy[l.name]) : '<span class="muted">—</span>'}</td>`}
        ${showPlan ? `<td class="num hide-sm">${plan > 0 ? fmt(plan) : '<span class="muted">—</span>'}</td>
        <td>${pctCell(l.amount, plan)}</td>` : ''}
        <td class="num hide-sm">${share.toFixed(1)}%</td>
      </tr>`;
  }).join('');
  return head + pastBanner(m) + `
    <section class="card slash" aria-label="${esc(t('Sales ranking'))}">
      ${cardHead('trophy', esc(monthLabel(m)), `<span class="kicker num">${esc(t('Team total'))} ${money(total)}</span>`)}
      <div class="table-wrap free"><table>
        <thead><tr><th scope="col">#</th><th scope="col">${esc(t('Seller'))}</th><th scope="col">${esc(t("Sales (so'm)"))}</th>${past ? '' : `<th scope="col" class="hide-sm">${esc(t('Today'))}</th>`}${showPlan ? `<th scope="col" class="hide-sm">${esc(t('Plan'))}</th><th scope="col">${esc(t('Of plan'))}</th>` : ''}<th scope="col" class="hide-sm">${esc(t('Team share'))}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </section>`;
}

/* ---------- login ---------- */

function viewLogin(){
  const ab = authBanner ? `<div class="banner banner-${authBanner.type}" role="${authBanner.type === 'error' ? 'alert' : 'status'}">${esc(authBanner.text)}</div>` : '';
  if (loaded && !data.adminExists){
    return `
      <div class="login-wrap">
        ${pageHead('Sales Pace', esc(t('Set up admin access')), esc(t('No admin account exists yet. You’re creating it now.')))}
        <section class="card slash">
          ${ab}
          <div class="field"><label for="setup-username">${esc(t('Username'))}</label><input type="text" id="setup-username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false"></div>
          <div class="field"><label for="setup-password">${esc(t('Password'))}</label><input type="password" id="setup-password" autocomplete="new-password"></div>
          <div class="field"><label for="setup-password-confirm">${esc(t('Confirm password'))}</label><input type="password" id="setup-password-confirm" autocomplete="new-password" onkeydown="if(event.key==='Enter')attemptAdminSetup()"></div>
          <button type="button" class="btn btn-block" onclick="attemptAdminSetup()" ${authBusy ? 'disabled' : ''}>${esc(authBusy ? t('Creating…') : t('Create admin account'))}</button>
        </section>
      </div>`;
  }
  const demo = DEMO ? `
    <section class="card">
      ${cardHead('bolt', esc(t('Demo accounts')))}
      <p>${esc(t('Tap an account to log in instantly. Sellers use password 1234, the admin uses admin123.'))}</p>
      <div class="demo-accounts">
        ${window.SalesPaceDemo.accounts.map(a => `
          <button type="button" class="demo-acc ${a.role === 'admin' ? 'admin' : ''}" onclick="demoLogin(${jsArg(a.username)})" ${authBusy ? 'disabled' : ''}>
            <b>${a.role === 'admin' ? esc(t('Admin — team leader, full control')) : esc(a.name)}</b>
            <span>${esc(a.username)}${a.note ? ' · ' + esc(t(a.note)) : ''}</span>
          </button>`).join('')}
      </div>
      ${window.SalesPaceDemo.storageOk() ? '' : `<p class="hint">${esc(t('This browser blocks storage here, so demo changes reset when you reload the page.'))}</p>`}
    </section>` : '';
  return `
    <div class="login-wrap">
      ${pageHead(DEMO ? esc(t('Sales Pace · demo')) : 'Sales Pace', esc(t('Log in')), esc(t('Sellers and the admin use the same login.')))}
      <section class="card slash">
        ${ab}
        <div class="field"><label for="login-username">${esc(t('Username'))}</label><input type="text" id="login-username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false"></div>
        <div class="field"><label for="login-password">${esc(t('Password'))}</label><input type="password" id="login-password" autocomplete="current-password" onkeydown="if(event.key==='Enter')attemptLogin()"></div>
        <button type="button" class="btn btn-block" onclick="attemptLogin()" ${authBusy ? 'disabled' : ''}>${esc(authBusy ? t('Logging in…') : t('Log in'))}</button>
        <p class="hint">${esc(t('You’ll stay logged in on this device for 7 days, until you log out. No login yet? Ask your admin.'))}</p>
      </section>
      ${demo}
    </div>`;
}
function startSession(res){
  session = { token: res.token, role: res.role, name: res.name, exp: res.exp };
  saveSession(session);
  authBanner = null;
}
async function attemptLogin(u, p){
  if (authBusy) return;
  u = (typeof u === 'string' ? u : val('login-username')).trim();
  p = typeof p === 'string' ? p : val('login-password');
  if (!u || !p){ authBanner = { type: 'error', text: t('Enter your username and password.') }; render(); return; }
  authBusy = true; authBanner = null; render();
  try{
    const res = await apiPost({ action: 'login', username: u, password: p });
    if (res.ok){
      startSession(res);
      authBusy = false;
      const target = afterLogin && canAccess(afterLogin.name) ? afterLogin : { name: homeFor(), params: {} };
      afterLogin = null;
      ui.openRiskLevel = 'auto';
      ui.month = currentMonthKey();
      await load(true);
      navigate(target.name, target.params);
      return;
    }
    authBanner = { type: 'error', text: trServer(res.error) || t('Login failed.') };
  }catch(err){
    authBanner = { type: 'error', text: networkErrorText() };
  }
  authBusy = false;
  render();
}
function demoLogin(username){
  if (!DEMO) return;
  const a = window.SalesPaceDemo.accounts.find(x => x.username === username);
  if (a) attemptLogin(a.username, a.password);
}
async function attemptAdminSetup(){
  if (authBusy) return;
  const u = val('setup-username').trim();
  const p = val('setup-password');
  const p2 = val('setup-password-confirm');
  if (!u){ authBanner = { type: 'error', text: t('Choose a username.') }; render(); return; }
  if (p.length < 4){ authBanner = { type: 'error', text: t('Password must be at least {n} characters.', { n: 4 }) }; render(); return; }
  if (p !== p2){ authBanner = { type: 'error', text: t('Passwords don’t match.') }; render(); return; }
  authBusy = true; authBanner = null; render();
  try{
    const res = await apiPost({ action: 'setupAdmin', username: u, password: p });
    if (res.ok){
      startSession(res);
      data.adminExists = true;
      authBusy = false;
      await load(true);
      navigate('team');
      return;
    }
    authBanner = { type: 'error', text: trServer(res.error) || t('Setup failed.') };
  }catch(err){
    authBanner = { type: 'error', text: networkErrorText() };
  }
  authBusy = false;
  render();
}
function logOut(){
  endSession(null);
  afterLogin = null;
  navigate('dashboard');
  load(true);
}

/* ---------- seller views (shared by the seller and the admin workspace) ---------- */

function notFoundCard(name){
  return `<section class="card"><p>${name ? esc(t('No seller named {name} was found.', { name })) : esc(t('Seller profile not found.'))} ${isAdmin() ? `<a href="${hrefFor('team')}">${esc(t('Open Team'))}</a>` : esc(t('Ask your admin to check the Team page.'))}</p></section>`;
}

function renderRankCard(name, m){
  const board = monthLeaderboard(m);
  const mine = board.find(l => l.name === name);
  if (!mine) return '';
  const leader = board[0];
  const gap = leader.amount - mine.amount;
  const tiedLead = mine.rank === 1 && board.filter(l => l.rank === 1).length > 1;
  return `
    <section class="card" aria-label="${esc(t('Team rank'))}">
      <div class="rank-line">
        <div>
          <div class="kicker">${esc(isPast(m) ? t('Team rank in {month}', { month: monthLabel(m) }) : t('Team rank this month'))}</div>
          <div class="big-number num">#${mine.rank} <span class="muted" style="font-size:16px">${esc(t('of {n}', { n: board.length }))}</span></div>
        </div>
        <div class="align-right">
          <div class="kicker">${esc(gap > 0 ? t('Behind {name}', { name: leader.name }) : (tiedLead ? t('Tied for the lead') : t('In the lead')))}${gap > 0 ? '' : ' 🏆'}</div>
          <div class="big-number num">${gap > 0 ? fmtShort(gap) : ''}</div>
        </div>
      </div>
    </section>`;
}

function renderWeekStrip(name, fullPlan, dim){
  const today = todayStr();
  const baseline = fullPlan > 0 ? fullPlan / (dim || getMonthInfo(new Date()).daysInMonth) : 0;
  const days = [];
  for (let i = 6; i >= 0; i--) days.push(addDaysStr(today, -i));
  const byDay = {};
  data.entries.forEach(e => { if (e.seller === name && days.indexOf(e.date) !== -1) byDay[e.date] = (byDay[e.date] || 0) + e.amount; });
  const chips = days.map(d => {
    const amt = byDay[d] || 0;
    let cls = '';
    if (amt > 0 && (baseline === 0 || amt >= baseline)) cls = 'ok';
    else if (d < today) cls = 'short';
    const mln = (Math.round(amt / 1e5) / 10).toString();
    return `<button type="button" class="day-chip ${cls}" onclick="openCalendar(${jsArg(name)}, '${d}')" title="${esc(dayLabel(d))}: ${esc(money(amt))}">${esc(weekday(d))} ${parseYmd(d).getDate()}<b class="num">${amt ? mln : '0'}</b></button>`;
  }).join('');
  return `
    <section class="card week-card" aria-label="${esc(t('Last 7 days'))}">
      ${cardHead('calendar', esc(t('Last 7 days')), `<button type="button" class="view-all" onclick="openCalendar(${jsArg(name)}, '${today}')">${esc(t('Full calendar'))} →</button>`)}
      <div class="week-strip">${chips}</div>
      <p class="hint">${esc(t("in mln so'm"))}${baseline ? ' · ' + esc(t('Green = at or above {n}/day (plan ÷ days in month)', { n: fmtShort(baseline) })) : ''} · ${esc(t('Tap a day for details'))}</p>
    </section>`;
}

/* The pay card: what the seller earns, how, and what the next tier adds. */
function renderPayCard(name, m, stats, asAdmin){
  const info = sellerInfo(name, m);
  const past = isPast(m);
  if (!info.tiers){
    const fix = asAdmin && !past ? `
      ${errorHtml('ws-cat')}
      <div class="inline-form">
        <div class="field"><label for="ws-cat-quick">${esc(t('Category'))}</label>${categorySelect('ws-cat-quick', '', true)}</div>
        <button type="button" class="btn" onclick="saveCategoryQuick(${jsArg(name)})" ${busy ? 'disabled' : ''}>${esc(pendingKey === 'cat' ? t('Saving…') : t('Set category'))}</button>
      </div>` : `<p>${esc(asAdmin ? t('No category was set for this month.') : t('Your team leader hasn’t chosen your pay category yet. Your pay appears here once it’s set.'))}</p>`;
    return `<section class="card slash">${cardHead('wallet', esc(t('Pay')))}<p>${esc(t('Pay is calculated from the category: C · Demo class (plan 50 mln) or Other · G, O, A, B (plan 100 mln).'))}</p>${fix}</section>`;
  }
  const pay = computePay(stats.totalSold, info.plan, info.tiers, 'seller');
  const proj = past ? null : computePay(stats.forecastTotal, info.plan, info.tiers, 'seller');
  const ladder = info.tiers.map((tr, i) => `
    <tr class="${i === pay.index ? 'is-me' : ''}">
      <td>${esc(tierRange(info.tiers, i))}${i === pay.index ? ` <span class="pill role-seller">${esc(past ? t('Reached') : t('You are here'))}</span>` : ''}</td>
      <td class="num">${fmt(tr.fix)}</td>
      <td class="num">${pctText(tr.pct)}</td>
    </tr>`).join('');
  const who = asAdmin ? name : null;
  return `
    <section class="card slash pay-card" aria-label="${esc(t('Pay'))}">
      ${cardHead('wallet', esc(past ? t('Pay for {month}', { month: monthLabel(m) }) : (who ? t('{name}’s pay this month', { name: who }) : t('Your pay this month'))), `<span class="pill ok">${esc(t('Tier {r}', { r: tierRange(info.tiers, pay.index) }))}</span>`)}
      <div class="pay-top">
        <div>
          <div class="kicker">${esc(past ? t('Final') : t('Earned so far'))}</div>
          <div class="pay-total num">${money(pay.total)}</div>
          <div class="pay-break">${esc(t('Fixed {fix} + {pct} of {sold} = {total}', { fix: fmt(pay.fixed), pct: pctText(pay.tier.pct), sold: fmt(pay.sold), total: fmt(pay.total) }))}</div>
        </div>
        ${proj ? `<div class="pay-proj">
          <div class="kicker">${esc(t('At this pace by month end'))}</div>
          <div class="big-number num">≈ ${fmtShort(proj.total)}</div>
          <div class="kicker">${esc(t('{p} of plan · tier {r}', { p: pctText(proj.pct), r: tierRange(info.tiers, proj.index) }))}</div>
        </div>` : ''}
      </div>
      ${!past && pay.next ? `<div class="next-tier">${icon('target')}<span>${esc(t('Sell {amount} more to reach {p}: fixed {fix} and {pct} of sales. Pay at that point ≈ {total}.', { amount: money(pay.toNext), p: pctText(pay.next.from), fix: fmt(pay.next.fix), pct: pctText(pay.next.pct), total: fmtShort(pay.nextTotal) }))}</span></div>` : ''}
      <div class="table-wrap free"><table class="ladder">
        <thead><tr><th scope="col">${esc(t('Plan completed'))}</th><th scope="col">${esc(t("Fixed (so'm)"))}</th><th scope="col">${esc(t('% of sales'))}</th></tr></thead>
        <tbody>${ladder}</tbody>
      </table></div>
      <p class="hint">${esc(t('{cat} · plan {plan}. The % of the tier you reach applies to all your sales in the month.', { cat: catLabel(info.cat), plan: fmt(info.plan) }))}${info.pf.prorated ? ' ' + esc(t('Plan prorated: {full} ÷ {m} days × {n} days worked. Fixed pay is not reduced.', { full: fmt(info.fullPlan), m: info.pf.dim, n: info.pf.days })) : ''}</p>
    </section>`;
}

function renderSellerSales(name, asAdmin){
  const s = sellerByName(name);
  if (!s) return notFoundCard(name);
  const m = viewMonth();
  const past = isPast(m);
  const info = sellerInfo(name, m);
  const mine = data.entries.filter(e => e.seller === name);
  const stats = computeStats(mine, info.plan, m, { startDay: info.pf.startDay });
  const todaySold = sumAmounts(mine.filter(e => e.date === todayStr()));
  const quick = past ? '' : `
    <div class="quick-actions">
      <button type="button" class="btn" onclick="openSaleModal(${jsArg(name)})">${icon('plus')}<span>${esc(asAdmin ? t('Add sale for {name}', { name }) : t('Add sale'))}</span></button>
      <a class="btn btn-ghost" href="${asAdmin ? hrefFor('seller', { name, tab: 'standards' }) : hrefFor('standards')}">${icon('check')}<span>${esc(asAdmin ? t('Standards & calls') : t('Today’s standards & calls'))}</span></a>
      <a class="btn btn-ghost" href="${asAdmin ? hrefFor('seller', { name, tab: 'entries' }) : hrefFor('myentries')}">${icon('receipt')}<span>${esc(asAdmin ? t('Edit entries') : t('My entries'))}</span></a>
      ${asAdmin ? `<a class="btn btn-ghost" href="${hrefFor('seller', { name, tab: 'account' })}">${icon('target')}<span>${esc(t('Category, plan & login'))}</span></a>` : ''}
    </div>`;
  const marks = info.tiers ? info.tiers.map(x => x.from) : [];
  const mix = renderClassMix(stats.entries, t('Sales by client class'));
  const calls = renderSalesCallsCard(asAdmin ? t('{name}: sales & call time', { name }) : t('Your sales & call time'), stats.entries, data.calls.filter(c => c.seller === name), m, info.pf.startDay);
  const week = past ? '' : renderWeekStrip(name, info.fullPlan, info.pf.dim);
  if (!info.plan){
    return quick
      + `<div class="grid-2">${renderRankCard(name, m)}${week || mix}</div>`
      + calls + (week ? mix : '')
      + renderPayCard(name, m, stats, asAdmin);
  }
  const note = [info.own ? t('own plan') : '', startNote(info, m)].filter(Boolean).join(' · ');
  return quick
    + renderHero(t('Plan · {cat}', { cat: catLabel(info.cat) }), info.plan, stats, marks, note)
    + renderTierNeeds(info, stats, m)
    + renderStatTiles(stats, todaySold, false)
    + `<div class="grid-2">${renderRankCard(name, m)}${week || mix}</div>`
    + calls
    + renderChartCard(stats, asAdmin ? t('{name}’s pace', { name }) : t('Your pace'), { reward: false, guides: marks })
    + (week ? mix : '')
    + renderPayCard(name, m, stats, asAdmin);
}

/* For every pay tier: how much to sell per day, from today to month end, to reach it. */
function renderTierNeeds(info, stats, m){
  if (!info.tiers || !(info.plan > 0)) return '';
  const past = isPast(m);
  const daysLeft = stats.daysLeft;
  const points = info.tiers.map((tr, i) => ({ tr, i })).filter(x => x.tr.from > 0);
  if (!points.length) return '';
  let nextMarked = false;
  const cards = points.map(({ tr, i }) => {
    const target = info.plan * tr.from / 100;
    const left = target - stats.totalSold;
    const reached = left <= 0;
    const payAt = (Number(tr.fix) || 0) + Math.max(target, stats.totalSold) * (Number(tr.pct) || 0) / 100;
    let cls = reached ? 'is-achieved' : (past ? 'is-missed' : '');
    if (!reached && !past && !nextMarked){ cls = 'is-active'; nextMarked = true; }
    let main, detail;
    if (reached){ main = '✓ ' + t('Reached'); detail = t('{a} over', { a: fmtShort(-left) }); }
    else if (past){ main = t('{a} short', { a: fmtShort(left) }); detail = t('Missed'); }
    else if (daysLeft > 0){ main = t('{a}/day', { a: fmtShort(left / daysLeft) }); detail = t('{a} left · {d}', { a: fmtShort(left), d: cnt(daysLeft, '{n} day', '{n} days') }); }
    else { main = t('{a} left', { a: fmtShort(left) }); detail = ''; }
    const pill = reached ? `<span class="pill ok">${esc(t('Reached'))}</span>` : (cls === 'is-active' ? `<span class="pill active">${esc(t('Next'))}</span>` : '');
    return `
      <div class="tier-need ${cls}">
        <div class="tn-head"><span class="tn-pct num">${pctText(tr.from)}</span>${pill}</div>
        <div class="tn-target num">${esc(fmtShort(target))} so'm</div>
        <div class="tn-main num">${esc(main)}</div>
        <div class="tn-detail">${esc(detail)}</div>
        <div class="tn-pay num">${esc(t('Pay ≈ {n}', { n: fmtShort(payAt) }))}</div>
      </div>`;
  }).join('');
  return `
    <section class="card slash" aria-label="${esc(t('Daily sales needed for each pay tier'))}">
      ${cardHead('target', esc(past ? t('Pay tiers in {month}', { month: monthLabel(m) }) : t('Daily sales needed for each pay tier')), past ? '' : `<span class="kicker">${esc(t('From today to month end · {d} left', { d: cnt(daysLeft, '{n} day', '{n} days') }))}</span>`)}
      <div class="tier-needs">${cards}</div>
    </section>`;
}

/* Daily sales (bars) + call time (line) for one month. */
function salesCallsDays(entriesList, callsList, month){
  const info = monthInfoFor(month);
  const days = [];
  for (let d = 1; d <= info.daysInMonth; d++) days.push({ day: d, sales: 0, minutes: 0 });
  entriesList.forEach(e => { if (e.date.startsWith(month)) days[Number(e.date.slice(8, 10)) - 1].sales += e.amount; });
  callsList.forEach(c => { if (c.date.startsWith(month)) days[Number(c.date.slice(8, 10)) - 1].minutes += c.minutes; });
  return days;
}
function renderSalesCallsCard(title, entriesList, callsList, month, firstDay){
  const days = salesCallsDays(entriesList, callsList, month);
  const info = monthInfoFor(month);
  const lastDay = isPast(month) ? info.daysInMonth : getMonthInfo(new Date()).dayOfMonth;
  const totalSales = days.reduce((s, d) => s + d.sales, 0);
  const totalMin = days.reduce((s, d) => s + d.minutes, 0);
  const loggedDays = days.filter(d => d.minutes > 0).length;
  return `
    <section class="card slash" aria-label="${esc(title)}">
      ${cardHead('chart', esc(title), `<span class="kicker num">${esc(t("Sales {s} so'm · calls {c} h", { s: fmtShort(totalSales), c: fmtHM(totalMin) }))}${loggedDays ? ' · ' + esc(t('avg {c} h/day', { c: fmtHM(totalMin / loggedDays) })) : ''}</span>`)}
      ${buildSalesCallsChart(days, lastDay, firstDay)}
      <div class="legend">
        <span><i class="bar-swatch"></i>${esc(t('Sales'))}</span>
        <span><i style="border-color:var(--cc-line)"></i>${esc(t('Call time (h:mm)'))}</span>
      </div>
    </section>`;
}

function entriesTable(list, opts){
  if (!list.length) return `<p class="empty">${esc(opts.emptyText)}</p>`;
  const today = todayStr();
  const rows = list.map(e => {
    if (ui.editingEntryId === e.id){
      const sellerPick = opts.allowMove ? sellerSelect('edit-entry-seller', e.seller, 'input-sm', '', `aria-label="${esc(t('Seller'))}"`) : '';
      return `
        <tr class="sub-row">
          <td>
            <input type="date" id="edit-entry-date" class="input-sm" value="${esc(e.date)}" max="${today}" aria-label="${esc(t('Date'))}">
            ${!opts.showSeller && sellerPick ? `<div class="stack-gap">${sellerPick}</div>` : ''}
          </td>
          ${opts.showSeller ? `<td>${sellerPick || esc(e.seller)}</td>` : ''}
          <td>${classSelect('edit-entry-cls', e.cls || defaultClass(e.seller), 'input-sm', `aria-label="${esc(t('Class'))}"`)}</td>
          <td><input type="text" inputmode="numeric" id="edit-entry-amount" class="input-sm" value="${fmt(e.amount)}" oninput="formatThousandsLive(this)" onkeydown="if(event.key==='Enter')saveEntry(${jsArg(e.id)});if(event.key==='Escape'){event.stopPropagation();cancelEditEntry()}" aria-label="${esc(t('Amount'))}"></td>
          <td class="actions-cell">
            <button type="button" class="btn btn-sm" onclick="saveEntry(${jsArg(e.id)})" ${busy ? 'disabled' : ''}>${esc(pendingKey === 'entry' ? t('Saving…') : t('Save'))}</button>
            <button type="button" class="btn btn-sm btn-ghost" onclick="cancelEditEntry()">${esc(t('Cancel'))}</button>
          </td>
        </tr>`;
    }
    return `
      <tr>
        <td class="date-cell" title="${esc(e.date)}">${esc(dayLabel(e.date))}</td>
        ${opts.showSeller ? `<td>${personCell(e.seller || '—', { tab: 'entries' })}</td>` : ''}
        <td>${classPill(e.cls)}</td>
        <td class="amt-cell num">${fmt(e.amount)}</td>
        <td class="actions-cell">
          <button type="button" class="btn btn-sm btn-ghost" onclick="editEntry(${jsArg(e.id)})" aria-label="${esc(t('Edit'))} ${esc(fmt(e.amount))} · ${esc(e.date)}">${esc(t('Edit'))}</button>
          <button type="button" class="btn btn-sm btn-danger" onclick="deleteEntry(${jsArg(e.id)})" ${busy ? 'disabled' : ''} aria-label="${esc(t('Delete'))} ${esc(fmt(e.amount))} · ${esc(e.date)}">${esc(t('Delete'))}</button>
        </td>
      </tr>`;
  }).join('');
  return `
    <div class="table-wrap tall" data-scroll="${esc(opts.scrollKey || 'entries')}">
      <table>
        <thead><tr><th scope="col">${esc(t('Date'))}</th>${opts.showSeller ? `<th scope="col">${esc(t('Seller'))}</th>` : ''}<th scope="col">${esc(t('Class'))}</th><th scope="col">${esc(t("Amount (so'm)"))}</th><th scope="col"><span class="sr-only">${esc(t('Actions'))}</span></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderSellerEntries(name, asAdmin){
  const s = sellerByName(name);
  if (!s) return notFoundCard(name);
  const month = currentMonthKey();
  const today = todayStr();
  const mine = newestFirst(data.entries.filter(e => e.seller === name));
  const monthList = mine.filter(e => e.date.startsWith(month));
  const plan = sellerInfo(name, month).plan;
  return `
    <div class="two-col">
      <div class="sticky">
        <section class="card slash" aria-label="${esc(t('Add a sale'))}">
          ${cardHead('plus', esc(asAdmin ? t('Add a sale for {name}', { name }) : t('Add a sale')))}
          ${errorHtml('sale')}
          <div class="field"><label for="sale-amount">${esc(t("Amount (so'm)"))}</label><input type="text" inputmode="numeric" autocomplete="off" id="sale-amount" class="amount-input" placeholder="${esc(t('e.g. {n}', { n: '5 000 000' }))}" oninput="formatThousandsLive(this)" onkeydown="if(event.key==='Enter')submitSale(${jsArg(name)})"></div>
          <div class="field"><label for="sale-class">${esc(t('Client class'))}</label>${classSelect('sale-class', defaultClass(name))}</div>
          <div class="field"><label for="sale-date">${esc(t('Date'))}</label><input type="date" id="sale-date" value="${today}" max="${today}"></div>
          <button type="button" class="btn btn-block" onclick="submitSale(${jsArg(name)})" ${busy ? 'disabled' : ''}>${esc(pendingKey === 'sale' ? t('Saving…') : t('Save sale'))}</button>
        </section>
        <section class="card">
          <div class="kicker">${esc(asAdmin ? t('{name}’s total for {month}', { name, month: monthLabel(month) }) : t('Your total for {month}', { month: monthLabel(month) }))}</div>
          <div class="big-number num">${money(sumAmounts(monthList))}</div>
          <div class="kicker">${esc(cnt(monthList.length, '{n} sale this month', '{n} sales this month'))}${plan ? ' · ' + esc(t('plan {n}', { n: fmtShort(plan) })) : ''}</div>
        </section>
      </div>
      <section class="card" aria-label="${esc(t('Sales entries'))}">
        ${cardHead('receipt', esc(asAdmin ? t('{name}’s sales', { name }) : t('Your sales')), `<span class="kicker">${esc(cnt(mine.length, '{n} entry', '{n} entries'))}</span>`)}
        ${errorHtml('entries')}
        ${entriesTable(mine, { showSeller: false, allowMove: asAdmin, scrollKey: 'seller-entries', emptyText: t('No sales logged yet. Use the form to add the first one.') })}
        ${asAdmin ? `<p class="hint">${esc(t('As admin you can also move a sale to another seller: press Edit and pick the seller.'))}</p>` : ''}
      </section>
    </div>`;
}

function goalText(std){ return t('goal: {n} {unit} a day', { n: std.minPerDay, unit: std.unit || '' }).replace(/\s{2,}/g, ' ').trim(); }
function renderSellerStandards(name, asAdmin){
  const s = sellerByName(name);
  if (!s) return notFoundCard(name);
  const today = todayStr();
  const date = ui.activityDate[name] || today;
  const total = data.standards.length;
  const metOn = (d) => data.standards.filter(std => { const r = findActivity(d, name, std.name); return r && r.value >= std.minPerDay; }).length;
  const loggedOn = (d) => data.standards.some(std => !!findActivity(d, name, std.name)) || callMinutes(d, name) !== null;
  let met = 0;
  const fields = data.standards.map((std, idx) => {
    const rec = findActivity(date, name, std.name);
    const ok = !!rec && rec.value >= std.minPerDay;
    if (ok) met++;
    return `
      <div class="field">
        <label for="act-${idx}">${esc(std.name)} <span class="muted">· ${esc(goalText(std))}</span></label>
        <input type="number" inputmode="decimal" id="act-${idx}" step="1" min="0" value="${rec ? rec.value : ''}" placeholder="0" onkeydown="if(event.key==='Enter')submitActivity(${jsArg(name)})">
        ${rec ? `<div class="field-note ${ok ? 'ok' : 'short'}">${esc(ok ? '✓ ' + t('Goal reached') : '✗ ' + t('{n} short of the goal', { n: +(std.minPerDay - rec.value).toFixed(2) }))}</div>` : ''}
      </div>`;
  }).join('');
  const cm = callMinutes(date, name);
  const callField = `
    <div class="field">
      <label for="call-h">${esc(t('Call time'))} <span class="muted">· ${esc(t('total talk time this day'))}</span></label>
      <div class="hm-input">
        <input type="number" inputmode="numeric" id="call-h" min="0" max="24" step="1" value="${cm !== null ? Math.floor(cm / 60) : ''}" placeholder="0" aria-label="${esc(t('Hours'))}" onkeydown="if(event.key==='Enter')submitActivity(${jsArg(name)})"><span>${esc(t('h'))}</span>
        <input type="number" inputmode="numeric" id="call-m" min="0" max="59" step="1" value="${cm !== null ? cm % 60 : ''}" placeholder="00" aria-label="${esc(t('Minutes'))}" onkeydown="if(event.key==='Enter')submitActivity(${jsArg(name)})"><span>${esc(t('m'))}</span>
      </div>
      ${cm !== null ? `<div class="field-note ok">${esc(t('Logged: {t} h', { t: fmtHM(cm) }))}</div>` : ''}
    </div>`;
  const days = [];
  for (let i = 6; i >= 0; i--) days.push(addDaysStr(today, -i));
  const chips = days.map(d => {
    const mm = metOn(d);
    const c = callMinutes(d, name);
    const cls = total && mm === total ? 'ok' : ((loggedOn(d) || d < today) ? 'short' : '');
    return `<button type="button" class="day-chip ${total ? cls : (c !== null ? 'ok' : (d < today ? 'short' : ''))} ${d === date ? 'sel' : ''}" onclick="setActivityDate(${jsArg(name)}, '${d}')" aria-pressed="${d === date}" aria-label="${esc(dayLabel(d))}">${esc(weekday(d))} ${parseYmd(d).getDate()}<b class="num">${total ? `${mm}/${total}` : (c !== null ? fmtHM(c) : '—')}</b>${total ? `<small class="num">${c !== null ? fmtHM(c) : '—'}</small>` : ''}</button>`;
  }).join('');
  const history = [];
  for (let i = 0; i < 14; i++) history.push(addDaysStr(today, -i));
  const histRows = history.map(d => {
    const c = callMinutes(d, name);
    return `
    <tr class="clickable" onclick="setActivityDate(${jsArg(name)}, '${d}')">
      <td class="date-cell">${esc(dayLabel(d))}</td>
      <td class="num">${c !== null ? fmtHM(c) : '<span class="muted">—</span>'}</td>
      ${data.standards.map(std => {
        const r = findActivity(d, name, std.name);
        if (!r) return '<td class="compliance-cell none">—</td>';
        return `<td class="compliance-cell ${r.value >= std.minPerDay ? 'ok' : 'short'} num">${r.value}</td>`;
      }).join('')}
      ${total ? `<td><span class="pill ${metOn(d) === total ? 'ok' : (loggedOn(d) ? 'short' : '')}">${metOn(d)}/${total}</span></td>` : ''}
    </tr>`;
  }).join('');
  const noStd = total ? '' : `<p class="hint">${asAdmin
    ? `${esc(t('No daily standards defined yet. Add some in'))} <a href="${hrefFor('settings')}" onclick="ui.settingsTab='standards'">${esc(t('Settings → Standards'))}</a>.`
    : esc(t('Your admin hasn’t defined any daily standards yet.'))}</p>`;
  return `
    <div class="two-col">
      <div class="sticky">
        <section class="card slash" aria-label="${esc(t('Daily standards & calls'))}">
          ${cardHead('check', esc(date === today ? t('Today’s standards & calls') : t('Standards & calls for {d}', { d: shortDay(date) })), total ? `<span class="pill ${met === total ? 'ok' : 'short'}">${esc(t('{m}/{n} reached', { m: met, n: total }))}</span>` : '')}
          ${errorHtml('act')}
          <div class="field"><label for="activity-date">${esc(t('Date'))}</label><input type="date" id="activity-date" value="${esc(date)}" max="${today}" onchange="setActivityDate(${jsArg(name)}, this.value)"></div>
          ${callField}
          ${fields}
          ${noStd}
          <button type="button" class="btn btn-block" onclick="submitActivity(${jsArg(name)})" ${busy ? 'disabled' : ''}>${esc(pendingKey === 'act' ? t('Saving…') : (asAdmin ? t('Save for {name}', { name }) : t('Save')))}</button>
        </section>
      </div>
      <div>
        <section class="card" aria-label="${esc(t('Last 7 days'))}">
          ${cardHead('calendar', esc(t('Last 7 days')), `<button type="button" class="view-all" onclick="openCalendar(${jsArg(name)}, '${date}')">${esc(t('Full calendar'))} →</button>`)}
          <div class="week-strip">${chips}</div>
          <p class="hint">${esc(t('Tap a day to view or fix it'))}</p>
        </section>
        <section class="card" aria-label="${esc(t('Last 14 days'))}">
          ${cardHead('receipt', esc(t('Last 14 days')))}
          <div class="table-wrap free"><table>
            <thead><tr><th scope="col">${esc(t('Date'))}</th><th scope="col">${esc(t('Call time'))}</th>${data.standards.map(std => `<th scope="col">${esc(std.name)}<br><span class="th-sub">${esc(t('goal {n}', { n: std.minPerDay }))}</span></th>`).join('')}${total ? `<th scope="col">${esc(t('Reached'))}</th>` : ''}</tr></thead>
            <tbody>${histRows}</tbody>
          </table></div>
        </section>
      </div>
    </div>`;
}
function setActivityDate(name, v){
  if (!isDateStr(v)) return;
  if (v > todayStr()) v = todayStr();
  ui.activityDate[name] = v;
  delete errors.act;
  render({ fresh: true });
}

function viewMySales(){
  const m = viewMonth();
  return pageHead(esc(t('My sales & pay')), esc(t('Hi, {name}', { name: session.name })), '', monthSwitch())
    + pastBanner(m) + renderSellerSales(session.name, false);
}
function viewMyEntries(){
  return pageHead(esc(t('My entries')), esc(t('Log and fix your sales')), esc(t('Added a wrong amount, date or class? Press Edit on that row.')))
    + renderSellerEntries(session.name, false);
}
function viewMyStandards(){
  return pageHead(esc(t('Daily standards')), esc(t('What you did today')), esc(t('Fill these in every day. Your team leader checks them.')))
    + renderSellerStandards(session.name, false);
}

/* ---------- admin: seller workspace ---------- */

function viewWorkspace(){
  const name = route.params.name || '';
  const s = sellerByName(name);
  if (!s){
    return pageHead(esc(t('Admin')), esc(t('Seller workspaces')), esc(t('Open any seller to see and edit their sales and pay — no seller password needed.'))) + `
      ${name ? notFoundCard(name) : ''}
      <div class="team-grid">${data.sellers.map(x => `
        <a class="seller-card" href="${hrefFor('seller', { name: x.name })}" style="text-decoration:none;color:inherit">
          <div class="top"><span class="avatar">${esc(initial(x.name))}</span><div class="who"><div class="name">${esc(x.name)}</div><div class="meta">${esc(catLabel(sellerInfo(x.name, currentMonthKey()).cat))}</div></div></div>
        </a>`).join('') || `<p class="empty">${esc(t('No sellers yet.'))}</p>`}</div>`;
  }
  const tab = WS_TABS.some(x => x[0] === route.params.tab) ? route.params.tab : 'sales';
  const snap = teamRisks()[name];
  const info = sellerInfo(name, currentMonthKey());
  const tabs = `<nav class="tab-row" aria-label="${esc(t('Workspace sections'))}">${WS_TABS.map(([id, label]) =>
    `<a class="tab-btn ${tab === id ? 'active' : ''}" href="${hrefFor('seller', { name, tab: id })}" ${tab === id ? 'aria-current="page"' : ''}>${esc(t(label))}</a>`).join('')}</nav>`;
  let body;
  if (tab === 'entries') body = renderSellerEntries(name, true);
  else if (tab === 'standards') body = renderSellerStandards(name, true);
  else if (tab === 'account') body = renderSellerAccount(name);
  else body = (tab === 'sales' ? `<div class="toolbar">${monthSwitch()}</div>` + pastBanner(viewMonth()) : '') + renderSellerSales(name, true);
  return `
    <div class="banner banner-admin" role="note"><span><strong>${esc(t('Admin view'))}</strong>${esc(t('You’re working inside {name}’s workspace. Everything you change is saved as “admin” in the audit log.', { name }))}</span></div>
    <section class="card slash ws-card" aria-label="${esc(t('Seller'))}">
      <div class="ws-head">
        <span class="avatar lg">${esc(initial(name))}</span>
        <div>
          <div class="ws-name">${esc(name)}</div>
          <div class="ws-meta">
            ${riskPill(snap.risk)}
            ${catPill(info.cat)}
            <span class="pill plain num">${info.plan ? esc(t('Plan {n}', { n: money(info.plan) })) : esc(t('No plan'))}</span>
            ${startNote(info, currentMonthKey()) ? `<span class="pill plain">${esc(startNote(info, currentMonthKey()))}</span>` : ''}
            <span class="pill plain">${s.hasLogin ? esc(t('Login: {u}', { u: s.username || '✓' })) : esc(t('No login'))}</span>
          </div>
        </div>
        <div class="ws-switch">
          <label class="sr-only" for="ws-switch">${esc(t('Switch seller'))}</label>
          ${sellerSelect('ws-switch', name, '', '', 'data-fixed onchange="switchWorkspace(this.value)"')}
        </div>
      </div>
    </section>
    ${tabs}
    ${body}`;
}
function switchWorkspace(name){
  if (!name) return;
  const tab = WS_TABS.some(x => x[0] === route.params.tab) ? route.params.tab : undefined;
  navigate('seller', { name, tab });
}

function categorySelect(id, selected, withLater, extra){
  const opts = [['C', t('C · Demo class (plan {n})', { n: fmtShort(defaultCatPlan('C')) })], ['OTHER', t('Other · G, O, A, B (plan {n})', { n: fmtShort(defaultCatPlan('OTHER')) })]];
  return `<select id="${id}" ${extra || ''}>
    ${withLater ? `<option value="" ${!selected ? 'selected' : ''}>${esc(t('Not set yet'))}</option>` : ''}
    ${opts.map(([v, l]) => `<option value="${v}" ${selected === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
  </select>`;
}
function defaultCatPlan(cat){ const c = cfgFor(currentMonthKey()); return c.categories && c.categories[cat] ? c.categories[cat].plan : 0; }

function renderSellerAccount(name){
  const s = sellerByName(name);
  if (!s) return notFoundCard(name);
  const month = currentMonthKey();
  const a = (cfgFor(month).sellers || {})[name] || { cat: '', plan: 0 };
  return `
    <div class="grid-2">
      <section class="card" aria-label="${esc(t('Category & plan'))}">
        ${cardHead('target', esc(t('Category & plan')))}
        ${errorHtml('acct-plan')}
        <div class="field"><label for="acct-cat">${esc(t('Pay category'))}</label>${categorySelect('acct-cat', a.cat, true)}</div>
        <div class="field"><label for="acct-plan">${esc(t("Own plan (so'm)"))}</label><input type="text" inputmode="numeric" id="acct-plan" class="amount-input" value="${Number(a.plan) > 0 ? fmt(a.plan) : ''}" placeholder="${esc(t('Empty = category plan'))}" autocomplete="off" oninput="formatThousandsLive(this)" onkeydown="if(event.key==='Enter')saveSellerPlan(${jsArg(name)})"></div>
        <div class="field"><label for="acct-start">${esc(t('Start date'))}</label><input type="date" id="acct-start" value="${esc(s.startDate || '')}"></div>
        <p class="hint" style="margin-top:-6px !important;margin-bottom:12px !important">${esc(t('In the start month the plan is prorated: monthly plan ÷ days in month × days from the start date. Leave empty if they worked the whole month.'))}</p>
        <button type="button" class="btn" onclick="saveSellerPlan(${jsArg(name)})" ${busy ? 'disabled' : ''}>${esc(pendingKey === 'plan' ? t('Saving…') : t('Save'))}</button>
        <p class="hint">${esc(t('Applies from {month} on. Earlier months keep their own category and plan.', { month: monthLabel(month) }))}</p>
      </section>
      <section class="card" aria-label="${esc(t('Name'))}">
        ${cardHead('user', esc(t('Name')))}
        ${errorHtml('acct-name')}
        <div class="field"><label for="acct-name">${esc(t('Seller name'))}</label><input type="text" id="acct-name" value="${esc(name)}" autocomplete="off" onkeydown="if(event.key==='Enter')renameSeller(${jsArg(name)})"></div>
        <button type="button" class="btn" onclick="renameSeller(${jsArg(name)})" ${busy ? 'disabled' : ''}>${esc(pendingKey === 'rename' ? t('Saving…') : t('Rename'))}</button>
        <p class="hint">${esc(t('Renames everywhere: sales, pay history, standards and the leaderboard. {name} logs in again with the same username.', { name }))}</p>
      </section>
    </div>
    <section class="card" aria-label="${esc(t('Login'))}">
      ${cardHead('key', esc(t('Login')), s.hasLogin ? `<span class="pill ok">${esc(t('Username: {u}', { u: s.username || '✓' }))}</span>` : `<span class="pill needsattention">${esc(t('No login yet'))}</span>`)}
      ${errorHtml('acct-login')}
      <div class="form-grid">
        <div class="field"><label for="acct-username">${esc(t('Username'))}</label><input type="text" id="acct-username" value="${esc(s.username || '')}" autocomplete="off" autocapitalize="none" spellcheck="false"></div>
        <div class="field"><label for="acct-password">${esc(t('New password'))}</label><input type="password" id="acct-password" autocomplete="new-password"></div>
        <div class="field"><label for="acct-password2">${esc(t('Confirm password'))}</label><input type="password" id="acct-password2" autocomplete="new-password" onkeydown="if(event.key==='Enter')saveLogin(${jsArg(name)})"></div>
      </div>
      <div class="button-row">
        <button type="button" class="btn" onclick="saveLogin(${jsArg(name)})" ${busy ? 'disabled' : ''}>${esc(pendingKey === 'login' ? t('Saving…') : (s.hasLogin ? t('Reset login') : t('Create login')))}</button>
        ${s.hasLogin ? `<button type="button" class="btn btn-danger" onclick="removeLogin(${jsArg(name)})" ${busy ? 'disabled' : ''}>${esc(t('Remove login'))}</button>` : ''}
      </div>
      <p class="hint">${esc(t('Passwords are stored hashed — nobody can read them, including you. Resetting logs {name} out on every device.', { name }))}</p>
    </section>
    <section class="card danger-zone" aria-label="${esc(t('Danger zone'))}">
      ${cardHead('alert', esc(t('Danger zone')))}
      <p>${esc(t('Remove {name} from the team. Their past sales stay on record and still count toward the team total; their login stops working immediately.', { name }))}</p>
      <button type="button" class="btn btn-danger-solid" onclick="deleteSeller(${jsArg(name)})" ${busy ? 'disabled' : ''}>${icon('trash')}<span>${esc(t('Remove {name}', { name }))}</span></button>
    </section>`;
}

/* ---------- admin: entries ---------- */

function viewEntries(){
  const tabs = [['list', 'All entries'], ['bulk', 'Bulk entry']];
  if (!tabs.some(x => x[0] === ui.entriesTab)) ui.entriesTab = 'list';
  const tabRow = `<div class="tab-row" role="tablist">${tabs.map(([id, label]) =>
    `<button type="button" role="tab" aria-selected="${ui.entriesTab === id}" class="tab-btn ${ui.entriesTab === id ? 'active' : ''}" onclick="setEntriesTab('${id}')">${esc(t(label))}</button>`).join('')}</div>`;
  const head = pageHead(esc(t('Entries')), esc(t('Sales entries')), esc(t('Add, fix, move or remove any seller’s sales. Every change is recorded in the audit log.')));
  if (!data.sellers.length) return head + `<section class="card"><p>${esc(t('Add sellers in Team first.'))}</p></section>`;
  return head + tabRow + (ui.entriesTab === 'bulk' ? bulkCard() : quickAddCard() + entriesListCard());
}
function setEntriesTab(x){ ui.entriesTab = x; resetEditing(); errors = {}; render({ fresh: true }); }

function quickAddCard(){
  const today = todayStr();
  return `
    <section class="card slash" aria-label="${esc(t('Quick add a sale'))}">
      ${cardHead('plus', esc(t('Quick add a sale')), `<span class="kicker">${esc(t('Pick a seller, type the amount, press Enter'))}</span>`)}
      ${errorHtml('qa')}
      <div class="form-grid">
        <div class="field"><label for="qa-seller">${esc(t('Seller'))}</label>${sellerSelect('qa-seller', '', '', t('Choose a seller…'), 'onchange="qaSellerChange(this.value)"')}</div>
        <div class="field"><label for="qa-amount">${esc(t("Amount (so'm)"))}</label><input type="text" inputmode="numeric" autocomplete="off" id="qa-amount" class="amount-input" placeholder="${esc(t('e.g. {n}', { n: '5 000 000' }))}" oninput="formatThousandsLive(this)" onkeydown="if(event.key==='Enter')submitQuickAdd()"></div>
        <div class="field"><label for="qa-class">${esc(t('Client class'))}</label>${classSelect('qa-class', 'O')}</div>
        <div class="field"><label for="qa-date">${esc(t('Date'))}</label><input type="date" id="qa-date" value="${today}" max="${today}"></div>
        <div class="field"><button type="button" class="btn btn-block" onclick="submitQuickAdd()" ${busy ? 'disabled' : ''}>${esc(pendingKey === 'qa' ? t('Saving…') : t('Add sale'))}</button></div>
      </div>
    </section>`;
}
function qaSellerChange(v){
  const el = document.getElementById('qa-class');
  if (el && v) el.value = defaultClass(v);
  const amt = document.getElementById('qa-amount');
  if (amt) amt.focus();
}

function entriesListCard(){
  const month = currentMonthKey();
  const prevKey = addMonths(month, -1);
  let list = data.entries.slice();
  if (ui.entrySeller) list = list.filter(e => e.seller === ui.entrySeller);
  if (ui.entryPeriod === 'month') list = list.filter(e => e.date.startsWith(month));
  else if (ui.entryPeriod === 'last') list = list.filter(e => e.date.startsWith(prevKey));
  else if (ui.entryPeriod === 'today') list = list.filter(e => e.date === todayStr());
  list = newestFirst(list);
  const names = Array.from(new Set(sellerNames().concat(data.entries.map(e => e.seller)).filter(Boolean)));
  const periodOpts = [['today', 'Today'], ['month', 'This month'], ['last', 'Last month'], ['all', 'All time']];
  return `
    <section class="card" aria-label="${esc(t('All entries'))}">
      <div class="filter-row">
        <div class="field"><label for="entry-seller-filter">${esc(t('Seller'))}</label>
          <select id="entry-seller-filter" onchange="setEntryFilter('seller', this.value)">
            <option value="">${esc(t('All sellers'))}</option>
            ${names.map(n => `<option value="${esc(n)}" ${ui.entrySeller === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label for="entry-period-filter">${esc(t('Period'))}</label>
          <select id="entry-period-filter" onchange="setEntryFilter('period', this.value)">
            ${periodOpts.map(([v, l]) => `<option value="${v}" ${ui.entryPeriod === v ? 'selected' : ''}>${esc(t(l))}</option>`).join('')}
          </select>
        </div>
        <div class="filter-summary"><strong class="num">${money(sumAmounts(list))}</strong>${esc(cnt(list.length, '{n} entry', '{n} entries'))}</div>
      </div>
      ${errorHtml('entries')}
      ${entriesTable(list, { showSeller: true, allowMove: true, scrollKey: 'all-entries', emptyText: t('No entries match these filters.') })}
    </section>`;
}
function setEntryFilter(kind, v){
  if (kind === 'seller') ui.entrySeller = v;
  else ui.entryPeriod = v;
  ui.editingEntryId = null;
  render({ fresh: true });
}

function bulkCard(){
  const today = todayStr();
  const date = ui.bulkDate && ui.bulkDate <= today ? ui.bulkDate : today;
  const month = currentMonthKey();
  const onDate = {}, monthBy = {};
  data.entries.forEach(e => {
    if (e.date === date) onDate[e.seller] = (onDate[e.seller] || 0) + e.amount;
    if (e.date.startsWith(month)) monthBy[e.seller] = (monthBy[e.seller] || 0) + e.amount;
  });
  const rows = data.sellers.map((s, i) => `
    <tr class="bulk-row">
      <td>${personCell(s.name, { tab: 'entries' })}</td>
      <td class="num hide-sm">${fmt(monthBy[s.name] || 0)}</td>
      <td class="num hide-sm">${onDate[s.name] ? fmt(onDate[s.name]) : '<span class="muted">—</span>'}</td>
      <td>${classSelect('bulk-cls-' + i, defaultClass(s.name), 'input-sm bulk-cls', `aria-label="${esc(t('Class for {name}', { name: s.name }))}"`)}</td>
      <td><input type="text" inputmode="numeric" id="bulk-amt-${i}" data-seller="${esc(s.name)}" data-i="${i}" class="input-sm bulk-amt num" placeholder="0" autocomplete="off" oninput="formatThousandsLive(this);updateBulkTotal()" onkeydown="bulkKey(event, ${i})" aria-label="${esc(t('Amount for {name}', { name: s.name }))}"></td>
    </tr>`).join('');
  return `
    <section class="card slash" aria-label="${esc(t('Bulk entry'))}">
      ${cardHead('layers', esc(t('Bulk entry')), `<span class="kicker">${esc(t('One amount per seller · empty rows are skipped'))}</span>`)}
      <p>${esc(t('Type each seller’s sales for one day and save them all at once. Every amount is added as a new sale — sales already logged are not changed. Enter jumps to the next seller.'))}</p>
      ${errorHtml('bulk')}
      <div class="filter-row"><div class="field"><label for="bulk-date">${esc(t('Date'))}</label><input type="date" id="bulk-date" value="${date}" max="${today}" onchange="setBulkDate(this.value)"></div></div>
      <div class="table-wrap free"><table>
        <thead><tr><th scope="col">${esc(t('Seller'))}</th><th scope="col" class="hide-sm">${esc(t('This month'))}</th><th scope="col" class="hide-sm">${esc(t('Already on {d}', { d: shortDay(date) }))}</th><th scope="col">${esc(t('Class'))}</th><th scope="col" style="text-align:right">${esc(t("Add (so'm)"))}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="bulk-foot">
        <div>
          <div class="kicker">${esc(t('Total to add'))}</div>
          <div class="bulk-total num" id="bulk-total">0 so'm</div>
          <div class="kicker" id="bulk-count">${esc(t('No amounts yet'))}</div>
        </div>
        <div class="button-row" style="margin-top:0">
          <button type="button" class="btn btn-ghost" onclick="clearBulk()" ${busy ? 'disabled' : ''}>${esc(t('Clear'))}</button>
          <button type="button" class="btn" id="bulk-save" onclick="submitBulk()" ${busy ? 'disabled' : ''}>${esc(pendingKey === 'bulk' ? t('Saving…') : t('Save all'))}</button>
        </div>
      </div>
    </section>`;
}
function setBulkDate(v){ if (isDateStr(v)){ ui.bulkDate = v; render(); } }
function bulkInputs(){ return Array.prototype.slice.call(document.querySelectorAll('.bulk-amt')); }
function updateBulkTotal(){
  let total = 0, count = 0;
  bulkInputs().forEach(el => { const n = parseFormattedNumber(el.value); if (n > 0){ total += n; count++; } });
  const tt = document.getElementById('bulk-total');
  const c = document.getElementById('bulk-count');
  const b = document.getElementById('bulk-save');
  if (tt) tt.textContent = money(total);
  if (c) c.textContent = count ? cnt(count, '{n} sale will be added', '{n} sales will be added') : t('No amounts yet');
  if (b && !busy) b.textContent = count ? cnt(count, 'Save {n} sale', 'Save {n} sales') : t('Save all');
}
function bulkKey(event, i){
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const next = document.getElementById('bulk-amt-' + (i + 1));
  if (next) next.focus(); else submitBulk();
}
function clearBulk(){
  bulkInputs().forEach(el => { el.value = ''; resetFields.add(el.id); });
  delete errors.bulk;
  render();
}

/* ---------- admin: team ---------- */

function viewTeam(){
  const map = teamRisks();
  const q = ui.teamQuery.trim().toLowerCase();
  const f = ui.teamFilter;
  const month = currentMonthKey();
  const matchesFilter = (s) => {
    if (f === 'all') return true;
    if (f === 'C' || f === 'OTHER') return map[s.name].info.cat === f;
    if (f === 'nocat') return !map[s.name].info.cat;
    if (f === 'nologin') return !s.hasLogin;
    const r = map[s.name].risk;
    return !!r && r.level === f;
  };
  const list = data.sellers.filter(s => (!q || s.name.toLowerCase().indexOf(q) !== -1 || (s.username || '').toLowerCase().indexOf(q) !== -1) && matchesFilter(s));
  const count = (fn) => data.sellers.filter(fn).length;
  const lvl = (l) => count(s => map[s.name].risk && map[s.name].risk.level === l);
  const filterOpts = [
    ['all', 'All sellers', data.sellers.length],
    ['critical', 'Critical', lvl('critical')], ['atrisk', 'At risk', lvl('atrisk')], ['needsattention', 'Need attention', lvl('needsattention')], ['ontrack', 'On track', lvl('ontrack')],
    ['C', 'C · Demo class', count(s => map[s.name].info.cat === 'C')], ['OTHER', 'Other · G, O, A, B', count(s => map[s.name].info.cat === 'OTHER')],
    ['nocat', 'No category', count(s => !map[s.name].info.cat)], ['nologin', 'No login', count(s => !s.hasLogin)],
  ];
  const cards = list.map(s => {
    const x = map[s.name];
    const ws = hrefFor('seller', { name: s.name });
    const pay = payFor(s.name, month);
    return `
      <article class="seller-card">
        <div class="top">
          <span class="avatar">${esc(initial(s.name))}</span>
          <div class="who"><a class="name person" href="${ws}">${esc(s.name)}</a><div class="meta">${esc(catLabel(x.info.cat))}${startNote(x.info, month) ? ' · ' + esc(startNote(x.info, month)) : ''}</div></div>
          ${riskPill(x.risk)}
        </div>
        <div class="nums"><span>${esc(t('Sold'))} <strong class="num">${fmtShort(x.stats.totalSold)}</strong></span><span>${esc(t('Plan'))} <strong class="num">${x.info.plan ? fmtShort(x.info.plan) : '—'}</strong></span></div>
        ${x.info.plan ? pctCell(x.stats.totalSold, x.info.plan) : `<div class="kicker">${esc(t('No plan yet'))}</div>`}
        <div class="nums"><span>${esc(t('Today'))} <strong class="num">${fmtShort(x.todaySold)}</strong></span><span>${esc(t('Pay so far'))} <strong class="num">${pay ? fmtShort(pay.total) : '—'}</strong></span></div>
        <div class="card-actions">
          <a class="btn btn-sm" href="${ws}">${esc(t('Open workspace'))}</a>
          <button type="button" class="btn btn-sm btn-ghost" onclick="openSaleModal(${jsArg(s.name)})">${icon('plus')}<span>${esc(t('Sale'))}</span></button>
        </div>
      </article>`;
  }).join('');
  return pageHead(esc(t('Team')), esc(t('Sellers')), esc(t('Open a seller’s workspace to see and edit everything as admin.')),
      `<button type="button" class="btn" onclick="openAddSeller()">${icon('plus')}<span>${esc(t('Add seller'))}</span></button>`) + `
    <section class="card">
      <div class="filter-row" style="margin-bottom:0">
        <div class="field" style="flex:1 1 240px"><label for="team-q">${esc(t('Search'))}</label><input type="search" id="team-q" value="${esc(ui.teamQuery)}" placeholder="${esc(t('Name or username…'))}" autocomplete="off" oninput="setTeamQuery(this.value)"></div>
        <div class="field"><label for="team-filter">${esc(t('Show'))}</label>
          <select id="team-filter" onchange="setTeamFilter(this.value)">
            ${filterOpts.map(([v, l, n]) => `<option value="${v}" ${f === v ? 'selected' : ''}>${esc(t(l))} (${n})</option>`).join('')}
          </select>
        </div>
        <div class="filter-summary"><strong class="num">${list.length}</strong>${esc(t('of {n}', { n: data.sellers.length }))}</div>
      </div>
    </section>
    ${list.length ? `<div class="team-grid">${cards}</div>` : `<section class="card"><p class="empty">${esc(data.sellers.length ? t('No sellers match. Clear the search or filter.') : t('No sellers yet. Press “Add seller” to add your first one.'))}</p></section>`}`;
}
function setTeamQuery(v){ ui.teamQuery = v; render(); }
function setTeamFilter(v){ ui.teamFilter = v; render(); }

/* ---------- admin: salaries ---------- */

function viewSalaries(){
  const m = viewMonth();
  const past = isPast(m);
  let totFix = 0, totCom = 0, totAll = 0, totSold = 0;
  const rows = data.sellers.map(s => {
    const info = sellerInfo(s.name, m);
    const sold = sumAmounts(monthSales(m, s.name));
    totSold += sold;
    const pay = info.tiers ? computePay(sold, info.plan, info.tiers, 'seller') : null;
    if (pay){ totFix += pay.fixed; totCom += pay.commission; totAll += pay.total; }
    let proj = null;
    if (pay && !past){
      const st = computeStats(data.entries.filter(e => e.seller === s.name), info.plan, m, { startDay: info.pf.startDay });
      proj = computePay(st.forecastTotal, info.plan, info.tiers, 'seller');
    }
    return `
      <tr>
        <td>${personCell(s.name, { tab: 'sales' })}<div class="sub-line">${catPill(info.cat)}</div></td>
        <td class="num"><strong>${fmt(sold)}</strong><div class="sub-line muted">${info.plan ? esc(t('of {n}', { n: fmtShort(info.plan) })) : esc(t('No plan'))}${info.pf.prorated ? ' · ' + esc(t('{n}/{m} days', { n: info.pf.days, m: info.pf.dim })) : ''}</div></td>
        <td>${info.plan ? pctCell(sold, info.plan) : '—'}</td>
        <td class="num">${pay ? `${esc(tierRange(info.tiers, pay.index))}<div class="sub-line muted">${esc(t('{f} + {p}', { f: fmtShort(pay.tier.fix), p: pctText(pay.tier.pct) }))}</div>` : '—'}</td>
        <td class="num hide-sm">${pay ? fmt(pay.fixed) : '—'}</td>
        <td class="num hide-sm">${pay ? fmt(pay.commission) : '—'}</td>
        <td class="amt-cell num">${pay ? fmt(pay.total) : `<a href="${hrefFor('seller', { name: s.name, tab: 'account' })}">${esc(t('Set category'))}</a>`}</td>
        ${past ? '' : `<td class="num hide-sm">${proj ? '≈ ' + fmtShort(proj.total) : '—'}</td>`}
      </tr>`;
  }).join('');
  const lp = leaderPayFor(m);
  return pageHead(esc(t('Salaries')), esc(t('Pay for {month}', { month: monthLabel(m) })), esc(past ? t('Final pay for each seller, from the rules that month had.') : t('Pay earned so far this month, and where each seller is heading at the current pace.')), monthSwitch())
    + pastBanner(m) + `
    <section class="stat-grid" aria-label="${esc(t('Totals'))}">
      <div class="stat-tile"><div class="stat-label">${esc(t('Team sales'))}</div><div class="stat-value num">${fmt(totSold)}</div><div class="stat-sub">${esc(t('Leader plan {p} done', { p: lp ? pctText(lp.pct) : '—' }))}</div></div>
      <div class="stat-tile"><div class="stat-label">${esc(t('Sellers’ pay'))}</div><div class="stat-value num">${fmt(totAll)}</div><div class="stat-sub">${esc(t('Fixed {f} + % {c}', { f: fmtShort(totFix), c: fmtShort(totCom) }))}</div></div>
      <div class="stat-tile"><div class="stat-label">${esc(t('Team leader'))}</div><div class="stat-value num">${lp ? fmt(lp.total) : '—'}</div><div class="stat-sub">${lp ? esc(t('{pct} of all sales{bonus}', { pct: pctText(lp.tier.pct), bonus: lp.fixed ? ' + ' + t('bonus {b}', { b: fmtShort(lp.fixed) }) : '' })) : ''}</div></div>
      <div class="stat-tile"><div class="stat-label">${esc(t('Total payroll'))}</div><div class="stat-value num">${fmt(totAll + (lp ? lp.total : 0))}</div><div class="stat-sub">${esc(totSold ? t('{p}% of team sales', { p: ((totAll + (lp ? lp.total : 0)) / totSold * 100).toFixed(1) }) : '—')}</div></div>
    </section>
    <section class="card slash" aria-label="${esc(t('Sellers’ pay'))}">
      ${cardHead('wallet', esc(t('Sellers’ pay')), `<a class="view-all" href="${hrefFor('settings')}" onclick="ui.settingsTab='pay'">${esc(t('Edit pay rules'))} →</a>`)}
      <div class="table-wrap free"><table>
        <thead><tr><th scope="col">${esc(t('Seller'))}</th><th scope="col">${esc(t('Sold'))}</th><th scope="col">${esc(t('Of plan'))}</th><th scope="col">${esc(t('Tier'))}</th><th scope="col" class="hide-sm">${esc(t('Fixed'))}</th><th scope="col" class="hide-sm">${esc(t('From sales'))}</th><th scope="col">${esc(t('Total'))}</th>${past ? '' : `<th scope="col" class="hide-sm">${esc(t('At this pace'))}</th>`}</tr></thead>
        <tbody>${rows || `<tr class="empty-row"><td colspan="8">${esc(t('No sellers yet.'))}</td></tr>`}</tbody>
      </table></div>
    </section>
    ${renderLeaderCard(m)}`;
}

/* ---------- admin: compliance ---------- */

function viewCompliance(){
  const today = todayStr();
  if (!ui.complianceDate || ui.complianceDate > today) ui.complianceDate = today;
  const date = ui.complianceDate;
  const head = pageHead(esc(t('Compliance')), esc(t('Daily standards check')), esc(t('What each seller logged for the selected day, against the daily goals.')));
  if (!data.standards.length && !data.calls.length) return head + `<section class="card"><p>${esc(t('No daily standards defined yet. Add some in'))} <a href="${hrefFor('settings')}" onclick="ui.settingsTab='standards'">${esc(t('Settings → Standards'))}</a>.</p></section>`;
  if (!data.sellers.length) return head + `<section class="card"><p>${esc(t('Add sellers in Team first.'))}</p></section>`;
  const salesBySeller = {};
  data.entries.forEach(e => { if (e.date === date) salesBySeller[e.seller] = (salesBySeller[e.seller] || 0) + e.amount; });
  let metCells = 0;
  const totalCells = data.sellers.length * data.standards.length;
  const rows = data.sellers.map(s => {
    let met = 0;
    const cells = data.standards.map(std => {
      const rec = findActivity(date, s.name, std.name);
      if (!rec) return `<td class="compliance-cell none">—</td>`;
      const ok = rec.value >= std.minPerDay;
      if (ok) met++;
      return `<td class="compliance-cell ${ok ? 'ok' : 'short'} num">${rec.value}</td>`;
    }).join('');
    metCells += met;
    const all = met === data.standards.length;
    return `
      <tr>
        <td>${personCell(s.name, { tab: 'standards' })}</td>
        <td class="num">${salesBySeller[s.name] ? fmt(salesBySeller[s.name]) : '<span class="muted">—</span>'}</td>
        <td class="num">${callMinutes(date, s.name) !== null ? fmtHM(callMinutes(date, s.name)) : '<span class="muted">—</span>'}</td>
        ${cells}
        <td>${data.standards.length ? `<span class="pill ${all ? 'ok' : 'short'}">${met}/${data.standards.length}</span>` : '—'}</td>
        <td class="actions-cell"><button type="button" class="btn btn-sm btn-ghost" onclick="openStandardsFor(${jsArg(s.name)}, '${date}')">${esc(all ? t('View') : t('Fill in'))}</button></td>
      </tr>`;
  }).join('');
  const teamPct = totalCells ? Math.round(metCells / totalCells * 100) : 0;
  const teamCalls = data.calls.filter(c => c.date === date).reduce((a, c) => a + c.minutes, 0);
  return head + `
    <section class="card slash" aria-label="${esc(t('Compliance'))}">
      <div class="filter-row">
        <div class="field"><label for="compliance-date">${esc(t('Date'))}</label><input type="date" id="compliance-date" value="${esc(date)}" max="${today}" onchange="onComplianceDateChange(this.value)"></div>
        <div class="filter-summary"><strong class="num">${teamPct}%</strong>${esc(t('{m} of {n} goals reached', { m: metCells, n: totalCells }))} · ${esc(t('team calls {c} h', { c: fmtHM(teamCalls) }))}</div>
      </div>
      <div class="table-wrap free"><table>
        <thead><tr>
          <th scope="col">${esc(t('Seller'))}</th><th scope="col">${esc(t('Sales'))}</th><th scope="col">${esc(t('Call time'))}</th>
          ${data.standards.map(std => `<th scope="col">${esc(std.name)}<br><span class="th-sub">${esc(t('goal {n}', { n: std.minPerDay }))}${std.unit ? ' ' + esc(std.unit) : ''}</span></th>`).join('')}
          <th scope="col">${esc(t('Reached'))}</th><th scope="col"><span class="sr-only">${esc(t('Actions'))}</span></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </section>`;
}
function onComplianceDateChange(v){ if (!isDateStr(v)) return; ui.complianceDate = v; render({ fresh: true }); }
function openStandardsFor(name, date){ ui.activityDate[name] = date; navigate('seller', { name, tab: 'standards' }); }

/* ---------- settings ---------- */

function viewSettings(){
  if (!isAdmin()) return pageHead(esc(t('Settings')), esc(t('Settings')), '') + appearanceCard() + accountCard() + (DEMO ? demoCard() : '');
  const tabs = [['pay', 'Plans & pay'], ['standards', 'Standards'], ['audit', 'Audit log'], ['appearance', 'Language & theme'], ['account', 'Account']];
  if (!tabs.some(x => x[0] === ui.settingsTab)) ui.settingsTab = 'pay';
  const tabRow = `<div class="tab-row" role="tablist">${tabs.map(([id, label]) =>
    `<button type="button" role="tab" aria-selected="${ui.settingsTab === id}" class="tab-btn ${ui.settingsTab === id ? 'active' : ''}" onclick="setSettingsTab('${id}')">${esc(t(label))}</button>`).join('')}</div>`;
  let body;
  if (ui.settingsTab === 'pay') body = payEditor();
  else if (ui.settingsTab === 'standards') body = standardsCard();
  else if (ui.settingsTab === 'audit') body = auditCard();
  else if (ui.settingsTab === 'appearance') body = appearanceCard();
  else body = accountCard() + (DEMO ? demoCard() : '');
  return pageHead(esc(t('Settings')), esc(t('Settings')), '') + tabRow + body;
}
function setSettingsTab(x){ ui.settingsTab = x; ui.editingStandardName = null; ui.payDraft = null; errors = {}; render({ fresh: true }); }

/* --- plans & pay editor --- */

function payEditMonth(){
  const cur = currentMonthKey();
  if (!ui.payMonth || ui.payMonth > addMonths(cur, 1)) ui.payMonth = cur;
  return ui.payMonth;
}
function draftFor(month){
  if (ui.payDraft && ui.payDraft.month === month) return ui.payDraft;
  const c = JSON.parse(JSON.stringify(cfgFor(month)));
  const def = { C: { plan: 50000000, tiers: [{ from: 0, fix: 0, pct: 0 }] }, OTHER: { plan: 100000000, tiers: [{ from: 0, fix: 0, pct: 0 }] } };
  ui.payDraft = {
    month,
    teamPlan: Number(c.teamPlan) || 0,
    leaderPlan: Number(c.leaderPlan) || 0,
    categories: { C: (c.categories && c.categories.C) || def.C, OTHER: (c.categories && c.categories.OTHER) || def.OTHER },
    leader: { tiers: ((c.leader && c.leader.tiers) || [{ from: 0, pct: 0, bonus: 0 }]).map(x => Object.assign({}, x)) },
  };
  return ui.payDraft;
}
function setPayMonth(m){ syncPayDraft(); ui.payMonth = m; ui.payDraft = null; delete errors.pay; render({ fresh: true }); }
function numIn(id){ return parseFormattedNumber(val(id)); }
function decIn(id){ const v = val(id).replace(',', '.').trim(); return v === '' ? NaN : Number(v); }
/* Copies what is typed in the editor back into the draft (before add/remove/save). */
function syncPayDraft(){
  const d = ui.payDraft;
  if (!d || !document.getElementById('pc-team')) return;
  d.teamPlan = numIn('pc-team');
  d.leaderPlan = val('pc-leader').trim() === '' ? 0 : numIn('pc-leader');
  CATS.forEach(k => {
    const c = d.categories[k];
    c.plan = numIn('pc-' + k + '-plan');
    c.tiers = c.tiers.map((x, i) => ({ from: decIn(`pc-${k}-from-${i}`), fix: numIn(`pc-${k}-fix-${i}`), pct: decIn(`pc-${k}-pct-${i}`) }));
  });
  d.leader.tiers = d.leader.tiers.map((x, i) => ({ from: decIn(`pc-L-from-${i}`), pct: decIn(`pc-L-pct-${i}`), bonus: numIn(`pc-L-bonus-${i}`) }));
}
function addTier(kind){
  syncPayDraft();
  const d = ui.payDraft;
  const list = kind === 'L' ? d.leader.tiers : d.categories[kind].tiers;
  const last = list[list.length - 1] || { from: 0, pct: 0, fix: 0, bonus: 0 };
  const next = Object.assign({}, last, { from: (Number(last.from) || 0) + 20 });
  list.push(next);
  render({ fresh: true });
}
function removeTier(kind, i){
  syncPayDraft();
  const d = ui.payDraft;
  const list = kind === 'L' ? d.leader.tiers : d.categories[kind].tiers;
  if (list.length <= 1 || i === 0) return;
  list.splice(i, 1);
  render({ fresh: true });
}
function tierTable(kind, tiers){
  const leader = kind === 'L';
  const rows = tiers.map((x, i) => {
    const next = tiers[i + 1];
    const upto = next && isFinite(next.from) ? '→ ' + pctText(next.from - (Number.isInteger(next.from) && Number.isInteger(x.from) ? 1 : 0.1)) : esc(t('and above'));
    return `
      <tr>
        <td><div class="tier-from"><input type="text" inputmode="decimal" id="pc-${kind}-from-${i}" class="input-sm num" value="${isFinite(x.from) ? x.from : ''}" ${i === 0 ? 'readonly' : ''} aria-label="${esc(t('From % of plan'))}"><span class="muted">% ${upto}</span></div></td>
        ${leader ? '' : `<td><input type="text" inputmode="numeric" id="pc-${kind}-fix-${i}" class="input-sm num" value="${isFinite(x.fix) ? fmt(x.fix) : ''}" oninput="formatThousandsLive(this)" aria-label="${esc(t("Fixed (so'm)"))}"></td>`}
        <td><input type="text" inputmode="decimal" id="pc-${kind}-pct-${i}" class="input-sm num" value="${isFinite(x.pct) ? x.pct : ''}" aria-label="${esc(t('% of sales'))}"></td>
        ${leader ? `<td><input type="text" inputmode="numeric" id="pc-${kind}-bonus-${i}" class="input-sm num" value="${isFinite(x.bonus) ? fmt(x.bonus) : ''}" oninput="formatThousandsLive(this)" aria-label="${esc(t('Bonus'))}"></td>` : ''}
        <td class="actions-cell">${i === 0 ? '' : `<button type="button" class="icon-btn plain" onclick="removeTier('${kind}', ${i})" aria-label="${esc(t('Remove row'))}" title="${esc(t('Remove row'))}">${icon('trash')}</button>`}</td>
      </tr>`;
  }).join('');
  return `
    <div class="table-wrap free"><table class="tier-table">
      <thead><tr><th scope="col">${esc(t('Plan completed from'))}</th>${leader ? '' : `<th scope="col">${esc(t("Fixed (so'm)"))}</th>`}<th scope="col">${esc(t(leader ? '% of all sales' : '% of sales'))}</th>${leader ? `<th scope="col">${esc(t("Bonus (so'm)"))}</th>` : ''}<th scope="col"><span class="sr-only">${esc(t('Actions'))}</span></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <button type="button" class="btn btn-sm btn-ghost" onclick="addTier('${kind}')">${icon('plus')}<span>${esc(t('Add row'))}</span></button>`;
}
function payEditor(){
  const month = payEditMonth();
  const cur = currentMonthKey();
  const d = draftFor(month);
  const own = data.payConfigs.some(r => r.month === month);
  const months = [addMonths(cur, 1)];
  for (let k = cur, i = 0; i < 13; i++, k = addMonths(k, -1)) months.push(k);
  const catCard = (k, title) => `
    <section class="card" aria-label="${esc(title)}">
      ${cardHead('wallet', esc(title))}
      <div class="field form-narrow"><label for="pc-${k}-plan">${esc(t("Monthly plan per seller (so'm)"))}</label><input type="text" inputmode="numeric" id="pc-${k}-plan" class="amount-input" value="${d.categories[k].plan ? fmt(d.categories[k].plan) : ''}" oninput="formatThousandsLive(this)"></div>
      ${tierTable(k, d.categories[k].tiers)}
    </section>`;
  return `
    <section class="card slash" aria-label="${esc(t('Plans & pay'))}">
      ${cardHead('target', esc(t('Plans & pay')), `<span class="pill ${own ? 'ok' : ''}">${esc(own ? t('Own rules for this month') : t('Using earlier rules'))}</span>`)}
      <p>${esc(t('Rules apply to the chosen month and every later month that has no rules of its own. Past months keep the rules they had, so their pay never changes by accident.'))}</p>
      ${errorHtml('pay')}
      <div class="form-grid">
        <div class="field"><label for="pc-month">${esc(t('Rules for'))}</label><select id="pc-month" data-fixed onchange="setPayMonth(this.value)">${months.map(k => `<option value="${k}" ${k === month ? 'selected' : ''}>${esc(monthLabel(k))}${k === cur ? ' · ' + esc(t('this month')) : (k > cur ? ' · ' + esc(t('next month')) : '')}</option>`).join('')}</select></div>
        <div class="field"><label for="pc-team">${esc(t("Team plan (so'm)"))}</label><input type="text" inputmode="numeric" id="pc-team" class="amount-input" value="${d.teamPlan ? fmt(d.teamPlan) : ''}" oninput="formatThousandsLive(this)"></div>
        <div class="field"><label for="pc-leader">${esc(t("Leader plan (so'm)"))}</label><input type="text" inputmode="numeric" id="pc-leader" class="amount-input" value="${d.leaderPlan ? fmt(d.leaderPlan) : ''}" placeholder="${esc(t('Empty = same as team plan'))}" oninput="formatThousandsLive(this)"></div>
      </div>
      <p class="hint">${esc(t('The team plan drives the dashboard and the 25 / 55 / 80% reward milestones. The leader plan drives the team leader bonus.'))}</p>
    </section>
    ${catCard('C', t('C · Demo class — clients who used the demo app'))}
    ${catCard('OTHER', t('Other · G (Global), O (Organic), A and B (web application)'))}
    <section class="card" aria-label="${esc(t('Team leader bonus'))}">
      ${cardHead('crown', esc(t('Team leader bonus')))}
      <p>${esc(t('The team leader gets a % of ALL team sales. The row is chosen by how much of the leader plan the team has sold.'))}</p>
      ${tierTable('L', d.leader.tiers)}
    </section>
    <div class="save-bar">
      <button type="button" class="btn" onclick="savePayRules()" ${busy ? 'disabled' : ''}>${esc(pendingKey === 'pay' ? t('Saving…') : t('Save rules for {month}', { month: monthLabel(month) }))}</button>
      <button type="button" class="btn btn-ghost" onclick="resetPayDraft()">${esc(t('Undo changes'))}</button>
    </div>`;
}
function resetPayDraft(){ ui.payDraft = null; delete errors.pay; render({ fresh: true }); }
function checkTiers(list, leader){
  if (!list.length) return t('Each pay table needs at least one row.');
  for (let i = 0; i < list.length; i++){
    const x = list[i];
    if (!isFinite(x.from) || x.from < 0) return t('Each row needs a “from %” between 0 and 1000.');
    if (i > 0 && !(x.from > list[i - 1].from)) return t('Rows must go up: each “from %” must be bigger than the one above.');
    if (!isFinite(x.pct) || x.pct < 0 || x.pct > 100) return t('Each % of sales must be between 0 and 100.');
  }
  return null;
}
async function savePayRules(){
  if (busy) return;
  syncPayDraft();
  const d = ui.payDraft;
  if (!d) return;
  if (!(d.teamPlan > 0)) return fail('pay', t('Team plan must be a number greater than 0.'));
  for (const k of CATS){
    if (!(d.categories[k].plan > 0)) return fail('pay', t('Each category plan must be a number greater than 0.'));
    const e = checkTiers(d.categories[k].tiers, false);
    if (e) return fail('pay', catLabel(k) + ': ' + e);
  }
  const le = checkTiers(d.leader.tiers, true);
  if (le) return fail('pay', t('Team leader bonus') + ': ' + le);
  const month = d.month;
  await runAction({ action: 'savePayConfig', month, teamPlan: d.teamPlan, leaderPlan: d.leaderPlan, categories: d.categories, leader: d.leader },
    t('Pay rules saved for {month}.', { month: monthLabel(month) }), {
      formKey: 'pay', pendingKey: 'pay',
      afterLoad: () => { ui.payDraft = null; },
    });
}

/* --- standards --- */

function standardsCard(){
  const rows = data.standards.length ? data.standards.map(s => {
    const editing = ui.editingStandardName === s.name;
    return `
      <tr>
        <td><strong>${esc(s.name)}</strong></td>
        <td>${editing ? `<input type="text" id="edit-standard-unit" class="input-sm" value="${esc(s.unit)}" aria-label="${esc(t('Unit'))}">` : (s.unit ? esc(s.unit) : '<span class="muted">—</span>')}</td>
        <td class="num">${editing ? `<input type="number" id="edit-standard-min" class="input-sm" value="${s.minPerDay}" step="1" min="0" aria-label="${esc(t('Daily goal'))}" onkeydown="if(event.key==='Enter')saveStandard(${jsArg(s.name)})">` : s.minPerDay}</td>
        <td class="actions-cell">${editing ? `
          <button type="button" class="btn btn-sm" onclick="saveStandard(${jsArg(s.name)})" ${busy ? 'disabled' : ''}>${esc(pendingKey === 'std' ? t('Saving…') : t('Save'))}</button>
          <button type="button" class="btn btn-sm btn-ghost" onclick="cancelEditStandard()">${esc(t('Cancel'))}</button>` : `
          <button type="button" class="btn btn-sm btn-ghost" onclick="editStandard(${jsArg(s.name)})">${esc(t('Edit'))}</button>
          <button type="button" class="btn btn-sm btn-danger" onclick="deleteStandard(${jsArg(s.name)})" ${busy ? 'disabled' : ''}>${esc(t('Delete'))}</button>`}</td>
      </tr>`;
  }).join('') : `<tr class="empty-row"><td colspan="4">${esc(t('No standards yet. Add one below, e.g. “Calls”, goal 40 a day.'))}</td></tr>`;
  return `
    <section class="card" aria-label="${esc(t('Daily standards'))}">
      ${cardHead('check', esc(t('Daily standards')))}
      <p>${esc(t('What counts as a full day of activity. Sellers fill these in each day; you check them under Compliance.'))}</p>
      ${errorHtml('std')}
      <div class="table-wrap free"><table>
        <thead><tr><th scope="col">${esc(t('Name'))}</th><th scope="col">${esc(t('Unit'))}</th><th scope="col">${esc(t('Daily goal'))}</th><th scope="col"><span class="sr-only">${esc(t('Actions'))}</span></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <h3 class="card-title section-gap" style="margin-bottom:12px">${esc(t('Add a standard'))}</h3>
      <div class="inline-form">
        <div class="field"><label for="new-standard-name">${esc(t('Name'))}</label><input type="text" id="new-standard-name" placeholder="${esc(t('e.g. {n}', { n: t('Calls') }))}" autocomplete="off"></div>
        <div class="field"><label for="new-standard-unit">${esc(t('Unit'))}</label><input type="text" id="new-standard-unit" placeholder="${esc(t('e.g. {n}', { n: t('calls') }))}" autocomplete="off"></div>
        <div class="field"><label for="new-standard-min">${esc(t('Daily goal'))}</label><input type="number" id="new-standard-min" placeholder="${esc(t('e.g. {n}', { n: 40 }))}" min="0" step="1" onkeydown="if(event.key==='Enter')addStandard()"></div>
        <button type="button" class="btn" onclick="addStandard()" ${busy ? 'disabled' : ''}>${esc(pendingKey === 'std-add' ? t('Saving…') : t('Add standard'))}</button>
      </div>
    </section>`;
}

const AUDIT_LABELS = {
  saleCreated: 'Sale added', saleEdited: 'Sale edited', saleDeleted: 'Sale deleted',
  sellerCreated: 'Seller added', sellerEdited: 'Category / plan changed', sellerRenamed: 'Seller renamed', sellerDeleted: 'Seller removed',
  sellerLoginSet: 'Login set', sellerStartChanged: 'Start date changed', sellerLoginRemoved: 'Login removed', planChanged: 'Team plan changed', payPlanChanged: 'Pay rules changed',
  standardCreated: 'Standard added', standardEdited: 'Standard edited', standardDeleted: 'Standard removed',
  activityLogged: 'Standards logged', passwordChanged: 'Password changed', adminSetup: 'Admin created',
};
function auditCard(){
  if (!data.auditLog.length) return `<section class="card">${cardHead('shield', esc(t('Audit log')))}<p>${esc(t('No changes recorded yet.'))}</p></section>`;
  const rows = data.auditLog.slice(0, 200).map(a => {
    const when = new Date(a.timestamp);
    const whenLabel = isNaN(when.getTime()) ? a.timestamp : `${shortDay(ymdOf(when))} ${when.getFullYear()}, ${pad(when.getHours())}:${pad(when.getMinutes())}`;
    const actor = String(a.actor || '');
    const actorHtml = actor.indexOf('admin:') === 0 ? `<span class="pill role-admin">${esc(t('Admin'))}</span>` : esc(actor.replace(/^seller:/, ''));
    return `
      <tr>
        <td class="date-cell">${esc(whenLabel)}</td>
        <td><strong>${esc(t(AUDIT_LABELS[a.action] || a.action))}</strong></td>
        <td class="clip" title="${esc(a.oldValue)}">${a.oldValue ? esc(a.oldValue) : '<span class="muted">—</span>'}</td>
        <td class="clip" title="${esc(a.newValue)}">${a.newValue ? esc(a.newValue) : '<span class="muted">—</span>'}</td>
        <td>${actorHtml}</td>
      </tr>`;
  }).join('');
  return `
    <section class="card" aria-label="${esc(t('Audit log'))}">
      ${cardHead('shield', esc(t('Audit log')), `<span class="kicker">${esc(t('{n} most recent, newest first', { n: Math.min(data.auditLog.length, 200) }))}</span>`)}
      <p>${esc(t('The “By” column is decided by the server from the login, so it can’t be faked from the browser.'))}</p>
      <div class="table-wrap tall" data-scroll="audit"><table>
        <thead><tr><th scope="col">${esc(t('When'))}</th><th scope="col">${esc(t('What'))}</th><th scope="col">${esc(t('Before'))}</th><th scope="col">${esc(t('After'))}</th><th scope="col">${esc(t('By'))}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </section>`;
}

function appearanceCard(){
  const th = currentTheme();
  const opt = (id, label) => `
    <button type="button" class="theme-opt ${th === id ? 'sel' : ''}" onclick="setTheme('${id}')" aria-pressed="${th === id}">
      <span class="theme-swatch ${id}"></span><span>${esc(label)}</span>
    </button>`;
  const lopt = (id, label, sub) => `
    <button type="button" class="theme-opt lang-opt ${lang === id ? 'sel' : ''}" onclick="setLang('${id}')" aria-pressed="${lang === id}">
      <span class="lang-big">${id.toUpperCase()}</span><span>${esc(label)}</span><span class="muted">${esc(sub)}</span>
    </button>`;
  return `
    <section class="card" aria-label="${esc(t('Language'))}">
      ${cardHead('user', esc(t('Language')))}
      <p>${esc(t('Choose the language for this device. You can also switch with the UZ / EN button at the top.'))}</p>
      <div class="theme-grid">${lopt('en', 'English', 'English')}${lopt('uz', 'O‘zbekcha', 'Uzbek')}</div>
    </section>
    <section class="card" aria-label="${esc(t('Theme'))}">
      ${cardHead(th === 'dark' ? 'moon' : 'sun', esc(t('Theme')))}
      <div class="theme-grid">${opt('dark', t('Dark'))}${opt('light', t('Light'))}</div>
    </section>`;
}

function accountCard(){
  return `
    <section class="card form-narrow" aria-label="${esc(t('Account'))}">
      ${cardHead('user', esc(t('Account')))}
      <p>${esc(t('Logged in as {name} ({role}). You stay logged in on this device for 7 days unless you log out.', { name: session.name, role: isAdmin() ? t('admin') : t('seller') }))}</p>
      ${errorHtml('pw')}
      <div class="field"><label for="pw-current">${esc(t('Current password'))}</label><input type="password" id="pw-current" autocomplete="current-password"></div>
      <div class="field"><label for="pw-new">${esc(t('New password'))}</label><input type="password" id="pw-new" autocomplete="new-password"></div>
      <div class="field"><label for="pw-confirm">${esc(t('Confirm new password'))}</label><input type="password" id="pw-confirm" autocomplete="new-password" onkeydown="if(event.key==='Enter')changePassword()"></div>
      <div class="button-row">
        <button type="button" class="btn" onclick="changePassword()" ${busy ? 'disabled' : ''}>${esc(pendingKey === 'pw' ? t('Saving…') : t('Change password'))}</button>
        <button type="button" class="btn btn-ghost" onclick="logOut()">${icon('logout')}<span>${esc(t('Log out'))}</span></button>
      </div>
    </section>`;
}
function demoCard(){
  return `
    <section class="card danger-zone form-narrow" aria-label="${esc(t('Demo data'))}">
      ${cardHead('refresh', esc(t('Demo data')))}
      <p>${esc(t('This is a demo: sample sellers, no Google Sheets. Changes stay in this browser. Reset to start again with a fresh sample team.'))}</p>
      <button type="button" class="btn btn-danger" onclick="confirmResetDemo()">${icon('refresh')}<span>${esc(t('Reset demo data'))}</span></button>
    </section>`;
}

/* ---------- modals ---------- */

function renderModal(){
  if (!modal) return '';
  let inner = '';
  if (modal.type === 'sale') inner = saleModalHtml();
  else if (modal.type === 'addSeller') inner = addSellerModalHtml();
  else if (modal.type === 'confirm') inner = confirmModalHtml();
  else if (modal.type === 'calendar') inner = calendarHtml();
  return `
    <div class="modal-layer" onclick="if(event.target===this)closeModal()">
      <div class="modal ${modal.type === 'calendar' ? 'modal-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title">${inner}</div>
    </div>`;
}
function modalHead(title){
  return `<div class="modal-head"><h2 id="modal-title">${title}</h2><button type="button" class="icon-btn plain" onclick="closeModal()" aria-label="${esc(t('Close'))}">${icon('x')}</button></div>`;
}
function closeModal(){
  if (busy || !modal) return;
  modal = null;
  delete errors.modal;
  render();
}

function openSaleModal(seller, date){
  if (!session) return;
  if (!data.sellers.length && isAdmin()){ showToast(t('Add a seller first.'), 'error'); return; }
  let pre = typeof seller === 'string' ? seller : '';
  if (!pre && isAdmin() && route.name === 'seller' && sellerByName(route.params.name)) pre = route.params.name;
  const who = isAdmin() ? pre : session.name;
  modal = { type: 'sale', seller: who, cls: who ? defaultClass(who) : 'O', date: isDateStr(date || '') && date <= todayStr() ? date : '' };
  delete errors.modal;
  sidebarOpen = false;
  focusAfter = isAdmin() && !pre ? 'm-seller' : 'm-amount';
  render();
}
function modalSellerChange(v){
  if (!modal || modal.type !== 'sale') return;
  modal.seller = v;
  modal.cls = v ? defaultClass(v) : modal.cls;
  resetFields.add('m-class');
  focusAfter = 'm-amount';
  render();
}
function saleModalHtml(){
  const admin = isAdmin();
  const today = todayStr();
  const seller = modal.seller;
  const month = currentMonthKey();
  let ctx = '';
  if (sellerByName(seller)){
    const snap = teamRisks()[seller];
    const pay = payFor(seller, month);
    ctx = `<p class="modal-context num">${esc(seller)}: ${esc(money(snap.stats.totalSold))}${snap.info.plan ? ' · ' + esc(t('{p}% of plan', { p: snap.stats.pctComplete.toFixed(0) })) : ''}${pay ? ' · ' + esc(t('pay so far {n}', { n: fmtShort(pay.total) })) : ''}</p>`;
  }
  return modalHead(esc(t('Add a sale'))) + `
    ${errorHtml('modal')}
    ${admin ? `<div class="field"><label for="m-seller">${esc(t('Seller'))}</label>${sellerSelect('m-seller', seller, '', t('Choose a seller…'), 'onchange="modalSellerChange(this.value)"')}</div>` : ''}
    ${ctx}
    <div class="field"><label for="m-amount">${esc(t("Amount (so'm)"))}</label><input type="text" inputmode="numeric" id="m-amount" class="amount-input" placeholder="${esc(t('e.g. {n}', { n: '5 000 000' }))}" autocomplete="off" oninput="formatThousandsLive(this)" onkeydown="if(event.key==='Enter')submitSaleModal()"></div>
    <div class="form-grid">
      <div class="field"><label for="m-class">${esc(t('Client class'))}</label>${classSelect('m-class', modal.cls)}</div>
      <div class="field"><label for="m-date">${esc(t('Date'))}</label><input type="date" id="m-date" value="${modal.date || today}" max="${today}"></div>
    </div>
    ${admin ? `<label class="check" style="margin-top:12px"><input type="checkbox" id="m-keep" ${ui.keepSaleOpen ? 'checked' : ''} onchange="ui.keepSaleOpen=this.checked"> ${esc(t('Keep open to add another sale'))}</label>` : ''}
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" onclick="closeModal()" ${busy ? 'disabled' : ''}>${esc(t('Cancel'))}</button>
      <button type="button" class="btn" id="m-save" onclick="submitSaleModal()" ${busy ? 'disabled' : ''}>${esc(pendingKey === 'modal' ? t('Saving…') : t('Save sale'))}</button>
    </div>`;
}

/* ---------- full calendar (opened from "Last 7 days") ---------- */

function openCalendar(name, date){
  if (!sellerByName(name)) return;
  const today = todayStr();
  const d = isDateStr(date || '') ? (date > today ? today : date) : today;
  modal = { type: 'calendar', seller: name, month: d.slice(0, 7), day: d };
  delete errors.modal;
  sidebarOpen = false;
  render();
}
function calMonth(n){
  if (!modal || modal.type !== 'calendar') return;
  const m = addMonths(modal.month, n);
  if (m > currentMonthKey() || m < firstMonth()) return;
  modal.month = m;
  modal.day = m === currentMonthKey() ? todayStr() : m + '-01';
  render();
}
function calDay(d){ if (modal && modal.type === 'calendar'){ modal.day = d; render(); } }
function calAddSale(){
  if (!modal || modal.type !== 'calendar') return;
  const name = modal.seller, d = modal.day;
  modal = null;
  openSaleModal(name, d);
}
function calLogDay(){
  if (!modal || modal.type !== 'calendar') return;
  const name = modal.seller, d = modal.day;
  modal = null;
  ui.activityDate[name] = d;
  if (isAdmin()) navigate('seller', { name, tab: 'standards' });
  else navigate('standards');
}
function calendarHtml(){
  const name = modal.seller, month = modal.month;
  const today = todayStr();
  const mi = monthInfoFor(month);
  const dim = mi.daysInMonth;
  const s = sellerByName(name);
  const start = s ? s.startDate : '';
  const info = sellerInfo(name, month);
  const baseline = info.fullPlan > 0 ? info.fullPlan / dim : 0;
  const total = data.standards.length;
  const byDay = {};
  data.entries.forEach(e => { if (e.seller === name && e.date.startsWith(month)) (byDay[e.date] = byDay[e.date] || []).push(e); });
  const lead = (parseYmd(month + '-01').getDay() + 6) % 7; // weeks start on Monday
  const wd = [1, 2, 3, 4, 5, 6, 0].map(i => `<div class="cal-wd">${esc(WEEKDAYS[lang][i])}</div>`).join('');
  let cells = '';
  for (let i = 0; i < lead; i++) cells += '<div class="cal-blank"></div>';
  let sumSales = 0, sumMin = 0, salesDays = 0;
  for (let day = 1; day <= dim; day++){
    const d = month + '-' + pad(day);
    const list = byDay[d] || [];
    const amt = sumAmounts(list);
    const c = callMinutes(d, name);
    const met = data.standards.filter(std => { const r = findActivity(d, name, std.name); return r && r.value >= std.minPerDay; }).length;
    const logged = data.standards.some(std => !!findActivity(d, name, std.name));
    sumSales += amt; sumMin += c || 0; if (amt > 0) salesDays++;
    const future = d > today;
    const off = !!start && d < start;
    let cls = future ? 'future' : (off ? 'off' : (amt > 0 && (baseline === 0 || amt >= baseline) ? 'ok' : (d < today ? 'short' : '')));
    if (d === modal.day) cls += ' sel';
    if (d === today) cls += ' today';
    const dot = total && logged ? `<span class="cd-dot ${met === total ? 'ok' : 'short'}" title="${esc(t('{m}/{n} reached', { m: met, n: total }))}"></span>` : '';
    cells += `<button type="button" class="cal-day ${cls}" ${future ? 'disabled' : `onclick="calDay('${d}')"`} aria-pressed="${d === modal.day}" aria-label="${esc(dayLabel(d))}: ${esc(money(amt))}${c !== null ? ', ' + esc(fmtHM(c)) : ''}">
      <span class="cd-top"><span class="cd-num">${day}</span>${dot}</span>
      <span class="cd-sales num">${amt ? (Math.round(amt / 1e5) / 10) : (future ? '' : '0')}</span>
      <span class="cd-call num">${c !== null ? fmtHM(c) : ''}</span>
    </button>`;
  }
  // details of the chosen day
  const d = modal.day;
  const list = (byDay[d] || []).slice();
  const c = callMinutes(d, name);
  const canEdit = d <= today && (isAdmin() || (isSeller() && session.name === name));
  const salesRows = list.length ? list.map(e => `<div class="cal-sale">${classPill(e.cls)}<span class="num">${esc(money(e.amount))}</span></div>`).join('') : `<p class="muted">${esc(t('No sales this day.'))}</p>`;
  const stdRows = data.standards.map(std => {
    const r = findActivity(d, name, std.name);
    return `<div class="cal-std"><span>${esc(std.name)}</span><span class="num ${r ? (r.value >= std.minPerDay ? 'ok' : 'short') : 'muted'}">${r ? r.value : '—'} / ${std.minPerDay}</span></div>`;
  }).join('');
  const first = firstMonth(), cur = currentMonthKey();
  return modalHead(esc(t('{name} · calendar', { name }))) + `
    <div class="cal-head">
      <button type="button" class="icon-btn" onclick="calMonth(-1)" ${month <= first ? 'disabled' : ''} aria-label="${esc(t('Previous month'))}">${icon('chevL')}</button>
      <div class="cal-title">${esc(monthLabel(month))}</div>
      <button type="button" class="icon-btn" onclick="calMonth(1)" ${month >= cur ? 'disabled' : ''} aria-label="${esc(t('Next month'))}">${icon('chevR')}</button>
    </div>
    <div class="cal-totals">
      <span>${esc(t('Sales'))} <strong class="num">${esc(money(sumSales))}</strong></span>
      <span>${esc(t('Call time'))} <strong class="num">${esc(fmtHM(sumMin))} ${esc(t('h'))}</strong></span>
      <span>${esc(t('Days with sales'))} <strong class="num">${salesDays}</strong></span>
    </div>
    <div class="cal-grid">${wd}${cells}</div>
    <p class="hint">${esc(t("Sales in mln so'm · call time in h:mm"))}${baseline ? ' · ' + esc(t('Green = at or above {n}/day (plan ÷ days in month)', { n: fmtShort(baseline) })) : ''}${start ? ' · ' + esc(t('Started {d}', { d: shortDay(start) })) : ''}</p>
    <div class="cal-detail">
      <div class="cal-detail-head"><strong>${esc(dayLabel(d))}</strong><span class="num">${esc(money(sumAmounts(list)))}</span></div>
      <div class="cal-cols">
        <div><div class="kicker">${esc(t('Sales'))}</div>${salesRows}</div>
        <div>
          <div class="kicker">${esc(t('Call time'))}</div><div class="cal-callbig num">${c !== null ? esc(fmtHM(c)) + ' ' + esc(t('h')) : '<span class="muted">' + esc(t('Not logged')) + '</span>'}</div>
          ${stdRows ? `<div class="kicker" style="margin-top:10px">${esc(t('Daily standards'))}</div>${stdRows}` : ''}
        </div>
      </div>
      ${canEdit ? `<div class="modal-actions" style="justify-content:flex-start">
        <button type="button" class="btn btn-sm" onclick="calAddSale()">${icon('plus')}<span>${esc(t('Add sale on this day'))}</span></button>
        <button type="button" class="btn btn-sm btn-ghost" onclick="calLogDay()">${icon('check')}<span>${esc(t('Log standards & calls'))}</span></button>
      </div>` : ''}
    </div>`;
}

function openAddSeller(){
  modal = { type: 'addSeller' };
  delete errors.modal;
  focusAfter = 'm-name';
  render();
}
function toggleNewSellerLogin(on){ ui.newSellerLogin = !!on; render(); }
function addSellerModalHtml(){
  const login = ui.newSellerLogin;
  return modalHead(esc(t('Add a seller'))) + `
    ${errorHtml('modal')}
    <div class="field"><label for="m-name">${esc(t('Name'))}</label><input type="text" id="m-name" placeholder="${esc(t('e.g. {n}', { n: 'Aziz' }))}" autocomplete="off"></div>
    <div class="field"><label for="m-cat">${esc(t('Pay category'))}</label>
      <select id="m-cat">
        <option value="">${esc(t('Choose…'))}</option>
        <option value="C">${esc(t('C · Demo class (plan {n})', { n: fmtShort(defaultCatPlan('C')) }))}</option>
        <option value="OTHER">${esc(t('Other · G, O, A, B (plan {n})', { n: fmtShort(defaultCatPlan('OTHER')) }))}</option>
        <option value="later">${esc(t('Decide later'))}</option>
      </select>
    </div>
    <div class="field"><label for="m-start">${esc(t('Start date'))}</label><input type="date" id="m-start" value="${todayStr()}"></div>
    <p class="hint" style="margin-top:-8px !important;margin-bottom:12px !important">${esc(t('The plan for the start month is prorated from this day. Clear it for someone who worked the whole month.'))}</p>
    <div class="field"><label for="m-new-target">${esc(t("Own plan (so'm, optional)"))}</label><input type="text" inputmode="numeric" id="m-new-target" class="amount-input" placeholder="${esc(t('Empty = category plan'))}" autocomplete="off" oninput="formatThousandsLive(this)"></div>
    <label class="check"><input type="checkbox" id="m-login" ${login ? 'checked' : ''} onchange="toggleNewSellerLogin(this.checked)"> ${esc(t('Create a login now'))}</label>
    ${login ? `
      <div class="form-grid" style="margin-top:12px">
        <div class="field"><label for="m-username">${esc(t('Username'))}</label><input type="text" id="m-username" autocomplete="off" autocapitalize="none" spellcheck="false"></div>
        <div class="field"><label for="m-password">${esc(t('Password'))}</label><input type="password" id="m-password" autocomplete="new-password" onkeydown="if(event.key==='Enter')submitAddSeller()"></div>
      </div>
      <p class="hint">${esc(t('Share the username and password with the seller. At least 4 characters.'))}</p>` : ''}
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" onclick="closeModal()" ${busy ? 'disabled' : ''}>${esc(t('Cancel'))}</button>
      <button type="button" class="btn" onclick="submitAddSeller()" ${busy ? 'disabled' : ''}>${esc(pendingKey === 'modal' ? t('Saving…') : t('Add seller'))}</button>
    </div>`;
}

function openConfirm(opts){
  modal = Object.assign({ type: 'confirm', confirmLabel: t('Confirm'), danger: false }, opts);
  delete errors.modal;
  focusAfter = 'm-confirm';
  render();
}
function confirmModalHtml(){
  return modalHead(esc(modal.title)) + `
    ${errorHtml('modal')}
    <p>${modal.html || esc(modal.text || '')}</p>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" onclick="closeModal()" ${busy ? 'disabled' : ''}>${esc(t('Cancel'))}</button>
      <button type="button" class="btn ${modal.danger ? 'btn-danger-solid' : ''}" id="m-confirm" onclick="runConfirm()" ${busy ? 'disabled' : ''}>${esc(pendingKey === 'confirm' ? t('Working…') : modal.confirmLabel)}</button>
    </div>`;
}
function runConfirm(){ if (!modal || modal.type !== 'confirm' || busy) return; modal.run(); }

/* ---------- actions: sales ---------- */

function checkSale(key, seller, date, amount, cls){
  if (!seller) return fail(key, t('Choose a seller.'));
  if (!isDateStr(date)) return fail(key, t('Pick a date.'));
  if (date > todayStr()) return fail(key, t('Sales can’t be logged for a future date.'));
  if (!(amount > 0)) return fail(key, t('Enter an amount greater than 0.'));
  if (amount > AMOUNT_LIMIT) return fail(key, t('That amount is too large — check for extra zeros.'));
  if (CLASSES.indexOf(cls) === -1) return fail(key, t('Choose the client class: C, G, O, A or B.'));
  return true;
}
function whoText(seller){ return seller === session.name ? t('you') : seller; }

async function submitSaleModal(){
  if (busy || !modal || modal.type !== 'sale') return;
  const seller = isAdmin() ? val('m-seller') : session.name;
  const date = val('m-date');
  const amount = parseFormattedNumber(val('m-amount'));
  const cls = val('m-class');
  if (!checkSale('modal', seller, date, amount, cls)) return;
  const keep = isAdmin() && isChecked('m-keep');
  await runAction({ action: 'addEntry', seller, date, amount, cls },
    t('Sale saved: {amount} ({cls}) for {who} on {date}.', { amount: money(amount), cls, who: whoText(seller), date: shortDay(date) }), {
      requestId: requestIdFor('sale-modal', [seller, date, amount, cls].join('|')),
      requestKey: 'sale-modal', formKey: 'modal', pendingKey: 'modal',
      onSuccess: () => {
        if (keep && modal){ modal.seller = seller; modal.cls = cls; resetFields.add('m-amount'); focusAfter = 'm-amount'; }
        else modal = null;
      },
    });
}
async function submitSale(name){
  if (busy) return;
  const seller = isAdmin() ? name : session.name;
  const date = val('sale-date');
  const amount = parseFormattedNumber(val('sale-amount'));
  const cls = val('sale-class');
  if (!checkSale('sale', seller, date, amount, cls)) return;
  await runAction({ action: 'addEntry', seller, date, amount, cls }, t('Sale saved: {amount} ({cls}) on {date}.', { amount: money(amount), cls, date: shortDay(date) }), {
    requestId: requestIdFor('sale', [seller, date, amount, cls].join('|')),
    requestKey: 'sale', formKey: 'sale', pendingKey: 'sale',
    onSuccess: () => { resetFields.add('sale-amount'); focusAfter = 'sale-amount'; },
  });
}
async function submitQuickAdd(){
  if (busy) return;
  const seller = val('qa-seller');
  const date = val('qa-date');
  const amount = parseFormattedNumber(val('qa-amount'));
  const cls = val('qa-class');
  if (!checkSale('qa', seller, date, amount, cls)) return;
  await runAction({ action: 'addEntry', seller, date, amount, cls }, t('Sale saved: {amount} ({cls}) for {who} on {date}.', { amount: money(amount), cls, who: seller, date: shortDay(date) }), {
    requestId: requestIdFor('qa', [seller, date, amount, cls].join('|')),
    requestKey: 'qa', formKey: 'qa', pendingKey: 'qa',
    onSuccess: () => { resetFields.add('qa-amount'); focusAfter = 'qa-amount'; },
  });
}
async function submitBulk(){
  if (busy) return;
  const date = val('bulk-date');
  if (!isDateStr(date)) return fail('bulk', t('Pick a date.'));
  if (date > todayStr()) return fail('bulk', t('Sales can’t be logged for a future date.'));
  const rows = [];
  let tooBig = null;
  bulkInputs().forEach(el => {
    const amount = parseFormattedNumber(el.value);
    if (!(amount > 0)) return;
    const seller = el.getAttribute('data-seller');
    const cls = val('bulk-cls-' + el.getAttribute('data-i'));
    if (amount > AMOUNT_LIMIT) tooBig = seller;
    rows.push({ seller, amount, cls });
  });
  if (tooBig) return fail('bulk', tooBig + ': ' + t('That amount is too large — check for extra zeros.'));
  if (!rows.length) return fail('bulk', t('Enter at least one amount.'));
  if (rows.length > BULK_LIMIT) return fail('bulk', t('Too many rows in one save (max {n}).', { n: BULK_LIMIT }));
  const total = rows.reduce((s, r) => s + r.amount, 0);
  await runAction({ action: 'addEntriesBulk', date, rows }, t('Saved {n} · {total} on {date}.', { n: cnt(rows.length, '{n} sale', '{n} sales'), total: money(total), date: shortDay(date) }), {
    requestId: requestIdFor('bulk', date + JSON.stringify(rows)),
    requestKey: 'bulk', formKey: 'bulk', pendingKey: 'bulk',
    onSuccess: () => { bulkInputs().forEach(el => resetFields.add(el.id)); },
  });
}

function editEntry(id){ ui.editingEntryId = id; delete errors.entries; focusAfter = 'edit-entry-amount'; render(); }
function cancelEditEntry(){ ui.editingEntryId = null; delete errors.entries; render(); }
async function saveEntry(id){
  if (busy) return;
  const e = data.entries.find(x => x.id === id);
  if (!e) return fail('entries', t('That entry no longer exists. Refresh and try again.'));
  const amount = parseFormattedNumber(val('edit-entry-amount'));
  const date = val('edit-entry-date') || e.date;
  const sellerEl = document.getElementById('edit-entry-seller');
  const seller = sellerEl && sellerEl.value ? sellerEl.value : e.seller;
  const cls = val('edit-entry-cls');
  if (!checkSale('entries', seller, date, amount, cls)) return;
  const payload = { action: 'editEntry', id };
  if (amount !== e.amount) payload.amount = amount;
  if (date !== e.date) payload.date = date;
  if (seller !== e.seller) payload.seller = seller;
  if (cls !== e.cls) payload.cls = cls;
  if (Object.keys(payload).length === 2){ cancelEditEntry(); return; }
  await runAction(payload, seller !== e.seller ? t('Sale moved to {name}.', { name: seller }) : t('Sale updated.'), {
    formKey: 'entries', pendingKey: 'entry',
    onSuccess: () => { ui.editingEntryId = null; },
  });
}
function deleteEntry(id){
  const e = data.entries.find(x => x.id === id);
  if (!e) return;
  openConfirm({
    title: t('Delete this sale?'),
    html: `<strong class="num">${esc(money(e.amount))}</strong> · ${esc(dayLabel(e.date))}${isAdmin() ? ` · <strong>${esc(e.seller)}</strong>` : ''}. ${esc(t('This can’t be undone, but it stays in the audit log.'))}`,
    confirmLabel: t('Delete sale'), danger: true,
    run: () => runAction({ action: 'deleteEntry', id }, t('Sale deleted.'), {
      formKey: 'modal', pendingKey: 'confirm', closeModal: true,
      onSuccess: () => { if (ui.editingEntryId === id) ui.editingEntryId = null; },
    }),
  });
}

/* ---------- actions: standards activity ---------- */

async function submitActivity(name){
  if (busy) return;
  const date = ui.activityDate[name] || todayStr();
  if (date > todayStr()) return fail('act', t('Activity can’t be logged for a future date.'));
  const values = {};
  for (let idx = 0; idx < data.standards.length; idx++){
    const raw = val('act-' + idx).trim();
    if (raw === '') continue;
    const n = Number(raw);
    if (!isFinite(n) || n < 0) return fail('act', t('“{name}” must be a number, 0 or more.', { name: data.standards[idx].name }));
    if (n > 100000) return fail('act', t('“{name}” is too large.', { name: data.standards[idx].name }));
    values[data.standards[idx].name] = n;
  }
  const hRaw = val('call-h').trim(), mRaw = val('call-m').trim();
  let call = null;
  if (hRaw !== '' || mRaw !== ''){
    const h = hRaw === '' ? 0 : Number(hRaw), mm = mRaw === '' ? 0 : Number(mRaw);
    if (!Number.isInteger(h) || !Number.isInteger(mm) || h < 0 || mm < 0 || mm > 59) return fail('act', t('Call time: enter whole hours and 0–59 minutes.'));
    call = h * 60 + mm;
    if (call > 1440) return fail('act', t('Call time must be between 0:00 and 24:00.'));
  }
  if (!Object.keys(values).length && call === null) return fail('act', t('Enter at least one value.'));
  const payload = { action: 'logActivity', date, seller: name, values };
  if (call !== null) payload.callMinutes = call;
  await runAction(payload, t('Saved for {who} · {date}.', { who: isSeller() ? t('you') : name, date: shortDay(date) }), {
    requestId: requestIdFor('act|' + name, date + JSON.stringify(values) + '|' + call),
    requestKey: 'act|' + name, formKey: 'act', pendingKey: 'act',
  });
}

/* ---------- actions: sellers (admin) ---------- */

async function saveSellerPlan(name){
  if (busy) return;
  const cat = val('acct-cat');
  const raw = val('acct-plan').trim();
  const target = raw === '' ? 0 : parseFormattedNumber(raw);
  const start = val('acct-start').trim();
  if (target > AMOUNT_LIMIT) return fail('acct-plan', t('That plan is too large — check for extra zeros.'));
  if (start && !isDateStr(start)) return fail('acct-plan', t('Pick a valid start date.'));
  const payload = { action: 'updateSeller', name, category: cat, target };
  const s = sellerByName(name);
  if (start !== ((s && s.startDate) || '')) payload.startDate = start;
  await runAction(payload, t('{name}: {cat}, plan {plan}.', { name, cat: catLabel(cat), plan: target ? fmt(target) : t('category default') }), {
    formKey: 'acct-plan', pendingKey: 'plan',
    onSuccess: () => { ['acct-plan', 'acct-cat', 'acct-start'].forEach(id => resetFields.add(id)); },
  });
}
async function saveCategoryQuick(name){
  if (busy) return;
  const cat = val('ws-cat-quick');
  if (!cat) return fail('ws-cat', t('Choose the seller’s category: C or Other.'));
  await runAction({ action: 'updateSeller', name, category: cat }, t('{name} is now in {cat}.', { name, cat: catLabel(cat) }), { formKey: 'ws-cat', pendingKey: 'cat' });
}
async function renameSeller(name){
  if (busy) return;
  const newName = val('acct-name').trim();
  if (!newName) return fail('acct-name', t('Enter the new name.'));
  if (newName === name) return fail('acct-name', t('That’s already the name.'));
  if (data.sellers.some(s => s.name.toLowerCase() === newName.toLowerCase() && s.name !== name)) return fail('acct-name', t('A seller with that name already exists.'));
  await runAction({ action: 'renameSeller', name, newName }, t('Renamed {a} to {b}.', { a: name, b: newName }), {
    formKey: 'acct-name', pendingKey: 'rename',
    onSuccess: () => { resetFields.add('acct-name'); if (ui.activityDate[name]) ui.activityDate[newName] = ui.activityDate[name]; },
    afterLoad: () => {
      route = { name: 'seller', params: { name: newName, tab: 'account' } };
      replaceHash(hrefFor('seller', route.params));
    },
  });
}
async function saveLogin(name){
  if (busy) return;
  const u = val('acct-username').trim();
  const p = val('acct-password');
  const p2 = val('acct-password2');
  if (!u) return fail('acct-login', t('Enter a username.'));
  if (p.length < 4) return fail('acct-login', t('Password must be at least {n} characters.', { n: 4 }));
  if (p !== p2) return fail('acct-login', t('Passwords don’t match.'));
  await runAction({ action: 'setSellerCredentials', name, username: u, password: p }, t('Login saved for {name}. Share the username and password with them.', { name }), {
    formKey: 'acct-login', pendingKey: 'login',
    onSuccess: () => { ['acct-username', 'acct-password', 'acct-password2'].forEach(id => resetFields.add(id)); },
  });
}
function removeLogin(name){
  openConfirm({
    title: t('Remove {name}’s login?', { name }),
    text: t('{name} is logged out everywhere and can’t log in until you create a new login. Their sales stay.', { name }),
    confirmLabel: t('Remove login'), danger: true,
    run: () => runAction({ action: 'setSellerCredentials', name, username: '' }, t('Login removed for {name}.', { name }), {
      formKey: 'modal', pendingKey: 'confirm', closeModal: true,
      onSuccess: () => { resetFields.add('acct-username'); },
    }),
  });
}
function deleteSeller(name){
  openConfirm({
    title: t('Remove {name} from the team?', { name }),
    text: t('Their past sales stay on record and still count toward the team total. Their login stops working immediately.'),
    confirmLabel: t('Remove seller'), danger: true,
    run: () => runAction({ action: 'deleteSeller', name }, t('Removed {name} from the team.', { name }), {
      formKey: 'modal', pendingKey: 'confirm', closeModal: true,
      afterLoad: () => { if (route.name === 'seller'){ route = { name: 'team', params: {} }; replaceHash(hrefFor('team')); } },
    }),
  });
}
async function submitAddSeller(){
  if (busy || !modal || modal.type !== 'addSeller') return;
  const name = val('m-name').trim();
  const catRaw = val('m-cat');
  const rawTarget = val('m-new-target').trim();
  const target = rawTarget === '' ? 0 : parseFormattedNumber(rawTarget);
  const withLogin = isChecked('m-login');
  const username = withLogin ? val('m-username').trim() : '';
  const password = withLogin ? val('m-password') : '';
  if (!name) return fail('modal', t('Enter a seller name.'));
  if (data.sellers.some(s => s.name.toLowerCase() === name.toLowerCase())) return fail('modal', t('A seller with that name already exists.'));
  if (!catRaw) return fail('modal', t('Choose a pay category, or “Decide later”.'));
  if (target > AMOUNT_LIMIT) return fail('modal', t('That plan is too large — check for extra zeros.'));
  if (withLogin && !username) return fail('modal', t('Enter a username, or untick “Create a login now”.'));
  if (withLogin && password.length < 4) return fail('modal', t('Password must be at least {n} characters.', { n: 4 }));
  const category = catRaw === 'later' ? '' : catRaw;
  const startDate = val('m-start').trim();
  if (startDate && !isDateStr(startDate)) return fail('modal', t('Pick a valid start date.'));
  await runAction({ action: 'addSeller', name, category, target, username, password, startDate }, t('Added {name}.', { name }), {
    formKey: 'modal', pendingKey: 'modal', closeModal: true,
  });
}

/* ---------- actions: settings (admin) ---------- */

async function addStandard(){
  if (busy) return;
  const name = val('new-standard-name').trim();
  const unit = val('new-standard-unit').trim();
  const minRaw = val('new-standard-min').trim();
  const min = Number(minRaw);
  if (!name) return fail('std', t('Enter a standard name.'));
  if (minRaw === '' || !isFinite(min) || min < 0) return fail('std', t('Daily goal must be a number, 0 or greater.'));
  await runAction({ action: 'addStandard', name, unit, minPerDay: min }, t('Added “{name}”.', { name }), {
    formKey: 'std', pendingKey: 'std-add',
    onSuccess: () => { ['new-standard-name', 'new-standard-unit', 'new-standard-min'].forEach(id => resetFields.add(id)); },
  });
}
function editStandard(name){ ui.editingStandardName = name; delete errors.std; focusAfter = 'edit-standard-min'; render(); }
function cancelEditStandard(){ ui.editingStandardName = null; render(); }
async function saveStandard(name){
  if (busy) return;
  const unit = val('edit-standard-unit').trim();
  const minRaw = val('edit-standard-min').trim();
  const min = Number(minRaw);
  if (minRaw === '' || !isFinite(min) || min < 0) return fail('std', t('Daily goal must be a number, 0 or greater.'));
  await runAction({ action: 'updateStandard', name, unit, minPerDay: min }, t('Updated “{name}”.', { name }), {
    formKey: 'std', pendingKey: 'std', onSuccess: () => { ui.editingStandardName = null; },
  });
}
function deleteStandard(name){
  openConfirm({
    title: t('Delete “{name}”?', { name }),
    text: t('Sellers stop seeing this standard. Values already logged stay in the records.'),
    confirmLabel: t('Delete standard'), danger: true,
    run: () => runAction({ action: 'deleteStandard', name }, t('Deleted “{name}”.', { name }), { formKey: 'modal', pendingKey: 'confirm', closeModal: true }),
  });
}
async function changePassword(){
  if (busy) return;
  const cur = val('pw-current');
  const next = val('pw-new');
  const conf = val('pw-confirm');
  if (!cur) return fail('pw', t('Enter your current password.'));
  if (next.length < 4) return fail('pw', t('New password must be at least {n} characters.', { n: 4 }));
  if (next !== conf) return fail('pw', t('New passwords don’t match.'));
  await runAction({ action: 'changePassword', currentPassword: cur, newPassword: next }, t('Password changed. Other devices will need to log in again.'), {
    formKey: 'pw', pendingKey: 'pw',
    onSuccess: (res) => {
      if (res.token){ session.token = res.token; session.exp = res.exp; saveSession(session); }
      ['pw-current', 'pw-new', 'pw-confirm'].forEach(id => resetFields.add(id));
    },
  });
}
function confirmResetDemo(){
  if (!DEMO) return;
  openConfirm({
    title: t('Reset demo data?'),
    text: t('All demo changes are replaced with a fresh sample team, and you’ll be logged out.'),
    confirmLabel: t('Reset demo'), danger: true,
    run: resetDemo,
  });
}
function resetDemo(){
  if (!DEMO) return;
  window.SalesPaceDemo.reset();
  Object.keys(pendingRequests).forEach(k => delete pendingRequests[k]);
  endSession(null);
  authBanner = { type: 'success', text: t('Demo data reset to a fresh sample team. Log in with any demo account.') };
  ui.activityDate = {};
  ui.openRiskLevel = 'auto';
  ui.payDraft = null;
  afterLogin = null;
  navigate('login');
  load(true);
}

/* ---------- boot ---------- */

function init(){
  applyTheme(storeGet(THEME_KEY) === 'light' ? 'light' : 'dark');
  document.documentElement.setAttribute('lang', lang);
  renderToast();
  window.addEventListener('hashchange', onBrowserNav);
  window.addEventListener('popstate', onBrowserNav);
  document.addEventListener('click', onLinkClick);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (modal) closeModal();
    else if (sidebarOpen) toggleSidebar(false);
  });
  if (!DEMO){
    document.addEventListener('visibilitychange', () => { if (!document.hidden && loaded) load(true); });
    setInterval(() => { if (!document.hidden) load(true); }, REFRESH_MS);
  }
  onRouteChange();
  load(false);
}
init();
