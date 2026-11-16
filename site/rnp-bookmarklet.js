/* "Copy RNP data" — runs as a bookmark on any page of the Englify ERP while you
   are logged in. It reads every seller's Sale RNP page for one month (sales by
   product, payments, leads, call time) plus each seller's class from the RNP
   board, and gives you one block of text to paste into
   Sales Pace → Settings → Sync from RNP. It only reads; it never changes the ERP.
   Built into a javascript: link by the Settings page (see rnpBookmarkHref in app.js). */
(function () {
  if (!/englify\.school$/.test(location.hostname)) { alert('Open the Englify ERP first, then click this bookmark.'); return; }
  var now = new Date();
  var def = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  var month = prompt('Which month? (YYYY-MM)', def);
  if (!month) return;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) { alert('Use the form YYYY-MM, e.g. ' + def); return; }

  var box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:20px auto auto 20px;z-index:2147483647;background:#111827;color:#f9fafb;font:14px/1.5 system-ui,sans-serif;padding:16px 18px;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.4);width:min(460px,90vw)';
  box.innerHTML = '<b>Sales Pace · reading RNP ' + month + '</b><div id="sp-msg" style="margin-top:6px">Starting…</div>';
  document.body.appendChild(box);
  var msg = function (t) { box.querySelector('#sp-msg').textContent = t; };

  var num = function (s) { if (!s || s === '-') return 0; var m = String(s).replace(/UZS/, '').match(/^[\d ]+/); return m ? +m[0].replace(/ /g, '') : 0; };
  var get = function (url) { return fetch(url, { credentials: 'same-origin' }).then(function (r) { return r.text(); }); };
  var parse = function (h) { return new DOMParser().parseFromString(h, 'text/html'); };
  var ok = function (h) { return /Ishga olingan kun/.test(h) && /Dam olish kuni/.test(h); };
  var base = '/applicant/sales-manager/sale-rnp';

  Promise.all([get(base + '?date=' + month), get('/applicant/sales-manager/rnp?date=' + month)]).then(function (pages) {
    var d0 = parse(pages[0]);
    var sellers = [], seen = {};
    [].forEach.call(d0.querySelectorAll('a[href*="created_by"]'), function (a) {
      var id = new URL(a.href, location.href).searchParams.get('created_by[0]');
      var name = a.textContent.replace(/\(\d+%\)/, '').replace(/\s+/g, ' ').trim();
      if (id && name && !seen[id] && /\(\d+%\)/.test(a.textContent)) { seen[id] = 1; sellers.push({ id: id, name: name }); }
    });
    if (!sellers.length) throw new Error('No sellers found. Are you logged in to the ERP?');
    var cls = {};
    var txt = parse(pages[1]).body.innerText || parse(pages[1]).body.textContent;
    (txt.match(/[OGABCX] class\s+[^\n(]+?\s*\(\d+%\)/g) || []).forEach(function (m) {
      var x = m.match(/^([OGABCX]) class\s+([^\n(]+?)\s*\(/); if (x) cls[x[2].trim()] = x[1] === 'X' ? '' : x[1];
    });

    var out = {}, done = 0, idx = 0;
    var one = function (s) {
      var tries = 0;
      var go = function () {
        return get(base + '?date=' + month + '&created_by[0]=' + s.id).then(function (h) {
          if (!ok(h)) { if (++tries < 6) return new Promise(function (r) { setTimeout(r, 800); }).then(go); throw new Error('Could not read ' + s.name); }
          var d = parse(h);
          var R = [].map.call(d.querySelectorAll('tr'), function (tr) { return [].map.call(tr.children, function (c) { return c.textContent.replace(/\s+/g, ' ').trim(); }); });
          var info = function (k) { var r = R.find(function (r) { return r.length === 2 && r[0] === k; }); return r ? r[1] : ''; };
          var hdr = R.find(function (r) { return r.some(function (c) { return /^\d\d-\w{3}$/.test(c); }); });
          var dates = hdr ? hdr.slice(1).map(function (x) { return month + '-' + x.slice(0, 2); }) : [];
          var days = {};
          var D = function (i) { return days[dates[i]] = days[dates[i]] || { p: {}, pay: {} }; };
          R.forEach(function (r) {
            if (r.length !== dates.length + 1) return;
            var k = r[0], m;
            if (k === 'Jami leadlar soni') r.slice(1).forEach(function (c, i) { var v = num(c); if (v) D(i).lt = v; });
            else if (k === 'Aloqaga chiqilgan leadlar soni') r.slice(1).forEach(function (c, i) { var v = num(c); if (v) D(i).lc = v; });
            else if (k === 'Calls Dialog duration') r.slice(1).forEach(function (c, i) {
              var t = c.replace(/Show.*$/, '').replace(/^:\s*/, '').trim().match(/^(\d+):(\d+)$/);
              var v = t ? (+t[1]) * 60 + (+t[2]) : 0; if (v) D(i).min = v; });
            else if (k.indexOf('Jami') === 0) return;
            else if ((m = k.match(/^(.*) summasi$/))) r.slice(1).forEach(function (c, i) { var v = num(c); if (v) (D(i).p[m[1]] = D(i).p[m[1]] || [0, 0])[0] = v; });
            else if ((m = k.match(/^(.*) soni$/))) r.slice(1).forEach(function (c, i) { var v = num(c); if (v) (D(i).p[m[1]] = D(i).p[m[1]] || [0, 0])[1] = v; });
            else if ((m = k.match(/^(.*) orqali qabul qilingan summa$/))) r.slice(1).forEach(function (c, i) { var v = num(c); if (v) D(i).pay[m[1]] = v; });
          });
          Object.keys(days).forEach(function (k) { var x = days[k]; if (!Object.keys(x.p).length && !Object.keys(x.pay).length && !x.lt && !x.lc && !x.min) delete days[k]; });
          out[s.id] = { erp: s.name, team: info('Team'), cls: cls[s.name] || '', days: days };
          msg('Read ' + (++done) + ' of ' + sellers.length + ' sellers…');
        });
      };
      return go();
    };
    var worker = function () { if (idx >= sellers.length) return Promise.resolve(); var s = sellers[idx++]; return one(s).then(worker); };
    msg('Read 0 of ' + sellers.length + ' sellers…');
    return Promise.all([worker(), worker(), worker()]).then(function () {
      var data = { kind: 'sales-pace-rnp', v: 1, month: month, at: new Date().toISOString(), sellers: sellers.map(function (s) { return out[s.id]; }) };
      var text = JSON.stringify(data);
      box.innerHTML = '<b>RNP ' + month + ' is ready</b> (' + sellers.length + ' sellers)' +
        '<div style="margin:8px 0">Click <b>Copy</b>, then in Sales Pace open <b>Settings → Sync from RNP</b> and paste.</div>' +
        '<button id="sp-copy" style="font:inherit;font-weight:600;padding:8px 14px;border:0;border-radius:8px;background:#3b82f6;color:#fff;cursor:pointer">Copy</button> ' +
        '<button id="sp-close" style="font:inherit;padding:8px 14px;border:0;border-radius:8px;background:#374151;color:#fff;cursor:pointer">Close</button>' +
        '<textarea id="sp-text" readonly style="display:block;width:100%;height:60px;margin-top:10px;font:11px monospace"></textarea>';
      var ta = box.querySelector('#sp-text'); ta.value = text;
      box.querySelector('#sp-close').onclick = function () { box.remove(); };
      box.querySelector('#sp-copy').onclick = function () {
        var b = this;
        var done2 = function () { b.textContent = 'Copied ✓'; };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done2, function () { ta.select(); document.execCommand('copy'); done2(); });
        else { ta.select(); document.execCommand('copy'); done2(); }
      };
    });
  }).catch(function (e) {
    box.innerHTML = '<b>Could not read the RNP</b><div style="margin-top:6px">' + String(e && e.message || e) + '</div>';
    setTimeout(function () { box.remove(); }, 8000);
  });
})();
