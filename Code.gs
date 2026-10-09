/**
 * Sales Pace — Google Sheets backend
 *
 * SETUP / UPDATING
 * 1. Open your Google Sheet → Extensions → Apps Script.
 * 2. Replace everything in Code.gs with this file and save.
 * 3. Deploy → Manage deployments → ✏️ (edit) → Version: "New version" → Deploy.
 *    Saving alone does NOT update the live /exec URL.
 * 4. The /exec URL goes in ONE place now: index.html (window.SALES_PACE_SCRIPT_URL).
 *
 * TABS (created automatically when missing)
 *   Config    A1 "Monthly Plan", B1 = team plan (kept in sync; PlanConfig is the source)
 *   Sellers   Name | Target | Username | PasswordHash | Salt | Category | StartDate
 *             (Target = this seller's own plan, 0 = the category's default;
 *              Category = C or OTHER. Shown for reading — PlanConfig is the source)
 *   Entries   Date | Seller | Amount | ID | Class   (Class: C, G, O, A or B)
 *   PlanConfig Month | Config   one JSON row per month that has its own pay rules:
 *             team plan, leader plan, C and OTHER plans + pay tiers, leader tiers,
 *             and each seller's category / own plan. A month without a row uses
 *             the latest earlier row, so past months keep the rules they had.
 *   Standards Name | Unit | MinPerDay
 *   Activity  Date | Seller | Standard | Value
 *   CallTime  Date | Seller | Minutes   (call time per seller per day; sellers log
 *             their own, the admin can correct anyone's)
 *   Admin     Username | PasswordHash | Salt
 *   AuditLog  Timestamp | Action | RecordType | RecordId | OldValue | NewValue | Actor
 *   Never type passwords into the sheet — set them from the app.
 *
 * LOGIN / SESSIONS
 *   One "login" action for the admin and for sellers. On success the server
 *   returns a signed token (HMAC-SHA256, secret kept in Script Properties)
 *   that is valid for 7 days. Every write must carry that token, and the
 *   server — not the browser — decides who you are and what you may do.
 *   A token stops working early if that account's password is changed or
 *   reset, its login is removed, or the seller is deleted.
 *   To log EVERYONE out at once: Project Settings → Script Properties →
 *   delete SESSION_SECRET.
 *   Reading dashboard data (GET) stays public, by request. The audit log and
 *   seller usernames are only included for a valid admin token.
 *
 * ADMIN POWERS (server-enforced): plans and pay tables, sellers (add / rename /
 *   category / plan / login / delete), standards, bulk sale entry, and editing
 *   or deleting any seller's sales and daily activity. Every change lands in AuditLog with
 *   the admin's name as the actor.
 */

/* ---------- settings ---------- */

const SESSION_DAYS = 7;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const IDEMPOTENCY_TTL_SEC = 600;      // a retried request within 10 min is answered from cache
const MAX_AMOUNT = 1e12;              // anything above is almost certainly a typo
const MAX_ACTIVITY_VALUE = 100000;
const MAX_CALL_MINUTES = 24 * 60;
const MIN_PASSWORD = 4;
const AUDIT_CAP = 200;
const BAD_LOGIN = 'Incorrect username or password.';

const PUBLIC_ACTIONS = { login: true, setupAdmin: true };
const MAX_BULK_ROWS = 200;
const ADMIN_ACTIONS = {
  setPlan: true, savePayConfig: true, addEntriesBulk: true,
  addSeller: true, updateSeller: true, renameSeller: true, deleteSeller: true, setSellerCredentials: true,
  addStandard: true, updateStandard: true, deleteStandard: true,
};

/* Client classes recorded on every sale. */
const SALE_CLASSES = ['C', 'G', 'O', 'A', 'B'];
/* Seller pay categories: C = demo-class clients, OTHER = G, O, A, B clients. */
const CATEGORIES = ['C', 'OTHER'];
const MAX_TIERS = 12;

/* Starting pay rules. The admin changes them in the app (Settings → Plans & pay). */
function payDefaults_() {
  return {
    teamPlan: 0,
    leaderPlan: 0, // 0 = same as the team plan
    categories: {
      C: { plan: 50000000, tiers: [
        { from: 0, fix: 1000000, pct: 4 }, { from: 40, fix: 1500000, pct: 5 }, { from: 70, fix: 2000000, pct: 6 },
        { from: 100, fix: 3000000, pct: 7 }, { from: 130, fix: 4000000, pct: 7 }] },
      OTHER: { plan: 100000000, tiers: [
        { from: 0, fix: 1000000, pct: 4 }, { from: 40, fix: 2000000, pct: 5 }, { from: 60, fix: 2500000, pct: 5.5 },
        { from: 80, fix: 3500000, pct: 6 }, { from: 100, fix: 4000000, pct: 7 }, { from: 120, fix: 4000000, pct: 8 },
        { from: 140, fix: 4000000, pct: 9 }] },
    },
    leader: { tiers: [
      { from: 0, pct: 1, bonus: 0 }, { from: 60, pct: 1.5, bonus: 0 }, { from: 80, pct: 1.8, bonus: 0 },
      { from: 100, pct: 2, bonus: 1000000 }] },
    sellers: {},
  };
}

/* ---------- sheet access ---------- */

function getSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}
function ensureSheet_(name, header) {
  const sheet = getSheet_(name);
  if (sheet.getLastRow() === 0) sheet.appendRow(header);
  return sheet;
}
function ensureConfigSheet_() {
  const sheet = getSheet_('Config');
  if (!sheet.getRange('A1').getValue()) sheet.getRange('A1').setValue('Monthly Plan');
  return sheet;
}
/* Older sheets get the new column headers added in place. */
function ensureHeader_(sheet, col, title) {
  if (sheet.getRange(1, col).getValue() === '') sheet.getRange(1, col).setValue(title);
  return sheet;
}
function ensureSellersSheet_()   {
  const sh = ensureSheet_('Sellers', ['Name', 'Target', 'Username', 'PasswordHash', 'Salt', 'Category', 'StartDate']);
  ensureHeader_(sh, 6, 'Category');
  return ensureHeader_(sh, 7, 'StartDate');
}
function ensureCallTimeSheet_()  { return ensureSheet_('CallTime', ['Date', 'Seller', 'Minutes']); }
function ensureEntriesSheet_()   { return ensureHeader_(ensureSheet_('Entries', ['Date', 'Seller', 'Amount', 'ID', 'Class']), 5, 'Class'); }
function ensurePlanConfigSheet_() { return ensureSheet_('PlanConfig', ['Month', 'Config']); }
function ensureStandardsSheet_() { return ensureSheet_('Standards', ['Name', 'Unit', 'MinPerDay']); }
function ensureActivitySheet_()  { return ensureSheet_('Activity', ['Date', 'Seller', 'Standard', 'Value']); }
function ensureAdminSheet_()     { return ensureSheet_('Admin', ['Username', 'PasswordHash', 'Salt']); }
function ensureAuditLogSheet_()  { return ensureSheet_('AuditLog', ['Timestamp', 'Action', 'RecordType', 'RecordId', 'OldValue', 'NewValue', 'Actor']); }

