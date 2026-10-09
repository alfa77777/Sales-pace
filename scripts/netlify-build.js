#!/usr/bin/env node
/*
 * Netlify build step for Sales Pace.
 *
 * 1. Puts the Apps Script /exec URL into site/index.html from the
 *    SALES_PACE_SCRIPT_URL environment variable, so the URL never lives in git.
 * 2. Refreshes the ?v=<hash> suffix on each asset so browsers load new files
 *    after every deploy.
 *
 * Fails the build (instead of shipping a broken site) when the variable is
 * missing or does not look like an Apps Script Web App URL.
 *
 * Local test:
 *   SALES_PACE_SCRIPT_URL=https://script.google.com/macros/s/XXX/exec node scripts/netlify-build.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SITE = path.join(__dirname, '..', 'site');
const INDEX = path.join(SITE, 'index.html');
const PLACEHOLDER = 'PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE';
const ASSETS = ['pace-ui.css', 'pace-lib.js', 'i18n.js', 'app.js'];
const URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;

function fail(msg) {
  console.error('\n✖ Sales Pace build failed: ' + msg + '\n');
  process.exit(1);
}

const url = (process.env.SALES_PACE_SCRIPT_URL || '').trim();
if (!url) {
  fail('SALES_PACE_SCRIPT_URL is not set.\n' +
       '  Netlify → Site configuration → Environment variables → Add a variable\n' +
       '  Key: SALES_PACE_SCRIPT_URL   Value: your Apps Script URL ending in /exec');
}
if (!URL_RE.test(url)) {
  fail('SALES_PACE_SCRIPT_URL does not look like an Apps Script Web App URL ending in /exec:\n  ' + url);
}

let html = fs.readFileSync(INDEX, 'utf8');

const count = html.split(PLACEHOLDER).length - 1;
if (count !== 1) {
  fail(`expected the placeholder ${PLACEHOLDER} exactly once in site/index.html, found ${count}.`);
}
html = html.replace(PLACEHOLDER, url);

for (const name of ASSETS) {
  const data = fs.readFileSync(path.join(SITE, name));
  const v = crypto.createHash('sha256').update(data).digest('hex').slice(0, 10);
  const attr = name.endsWith('.css') ? 'href' : 'src';
  const re = new RegExp(`${attr}="${name.replace('.', '\\.')}(\\?v=[0-9a-f]*)?"`, 'g');
  const matches = html.match(re) || [];
  if (matches.length !== 1) fail(`expected one ${attr}="${name}" in site/index.html, found ${matches.length}.`);
  html = html.replace(re, `${attr}="${name}?v=${v}"`);
}

fs.writeFileSync(INDEX, html);
console.log('✔ Sales Pace build: Apps Script URL set, asset versions refreshed.');