/* Dates typed into the sheet are midnight in the SPREADSHEET's time zone, so
   read and compare them in that zone (it can differ from the script's). */
let TZ_CACHE_ = null;
function tz_() {
  if (TZ_CACHE_) return TZ_CACHE_;
  try { TZ_CACHE_ = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || Session.getScriptTimeZone(); }
  catch (err) { TZ_CACHE_ = Session.getScriptTimeZone(); }
  return TZ_CACHE_;
}
function formatDate_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, tz_(), 'yyyy-MM-dd');
  return String(value);
}
function dateOffsetStr_(days) {
  return Utilities.formatDate(new Date(Date.now() + days * 86400000), tz_(), 'yyyy-MM-dd');
}
function currentMonth_() { return dateOffsetStr_(0).slice(0, 7); }
function isValidMonth_(m) { return typeof m === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(m); }
function nextMonth_(m) {
  const p = m.split('-').map(Number);
  return p[1] === 12 ? (p[0] + 1) + '-01' : p[0] + '-' + String(p[1] + 1).padStart(2, '0');
}
function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function fail_(msg) { return jsonOutput_({ ok: false, error: msg }); }
function authFail_() { return jsonOutput_({ ok: false, error: 'Please log in again.', authError: true }); }

/* Row (1-indexed) whose column exactly matches value, skipping the header. -1 if none. */
function findRow_(sheet, col, value) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const values = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]) === String(value)) return i + 2;
  }
  return -1;
}

/* Usernames are matched case-insensitively and ignoring surrounding spaces,
   so a phone that auto-capitalises "Aziz" still logs in as "aziz". */
function normUser_(u) { return String(u == null ? '' : u).trim().toLowerCase(); }
function findUsernameRow_(sheet, col, username) {
  const target = normUser_(username);
  if (!target) return -1;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const values = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (normUser_(values[i][0]) === target) return i + 2;
  }
  return -1;
}

/* ---------- validation ---------- */

function isNonEmptyString_(v) { return typeof v === 'string' && v.trim().length > 0; }
function isFiniteNumber_(v) {
  if (v === '' || v === null || v === undefined || typeof v === 'boolean') return false;
  const n = Number(v);
  return !isNaN(n) && isFinite(n);
}
function isPositiveNumber_(v) { return isFiniteNumber_(v) && Number(v) > 0; }
function isNonNegativeNumber_(v) { return isFiniteNumber_(v) && Number(v) >= 0; }
function isValidDateStr_(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const p = v.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return p[0] >= 2000 && d.getUTCFullYear() === p[0] && d.getUTCMonth() === p[1] - 1 && d.getUTCDate() === p[2];
}
/* Returns an error message, or null when the sale is valid. */
function validateSale_(date, amount) {
  if (!isValidDateStr_(date)) return 'Invalid date.';
  if (date > dateOffsetStr_(1)) return 'Sales can’t be logged for a future date.';
  if (!isPositiveNumber_(amount)) return 'Amount must be a number greater than 0.';
  if (Number(amount) > MAX_AMOUNT) return 'That amount is too large — check for extra zeros.';
  return null;
}
function validateAmount_(amount) {
  if (!isPositiveNumber_(amount)) return 'Amount must be a number greater than 0.';
  if (Number(amount) > MAX_AMOUNT) return 'That amount is too large — check for extra zeros.';
  return null;
}
function validateTarget_(target) {
  if (!isNonNegativeNumber_(target)) return 'Plan must be a number, 0 or greater.';
  if (Number(target) > MAX_AMOUNT) return 'That plan is too large — check for extra zeros.';
  return null;
}
function validClass_(c) { return SALE_CLASSES.indexOf(String(c)) !== -1; }
function validCategory_(c) { return c === '' || CATEGORIES.indexOf(String(c)) !== -1; }

/* ---------- pay plans (versioned per month) ---------- */

function readPlanRows_() {
  const sheet = ensurePlanConfigSheet_();
  const out = [];
  const last = sheet.getLastRow();
  if (last < 2) return out;
  sheet.getRange(2, 1, last - 1, 2).getValues().forEach(function (r, i) {
    // Google Sheets turns a typed "2026-10" into a date; read either form back.
    const month = r[0] instanceof Date ? Utilities.formatDate(r[0], tz_(), 'yyyy-MM') : String(r[0] || '').trim();
    if (!month) return;
    let cfg = null;
    try { cfg = JSON.parse(String(r[1] || '')); } catch (err) { cfg = null; }
    if (cfg && typeof cfg === 'object') out.push({ month: month, config: cfg, row: i + 2 });
  });
  out.sort(function (a, b) { return a.month < b.month ? -1 : a.month > b.month ? 1 : 0; });
  return out;
}
/* Rules before anything was saved in PlanConfig: the defaults plus the old
   team plan (Config B1). Old per-seller "Target" values are NOT carried over:
   a seller's plan now comes from their category unless the admin sets an own plan.
   A Category already typed into the Sellers sheet is respected. */
function legacyBase_() {
  const cfg = payDefaults_();
  cfg.teamPlan = Number(ensureConfigSheet_().getRange('B1').getValue()) || 0;
  const sheet = ensureSellersSheet_();
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues().forEach(function (row) {
      if (row[0] === '') return;
      const cat = CATEGORIES.indexOf(String(row[5])) !== -1 ? String(row[5]) : '';
      cfg.sellers[String(row[0])] = { cat: cat, plan: cat ? Number(row[1]) || 0 : 0 };
    });
  }
  return cfg;
}
function effectiveFrom_(rows, month) {
  let found = null;
  rows.forEach(function (r) { if (r.month <= month) found = r; });
  return found ? found.config : null;
}
/* Writes one PlanConfig row as plain text, so Sheets never turns "2026-10"
   into a date or touches the JSON. row = -1 appends. */
function writePlanRow_(sheet, row, month, cfg) {
  if (row === -1) row = sheet.getLastRow() + 1;
  const range = sheet.getRange(row, 1, 1, 2);
  range.setNumberFormat('@');
  range.setValues([[month, JSON.stringify(cfg)]]);
}
/* Change the rules of one month. The first change ever also pins the old
   rules as a base row, so months before it keep showing what they had. */
function updateMonthConfig_(month, mutate) {
  const sheet = ensurePlanConfigSheet_();
  let rows = readPlanRows_();
  if (!rows.length) {
    writePlanRow_(sheet, -1, '0000-00', legacyBase_());
    rows = readPlanRows_();
  }
  const existing = rows.filter(function (r) { return r.month === month; })[0];
  const cfg = JSON.parse(JSON.stringify(existing ? existing.config : (effectiveFrom_(rows, month) || legacyBase_())));
  if (!cfg.sellers || typeof cfg.sellers !== 'object') cfg.sellers = {};
  mutate(cfg);
  writePlanRow_(sheet, existing ? existing.row : -1, month, cfg);
  return cfg;
}
/* Returns an error message, or null. Normalises the tiers in place. */
function validateTiers_(tiers, kind) {
  if (!Array.isArray(tiers) || !tiers.length) return 'Each pay table needs at least one row.';
  if (tiers.length > MAX_TIERS) return 'A pay table can have at most ' + MAX_TIERS + ' rows.';
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i] || {};
    if (!isNonNegativeNumber_(t.from) || Number(t.from) > 1000) return 'Each row needs a “from %” between 0 and 1000.';
    if (i === 0 && Number(t.from) !== 0) return 'The first row of each pay table must start at 0%.';
    if (i > 0 && Number(t.from) <= Number(tiers[i - 1].from)) return 'Rows must go up: each “from %” must be bigger than the one above.';
    if (!isNonNegativeNumber_(t.pct) || Number(t.pct) > 100) return 'Each % of sales must be between 0 and 100.';
    const money = kind === 'leader' ? t.bonus : t.fix;
    if (!isNonNegativeNumber_(money) || Number(money) > MAX_AMOUNT) return kind === 'leader' ? 'Each bonus must be 0 or more.' : 'Each fixed pay must be 0 or more.';
    tiers[i] = kind === 'leader'
      ? { from: Number(t.from), pct: Number(t.pct), bonus: Number(t.bonus) }
      : { from: Number(t.from), fix: Number(t.fix), pct: Number(t.pct) };
  }
  return null;
}
/* A seller's category / own plan applies from this month on, including any
   later month that already has its own rules (planned ahead). */
function setSellerAssignment_(name, cat, plan, session) {
  const month = currentMonth_();
  const value = { cat: cat, plan: Number(plan) || 0 };
  updateMonthConfig_(month, function (cfg) { cfg.sellers[name] = value; });
  const planSheet = ensurePlanConfigSheet_();
  readPlanRows_().forEach(function (r) {
    if (r.month <= month) return;
    if (!r.config.sellers || typeof r.config.sellers !== 'object') r.config.sellers = {};
    r.config.sellers[name] = value;
    writePlanRow_(planSheet, r.row, r.month, r.config);
  });
  const sheet = ensureSellersSheet_();
  const row = findRow_(sheet, 1, name);
  if (row !== -1) {
    sheet.getRange(row, 2).setValue(Number(plan) || 0);
    sheet.getRange(row, 6).setValue(cat);
  }
}

/* ---------- passwords ---------- */

function makeSalt_() { return Utilities.getUuid(); }
function hashPassword_(password, salt) {
  // Must stay byte-for-byte identical to the previous version, or existing passwords stop working.
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + password);
  return bytes.map(function (b) { return ((b < 0 ? b + 256 : b)).toString(16).padStart(2, '0'); }).join('');
}
function verifyPassword_(password, salt, hash) {
  if (!salt || !hash) return false;
  return safeEqual_(hashPassword_(String(password), String(salt)), String(hash));
}
function safeEqual_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* ---------- session tokens ---------- */

function tokenSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('SESSION_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('SESSION_SECRET', secret);
  }
  return secret;
}
function sign_(text) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(text, tokenSecret_()));
}
/* The token carries a short fingerprint of the account's current salt, so a
   password change/reset (which writes a new salt) invalidates old tokens. */
function versionOf_(salt) { return String(salt || '').slice(0, 12); }
function makeToken_(role, name, salt, exp) {
  const payload = Utilities.base64EncodeWebSafe(JSON.stringify({ r: role, n: name, v: versionOf_(salt), e: exp }), Utilities.Charset.UTF_8);
  return payload + '.' + sign_(payload);
}
function verifyToken_(token) {
  if (typeof token !== 'string' || token.length > 4000) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (!safeEqual_(sign_(parts[0]), parts[1])) return null;
  let p;
  try {
    p = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0], Utilities.Charset.UTF_8)).getDataAsString('UTF-8'));
  } catch (err) { return null; }
  if (!p || typeof p.e !== 'number' || p.e < Date.now()) return null;
  if (p.r !== 'admin' && p.r !== 'seller') return null;
  return p;
}
/* Returns { role, name } for a valid token whose account still exists, else null. */
function readSession_(token) {
  const p = verifyToken_(token);
  if (!p) return null;
  if (p.r === 'admin') {
    const sheet = ensureAdminSheet_();
    const row = findRow_(sheet, 1, p.n);
    if (row === -1) return null;
    if (versionOf_(sheet.getRange(row, 3).getValue()) !== p.v) return null;
    return { role: 'admin', name: String(p.n) };
  }
  const sheet = ensureSellersSheet_();
  const row = findRow_(sheet, 1, p.n);
  if (row === -1) return null;
  const vals = sheet.getRange(row, 1, 1, 5).getValues()[0];
  if (!vals[2] || versionOf_(vals[4]) !== p.v) return null;
  return { role: 'seller', name: String(p.n) };
}
function sessionResponse_(role, name, salt, extra) {
  const exp = Date.now() + SESSION_MS;
  const out = { ok: true, token: makeToken_(role, name, salt, exp), role: role, name: name, exp: exp };
  if (extra) Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
  return jsonOutput_(out);
}
function actor_(session) { return session ? session.role + ':' + session.name : 'system'; }

/* ---------- audit log ---------- */

function logAudit_(action, recordType, recordId, oldValue, newValue, actor) {
  try {
    ensureAuditLogSheet_().appendRow([
      new Date(), action, recordType, String(recordId == null ? '' : recordId),
      String(oldValue == null ? '' : oldValue), String(newValue == null ? '' : newValue), String(actor || 'unknown'),
    ]);
  } catch (err) {
    // Never let audit logging break the actual operation.
  }
}

/* ---------- idempotency (double-submit / retry protection) ---------- */

function withIdempotency_(clientRequestId, fn) {
  if (typeof clientRequestId !== 'string' || !clientRequestId || clientRequestId.length > 100) return fn();
  const cache = CacheService.getScriptCache();
  const key = 'req_' + clientRequestId;
  const cached = cache.get(key);
  if (cached) return ContentService.createTextOutput(cached).setMimeType(ContentService.MimeType.JSON);
  const result = fn();
  try { cache.put(key, result.getContent(), IDEMPOTENCY_TTL_SEC); } catch (err) { /* cache is best-effort */ }
  return result;
}

/* ---------- GET: read everything ---------- */

function publicConfig_(cfg) {
  return { teamPlan: Number(cfg.teamPlan) || 0, leaderPlan: 0, categories: {}, leader: { tiers: [] }, sellers: {} };
}

function doGet(e) {
  const session = readSession_(e && e.parameter ? e.parameter.token : null);
  const isAdmin = !!session && session.role === 'admin';

  const planRows = readPlanRows_();
  const payBase = planRows.length ? null : legacyBase_();
  const current = effectiveFrom_(planRows, currentMonth_()) || payBase || payDefaults_();
  const plan = Number(current.teamPlan) || 0;

  const sellers = [];
  const sellersSheet = ensureSellersSheet_();
  if (sellersSheet.getLastRow() > 1) {
    sellersSheet.getRange(2, 1, sellersSheet.getLastRow() - 1, 7).getValues().forEach(function (row) {
      if (row[0] === '') return;
      const a = (current.sellers || {})[String(row[0])] || { cat: '', plan: 0 };
      const s = { name: String(row[0]), hasLogin: !!row[2] };
      if (session) {
        s.target = Number(a.plan) || 0; s.category = a.cat || '';
        const sd = row[6] === '' || row[6] == null ? '' : formatDate_(row[6]);
        s.startDate = isValidDateStr_(sd) ? sd : '';
      }
      if (isAdmin) s.username = String(row[2] || '');
      sellers.push(s);
    });
  }

  const entries = [];
  const entriesSheet = ensureEntriesSheet_();
  if (entriesSheet.getLastRow() > 1) {
    entriesSheet.getRange(2, 1, entriesSheet.getLastRow() - 1, 5).getValues().forEach(function (row, i) {
      if (row[0] === '' || row[2] === '' || row[2] == null) return;
      const id = row[3] ? String(row[3]) : '__row' + (i + 2); // legacy rows without an ID
      entries.push({ id: id, date: formatDate_(row[0]), seller: String(row[1] || ''), amount: Number(row[2]) || 0, cls: validClass_(row[4]) ? String(row[4]) : '' });
    });
  }

  const standards = [];
  const standardsSheet = ensureStandardsSheet_();
  if (standardsSheet.getLastRow() > 1) {
    standardsSheet.getRange(2, 1, standardsSheet.getLastRow() - 1, 3).getValues().forEach(function (row) {
      if (row[0] !== '') standards.push({ name: String(row[0]), unit: String(row[1] || ''), minPerDay: Number(row[2]) || 0 });
    });
  }

  const activity = [];
  const activitySheet = ensureActivitySheet_();
  if (activitySheet.getLastRow() > 1) {
    activitySheet.getRange(2, 1, activitySheet.getLastRow() - 1, 4).getValues().forEach(function (row) {
      if (row[0] !== '' && row[1] !== '' && row[2] !== '') {
        activity.push({ date: formatDate_(row[0]), seller: String(row[1]), standard: String(row[2]), value: Number(row[3]) || 0 });
      }
    });
  }

  const calls = [];
  const callSheet = ensureCallTimeSheet_();
  if (callSheet.getLastRow() > 1) {
    callSheet.getRange(2, 1, callSheet.getLastRow() - 1, 3).getValues().forEach(function (row) {
      if (row[0] !== '' && row[1] !== '') calls.push({ date: formatDate_(row[0]), seller: String(row[1]), minutes: Number(row[2]) || 0 });
    });
  }

  const auditLog = [];
  if (isAdmin) {
    const auditSheet = ensureAuditLogSheet_();
    const last = auditSheet.getLastRow();
    if (last > 1) {
      const start = Math.max(2, last - AUDIT_CAP + 1);
      auditSheet.getRange(start, 1, last - start + 1, 7).getValues().forEach(function (row) {
        auditLog.push({
          timestamp: row[0] instanceof Date ? row[0].toISOString() : String(row[0]),
          action: String(row[1]), recordType: String(row[2]), recordId: String(row[3]),
          oldValue: String(row[4]), newValue: String(row[5]), actor: String(row[6]),
        });
      });
      auditLog.reverse(); // newest first
    }
  }

  return jsonOutput_({
    plan: Number(plan) || 0,
    sellers: sellers,
    entries: entries,
    standards: standards,
    activity: activity,
    calls: calls,
    adminExists: ensureAdminSheet_().getLastRow() > 1,
    auditLog: auditLog,
    // Pay rules and seller categories are for logged-in team members only;
    // the public dashboard just needs each month's team plan.
    payConfigs: planRows.map(function (r) { return { month: r.month, config: session ? r.config : publicConfig_(r.config) }; }),
    payBase: payBase && !session ? publicConfig_(payBase) : payBase,
    me: session,
  });
}

/* ---------- POST: writes ---------- */

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return fail_('Malformed request.');
  }
  if (!body || typeof body !== 'object') return fail_('Malformed request.');
  const handler = ACTIONS[body.action];
  if (!handler) return fail_('Unknown action.');

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    return fail_('The server is busy. Please try again in a moment.');
  }
  try {
    let session = null;
    if (!PUBLIC_ACTIONS[body.action]) {
      session = readSession_(body.token);
      if (!session) return authFail_();
      if (ADMIN_ACTIONS[body.action] && session.role !== 'admin') return fail_('Only the admin can do that.');
    }
    return withIdempotency_(body.clientRequestId, function () { return handler(body, session); });
  } catch (err) {
    return fail_('Server error: ' + String(err && err.message ? err.message : err));
  } finally {
    lock.releaseLock();
  }
}

const ACTIONS = {

  /* ---- auth ---- */

  login: function (body) {
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!username || !password) return fail_('Enter your username and password.');

    const adminSheet = ensureAdminSheet_();
    const aRow = findUsernameRow_(adminSheet, 1, username);
    if (aRow !== -1) {
      const a = adminSheet.getRange(aRow, 1, 1, 3).getValues()[0];
      if (!verifyPassword_(password, a[2], a[1])) return fail_(BAD_LOGIN);
      return sessionResponse_('admin', String(a[0]), a[2]);
    }

    const sellersSheet = ensureSellersSheet_();
    const sRow = findUsernameRow_(sellersSheet, 3, username);
    if (sRow !== -1) {
      const s = sellersSheet.getRange(sRow, 1, 1, 5).getValues()[0];
      if (!verifyPassword_(password, s[4], s[3])) return fail_(BAD_LOGIN);
      return sessionResponse_('seller', String(s[0]), s[4], { target: Number(s[1]) || 0 });
    }
    return fail_(BAD_LOGIN);
  },

  setupAdmin: function (body) {
    const sheet = ensureAdminSheet_();
    if (sheet.getLastRow() > 1) return fail_('An admin account already exists. Log in instead.');
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!username) return fail_('Choose a username.');
    if (password.length < MIN_PASSWORD) return fail_('Password must be at least ' + MIN_PASSWORD + ' characters.');
    if (findUsernameRow_(ensureSellersSheet_(), 3, username) !== -1) return fail_('That username is already used by a seller.');
    const salt = makeSalt_();
    sheet.appendRow([username, hashPassword_(password, salt), salt]);
    logAudit_('adminSetup', 'Admin', username, '', 'account created', 'admin:' + username);
    return sessionResponse_('admin', username, salt);
  },

  changePassword: function (body, session) {
    const current = String(body.currentPassword || '');
    const next = String(body.newPassword || '');
    if (!current) return fail_('Enter your current password.');
    if (next.length < MIN_PASSWORD) return fail_('New password must be at least ' + MIN_PASSWORD + ' characters.');

    if (session.role === 'admin') {
      const sheet = ensureAdminSheet_();
      const row = findRow_(sheet, 1, session.name);
      if (row === -1) return authFail_();
      const a = sheet.getRange(row, 1, 1, 3).getValues()[0];
      if (!verifyPassword_(current, a[2], a[1])) return fail_('Current password is incorrect.');
      const salt = makeSalt_();
      sheet.getRange(row, 2, 1, 2).setValues([[hashPassword_(next, salt), salt]]);
      logAudit_('passwordChanged', 'Admin', session.name, '', '', actor_(session));
      return sessionResponse_('admin', session.name, salt);
    }

    const sheet = ensureSellersSheet_();
    const row = findRow_(sheet, 1, session.name);
    if (row === -1) return authFail_();
    const s = sheet.getRange(row, 1, 1, 5).getValues()[0];
    if (!verifyPassword_(current, s[4], s[3])) return fail_('Current password is incorrect.');
    const salt = makeSalt_();
    sheet.getRange(row, 4, 1, 2).setValues([[hashPassword_(next, salt), salt]]);
    logAudit_('passwordChanged', 'Seller', session.name, '', '', actor_(session));
    return sessionResponse_('seller', session.name, salt, { target: Number(s[1]) || 0 });
  },

  /* Admin: set or reset a seller's login. An empty username removes the login. */
  setSellerCredentials: function (body, session) {
    const sheet = ensureSellersSheet_();
    const row = findRow_(sheet, 1, body.name);
    if (row === -1) return fail_('Seller not found.');

    const username = String(body.username || '').trim();
    if (!username) {
      sheet.getRange(row, 3, 1, 3).setValues([['', '', '']]);
      logAudit_('sellerLoginRemoved', 'Seller', body.name, 'had login', 'login removed', actor_(session));
      return jsonOutput_({ ok: true });
    }
    const password = String(body.password || '');
    if (password.length < MIN_PASSWORD) return fail_('Password must be at least ' + MIN_PASSWORD + ' characters.');

    const taken = findUsernameRow_(sheet, 3, username);
    if (taken !== -1 && taken !== row) return fail_('That username is already taken.');
    if (findUsernameRow_(ensureAdminSheet_(), 1, username) !== -1) return fail_('That username is already taken.');

    const salt = makeSalt_();
    sheet.getRange(row, 3, 1, 3).setValues([[username, hashPassword_(password, salt), salt]]);
    logAudit_('sellerLoginSet', 'Seller', body.name, '', 'username: ' + username, actor_(session));
    return jsonOutput_({ ok: true });
  },

  /* ---- plan ---- */

  setPlan: function (body, session) {
    if (!isPositiveNumber_(body.plan)) return fail_('Plan must be a number greater than 0.');
    if (Number(body.plan) > MAX_AMOUNT) return fail_('That plan is too large — check for extra zeros.');
    const month = isValidMonth_(body.month) ? body.month : currentMonth_();
    if (month > nextMonth_(currentMonth_())) return fail_('You can plan at most one month ahead.');
    let oldVal = 0;
    updateMonthConfig_(month, function (cfg) { oldVal = cfg.teamPlan || 0; cfg.teamPlan = Number(body.plan); });
    if (month === currentMonth_()) ensureConfigSheet_().getRange('B1').setValue(Number(body.plan));
    logAudit_('planChanged', 'Config', 'plan ' + month, oldVal, Number(body.plan), actor_(session));
    return jsonOutput_({ ok: true });
  },

  /* Admin: plans and pay tables for one month (that month onward, until a later month has its own). */
  savePayConfig: function (body, session) {
    const month = isValidMonth_(body.month) ? body.month : null;
    if (!month) return fail_('Choose a month.');
    if (month > nextMonth_(currentMonth_())) return fail_('You can plan at most one month ahead.');
    const team = body.teamPlan, leader = body.leaderPlan === '' || body.leaderPlan == null ? 0 : body.leaderPlan;
    if (!isPositiveNumber_(team) || Number(team) > MAX_AMOUNT) return fail_('Team plan must be a number greater than 0.');
    if (!isNonNegativeNumber_(leader) || Number(leader) > MAX_AMOUNT) return fail_('Leader plan must be 0 or more.');
    const cats = body.categories || {};
    const clean = {};
    for (let i = 0; i < CATEGORIES.length; i++) {
      const k = CATEGORIES[i];
      const c = cats[k] || {};
      if (!isPositiveNumber_(c.plan) || Number(c.plan) > MAX_AMOUNT) return fail_('Each category plan must be a number greater than 0.');
      const tiers = Array.isArray(c.tiers) ? c.tiers.slice() : null;
      const err = validateTiers_(tiers, 'seller');
      if (err) return fail_(err);
      clean[k] = { plan: Number(c.plan), tiers: tiers };
    }
    const lt = body.leader && Array.isArray(body.leader.tiers) ? body.leader.tiers.slice() : null;
    const lerr = validateTiers_(lt, 'leader');
    if (lerr) return fail_(lerr);
    updateMonthConfig_(month, function (cfg) {
      cfg.teamPlan = Number(team);
      cfg.leaderPlan = Number(leader);
      cfg.categories = clean;
      cfg.leader = { tiers: lt };
    });
    if (month === currentMonth_()) ensureConfigSheet_().getRange('B1').setValue(Number(team));
    logAudit_('payPlanChanged', 'PlanConfig', month, '', 'team ' + Number(team) + ', C ' + clean.C.plan + ', OTHER ' + clean.OTHER.plan, actor_(session));
    return jsonOutput_({ ok: true });
  },

  /* ---- entries ---- */

  addEntry: function (body, session) {
    const seller = session.role === 'seller' ? session.name : String(body.seller || '').trim();
    if (!seller) return fail_('Choose a seller.');
    const err = validateSale_(body.date, body.amount);
    if (err) return fail_(err);
    const cls = body.cls == null || body.cls === '' ? '' : String(body.cls);
    if (cls && !validClass_(cls)) return fail_('Choose the client class: C, G, O, A or B.');
    if (findRow_(ensureSellersSheet_(), 1, seller) === -1) return fail_('Unknown seller.');

    const id = Utilities.getUuid();
    ensureEntriesSheet_().appendRow([body.date, seller, Number(body.amount), id, cls]);
    logAudit_('saleCreated', 'Entry', id, '', seller + ' / ' + body.date + ' / ' + Number(body.amount) + (cls ? ' / ' + cls : ''), actor_(session));
    return jsonOutput_({ ok: true, id: id });
  },

  /* Change an entry's amount, date and (admin only) seller. Send only what changes. */
  editEntry: function (body, session) {
    const hasAmount = body.amount !== undefined && body.amount !== null;
    const hasDate = body.date !== undefined && body.date !== null;
    const hasSeller = body.seller !== undefined && body.seller !== null;
    const hasCls = body.cls !== undefined && body.cls !== null;
    if (!hasAmount && !hasDate && !hasSeller && !hasCls) return fail_('Nothing to change.');
    if (hasCls && !validClass_(body.cls)) return fail_('Choose the client class: C, G, O, A or B.');
    if (hasAmount) { const err = validateAmount_(body.amount); if (err) return fail_(err); }
    if (hasDate) {
      if (!isValidDateStr_(body.date)) return fail_('Invalid date.');
      if (body.date > dateOffsetStr_(1)) return fail_('Sales can’t be logged for a future date.');
    }
    const sheet = ensureEntriesSheet_();
    const row = findEntryRow_(sheet, body.id);
    if (row === -1) return fail_('That entry no longer exists. Refresh and try again.');
    const vals = sheet.getRange(row, 1, 1, 5).getValues()[0];
    if (session.role === 'seller' && String(vals[1]) !== session.name) return fail_('You can only edit your own entries.');

    let seller = String(vals[1]);
    if (hasSeller) {
      if (session.role !== 'admin') return fail_('Only the admin can move a sale to another seller.');
      seller = String(body.seller).trim();
      if (!seller || findRow_(ensureSellersSheet_(), 1, seller) === -1) return fail_('Unknown seller.');
    }
    const date = hasDate ? body.date : formatDate_(vals[0]);
    const amount = hasAmount ? Number(body.amount) : Number(vals[2]);
    const cls = hasCls ? String(body.cls) : String(vals[4] || '');
    sheet.getRange(row, 1, 1, 3).setValues([[date, seller, amount]]);
    sheet.getRange(row, 5).setValue(cls);
    logAudit_('saleEdited', 'Entry', body.id,
      vals[1] + ' / ' + formatDate_(vals[0]) + ' / ' + vals[2] + (vals[4] ? ' / ' + vals[4] : ''),
      seller + ' / ' + date + ' / ' + amount + (cls ? ' / ' + cls : ''), actor_(session));
    return jsonOutput_({ ok: true });
  },

  /* Admin: add several sales for one date in a single request.
     body.rows = [{ seller, amount }, ...]. All rows are checked before anything is written. */
  addEntriesBulk: function (body, session) {
    const err = isValidDateStr_(body.date) ? null : 'Invalid date.';
    if (err) return fail_(err);
    if (body.date > dateOffsetStr_(1)) return fail_('Sales can’t be logged for a future date.');
    if (!Array.isArray(body.rows) || !body.rows.length) return fail_('Enter at least one amount.');
    if (body.rows.length > MAX_BULK_ROWS) return fail_('Too many rows in one save (max ' + MAX_BULK_ROWS + ').');

    const sellersSheet = ensureSellersSheet_();
    const seen = {};
    for (let i = 0; i < body.rows.length; i++) {
      const r = body.rows[i] || {};
      const seller = String(r.seller || '').trim();
      if (!seller || findRow_(sellersSheet, 1, seller) === -1) return fail_('Unknown seller: ' + (seller || '(blank)') + '.');
      if (seen[seller]) return fail_(seller + ' appears twice. Combine the amounts into one row.');
      seen[seller] = true;
      const aErr = validateAmount_(r.amount);
      if (aErr) return fail_(seller + ': ' + aErr);
      if (r.cls != null && r.cls !== '' && !validClass_(r.cls)) return fail_(seller + ': choose the client class: C, G, O, A or B.');
    }
    const sheet = ensureEntriesSheet_();
    const ids = [];
    body.rows.forEach(function (r) {
      const id = Utilities.getUuid();
      const seller = String(r.seller).trim();
      const cls = r.cls ? String(r.cls) : '';
      sheet.appendRow([body.date, seller, Number(r.amount), id, cls]);
      logAudit_('saleCreated', 'Entry', id, '', seller + ' / ' + body.date + ' / ' + Number(r.amount) + (cls ? ' / ' + cls : '') + ' (bulk)', actor_(session));
      ids.push(id);
    });
    return jsonOutput_({ ok: true, ids: ids, count: ids.length });
  },

  deleteEntry: function (body, session) {
    const sheet = ensureEntriesSheet_();
    const row = findEntryRow_(sheet, body.id);
    if (row === -1) return fail_('That entry no longer exists. Refresh and try again.');
    const vals = sheet.getRange(row, 1, 1, 4).getValues()[0];
    if (session.role === 'seller' && String(vals[1]) !== session.name) return fail_('You can only delete your own entries.');
    sheet.deleteRow(row);
    logAudit_('saleDeleted', 'Entry', body.id, vals[1] + ' / ' + formatDate_(vals[0]) + ' / ' + vals[2], '', actor_(session));
    return jsonOutput_({ ok: true });
  },

  /* ---- sellers ---- */

  /* Admin: add a seller. Username + password are optional; if given, the login is created too. */
  addSeller: function (body, session) {
    const name = String(body.name || '').trim();
    if (!name) return fail_('Name is required.');
    const target = body.target === '' || body.target === undefined || body.target === null ? 0 : body.target;
    const err = validateTarget_(target);
    if (err) return fail_(err);
    const cat = body.category == null ? '' : String(body.category);
    if (!validCategory_(cat)) return fail_('Choose the seller’s category: C or Other.');
    const start = body.startDate == null ? '' : String(body.startDate);
    if (start && !isValidDateStr_(start)) return fail_('Invalid start date.');
    const sheet = ensureSellersSheet_();
    if (findRow_(sheet, 1, name) !== -1) return fail_('A seller with that name already exists.');

    const username = String(body.username || '').trim();
    let login = ['', '', ''];
    if (username) {
      const password = String(body.password || '');
      if (password.length < MIN_PASSWORD) return fail_('Password must be at least ' + MIN_PASSWORD + ' characters.');
      if (findUsernameRow_(sheet, 3, username) !== -1 || findUsernameRow_(ensureAdminSheet_(), 1, username) !== -1) {
        return fail_('That username is already taken.');
      }
      const salt = makeSalt_();
      login = [username, hashPassword_(password, salt), salt];
    }
    sheet.appendRow([name, Number(target) || 0].concat(login, [cat, start]));
    setSellerAssignment_(name, cat, target, session);
    logAudit_('sellerCreated', 'Seller', name, '', 'category: ' + (cat || '—') + ', own plan: ' + (Number(target) || 'default') + (start ? ', starts ' + start : '') + (username ? ', username: ' + username : ''), actor_(session));
    return jsonOutput_({ ok: true });
  },

  /* Admin: rename a seller everywhere (roster, sales, activity). Their old
     session ends; they log in again with the same username. */
  renameSeller: function (body, session) {
    const oldName = String(body.name || '').trim();
    const newName = String(body.newName || '').trim();
    if (!newName) return fail_('Enter the new name.');
    if (newName === oldName) return fail_('That’s already the name.');
    const sheet = ensureSellersSheet_();
    const row = findRow_(sheet, 1, oldName);
    if (row === -1) return fail_('Seller not found.');
    if (findRow_(sheet, 1, newName) !== -1) return fail_('A seller with that name already exists.');
    sheet.getRange(row, 1).setValue(newName);

    let moved = 0;
    [[ensureEntriesSheet_(), 2], [ensureActivitySheet_(), 2], [ensureCallTimeSheet_(), 2]].forEach(function (pair) {
      const sh = pair[0], col = pair[1];
      const last = sh.getLastRow();
      if (last < 2) return;
      const vals = sh.getRange(2, col, last - 1, 1).getValues();
      for (let i = 0; i < vals.length; i++) {
        if (String(vals[i][0]) === oldName) { sh.getRange(i + 2, col).setValue(newName); moved++; }
      }
    });
    const planSheet = ensurePlanConfigSheet_();
    readPlanRows_().forEach(function (r) {
      if (r.config.sellers && Object.prototype.hasOwnProperty.call(r.config.sellers, oldName)) {
        r.config.sellers[newName] = r.config.sellers[oldName];
        delete r.config.sellers[oldName];
        writePlanRow_(planSheet, r.row, r.month, r.config);
      }
    });
    logAudit_('sellerRenamed', 'Seller', newName, oldName, newName + ' (' + moved + ' records updated)', actor_(session));
    return jsonOutput_({ ok: true, updated: moved });
  },

  /* Admin: a seller's category and/or own plan (0 = category default), from this month on. */
  updateSeller: function (body, session) {
    const hasTarget = body.target !== undefined && body.target !== null && body.target !== '';
    const hasCat = body.category !== undefined && body.category !== null;
    const hasStart = body.startDate !== undefined && body.startDate !== null;
    if (!hasTarget && !hasCat && !hasStart) return fail_('Nothing to change.');
    if (hasTarget) { const err = validateTarget_(body.target); if (err) return fail_(err); }
    if (hasCat && !validCategory_(String(body.category))) return fail_('Choose the seller’s category: C or Other.');
    if (hasStart && body.startDate !== '' && !isValidDateStr_(String(body.startDate))) return fail_('Invalid start date.');
    const sheet = ensureSellersSheet_();
    const row = findRow_(sheet, 1, body.name);
    if (row === -1) return fail_('Seller not found.');
    if (hasStart) {
      const oldStart = sheet.getRange(row, 7).getValue();
      const cell = sheet.getRange(row, 7);
      cell.setValue(String(body.startDate));
      logAudit_('sellerStartChanged', 'Seller', body.name, oldStart === '' ? '—' : formatDate_(oldStart), body.startDate || '—', actor_(session));
      if (!hasTarget && !hasCat) return jsonOutput_({ ok: true });
    }
    const cur = (effectiveFrom_(readPlanRows_(), currentMonth_()) || legacyBase_()).sellers || {};
    const old = cur[body.name] || { cat: '', plan: 0 };
    const cat = hasCat ? String(body.category) : (old.cat || '');
    const plan = hasTarget ? Number(body.target) : (Number(old.plan) || 0);
    setSellerAssignment_(body.name, cat, plan, session);
    logAudit_('sellerEdited', 'Seller', body.name,
      'category: ' + (old.cat || '—') + ', own plan: ' + (Number(old.plan) || 'default'),
      'category: ' + (cat || '—') + ', own plan: ' + (plan || 'default'), actor_(session));
    return jsonOutput_({ ok: true });
  },

  deleteSeller: function (body, session) {
    const sheet = ensureSellersSheet_();
    const row = findRow_(sheet, 1, body.name);
    if (row === -1) return fail_('Seller not found.');
    sheet.deleteRow(row);
    logAudit_('sellerDeleted', 'Seller', body.name, 'removed from roster', '', actor_(session));
    return jsonOutput_({ ok: true });
  },

  /* ---- standards ---- */

  addStandard: function (body, session) {
    const name = String(body.name || '').trim();
    if (!name) return fail_('Name is required.');
    if (!isNonNegativeNumber_(body.minPerDay) || Number(body.minPerDay) > MAX_ACTIVITY_VALUE) return fail_('Daily goal must be a number, 0 or greater.');
    const sheet = ensureStandardsSheet_();
    if (findRow_(sheet, 1, name) !== -1) return fail_('A standard with that name already exists.');
    const unit = String(body.unit || '').trim();
    sheet.appendRow([name, unit, Number(body.minPerDay)]);
    logAudit_('standardCreated', 'Standard', name, '', 'min ' + Number(body.minPerDay) + ' ' + unit, actor_(session));
    return jsonOutput_({ ok: true });
  },

  updateStandard: function (body, session) {
    if (!isNonNegativeNumber_(body.minPerDay) || Number(body.minPerDay) > MAX_ACTIVITY_VALUE) return fail_('Daily goal must be a number, 0 or greater.');
    const sheet = ensureStandardsSheet_();
    const row = findRow_(sheet, 1, body.name);
    if (row === -1) return fail_('Standard not found.');
    const old = sheet.getRange(row, 2, 1, 2).getValues()[0];
    const unit = String(body.unit || '').trim();
    sheet.getRange(row, 2, 1, 2).setValues([[unit, Number(body.minPerDay)]]);
    logAudit_('standardEdited', 'Standard', body.name, 'min ' + old[1] + ' ' + old[0], 'min ' + Number(body.minPerDay) + ' ' + unit, actor_(session));
    return jsonOutput_({ ok: true });
  },

  deleteStandard: function (body, session) {
    const sheet = ensureStandardsSheet_();
    const row = findRow_(sheet, 1, body.name);
    if (row === -1) return fail_('Standard not found.');
    sheet.deleteRow(row);
    logAudit_('standardDeleted', 'Standard', body.name, 'removed', '', actor_(session));
    return jsonOutput_({ ok: true });
  },

  /* ---- activity ---- */

  /* body.values = { standardName: value, ... } — upserts one row per seller/date/standard. */
  logActivity: function (body, session) {
    if (!isValidDateStr_(body.date)) return fail_('Invalid date.');
    if (body.date > dateOffsetStr_(1)) return fail_('Activity can’t be logged for a future date.');
    const seller = session.role === 'seller' ? session.name : String(body.seller || '').trim();
    if (!seller) return fail_('Choose a seller.');
    if (findRow_(ensureSellersSheet_(), 1, seller) === -1) return fail_('Unknown seller.');
    const hasCall = body.callMinutes !== undefined && body.callMinutes !== null && body.callMinutes !== '';
    if (hasCall && (!isNonNegativeNumber_(body.callMinutes) || Number(body.callMinutes) > MAX_CALL_MINUTES || Math.floor(Number(body.callMinutes)) !== Number(body.callMinutes))) {
      return fail_('Call time must be between 0:00 and 24:00.');
    }
    const values = body.values == null ? {} : body.values;
    if (typeof values !== 'object' || Array.isArray(values)) return fail_('No values provided.');
    if (!hasCall && !Object.keys(values).length) return fail_('No values provided.');

    const known = {};
    const stSheet = ensureStandardsSheet_();
    if (stSheet.getLastRow() > 1) {
      stSheet.getRange(2, 1, stSheet.getLastRow() - 1, 1).getValues().forEach(function (r) { if (r[0] !== '') known[String(r[0])] = true; });
    }

    const sheet = ensureActivitySheet_();
    const lastRow = sheet.getLastRow();
    const existing = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, 4).getValues() : [];
    const saved = {};
    const skipped = [];

    Object.keys(values).forEach(function (standardName) {
      const raw = values[standardName];
      if (!known[standardName] || !isNonNegativeNumber_(raw) || Number(raw) > MAX_ACTIVITY_VALUE) {
        skipped.push(standardName);
        return;
      }
      const value = Number(raw);
      let foundRow = -1;
      for (let i = 0; i < existing.length; i++) {
        if (formatDate_(existing[i][0]) === body.date && String(existing[i][1]) === seller && String(existing[i][2]) === standardName) {
          foundRow = i + 2;
          break;
        }
      }
      if (foundRow !== -1) sheet.getRange(foundRow, 4).setValue(value);
      else sheet.appendRow([body.date, seller, standardName, value]);
      saved[standardName] = value;
    });

    let callSaved = null;
    if (hasCall) {
      const cSheet = ensureCallTimeSheet_();
      const cLast = cSheet.getLastRow();
      const cRows = cLast > 1 ? cSheet.getRange(2, 1, cLast - 1, 2).getValues() : [];
      let cRow = -1;
      for (let i = 0; i < cRows.length; i++) {
        if (formatDate_(cRows[i][0]) === body.date && String(cRows[i][1]) === seller) { cRow = i + 2; break; }
      }
      callSaved = Number(body.callMinutes);
      if (cRow !== -1) cSheet.getRange(cRow, 3).setValue(callSaved);
      else cSheet.appendRow([body.date, seller, callSaved]);
    }

    if (!Object.keys(saved).length && callSaved === null) return fail_('No valid values to save.');
    const logged = callSaved === null ? saved : Object.assign({}, saved, { callMinutes: callSaved });
    logAudit_('activityLogged', 'Activity', seller + ' / ' + body.date, '', JSON.stringify(logged), actor_(session));
    return jsonOutput_({ ok: true, saved: saved, skipped: skipped, callMinutes: callSaved });
  },
};

function findEntryRow_(sheet, id) {
  id = String(id || '');
  if (id.indexOf('__row') === 0) {
    const row = Number(id.replace('__row', ''));
    return row >= 2 && row <= sheet.getLastRow() ? row : -1;
  }
  return findRow_(sheet, 4, id);
}
