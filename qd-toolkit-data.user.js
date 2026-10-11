// ==UserScript==
// @name         QD Toolkit Data
// @description  Optional helper for QD Toolkit: loads the prior-close VIX from the free daily VIX history of Cboe (not from QuantData).
// @version      1.0.0
// @namespace    https://github.com/julianhtg/qd-toolkit
// @homepageURL  https://github.com/julianhtg/qd-toolkit
// @supportURL   https://github.com/julianhtg/qd-toolkit/issues
// @updateURL    https://github.com/julianhtg/qd-toolkit/releases/latest/download/qd-toolkit-data.user.js
// @downloadURL  https://github.com/julianhtg/qd-toolkit/releases/latest/download/qd-toolkit-data.user.js
// @license      MIT
// @match        https://quantdata.us/*
// @match        https://*.quantdata.us/*
// @run-at       document-idle
// @inject-into  content
// @noframes
// @grant        GM.xmlHttpRequest
// @grant        GM_xmlhttpRequest
// @connect      cdn.cboe.com
// @connect      cdn-api.cboe.com
// ==/UserScript==

/*
 * QD Toolkit Data: an optional helper for the standard deviation lines of QD Toolkit.
 * The 15.87 rule needs the prior-close VIX. The QuantData page has only the VIX candles of its own day, and QuantData's
 * terms allow access only through its interface (no own requests to its API). This helper loads the free daily VIX
 * history of Cboe instead (1 request per page load, no QuantData request).
 * It runs in the content world, because only there GM.xmlHttpRequest can load a file of another site (the page itself
 * cannot: Cboe sends no CORS header). QD Toolkit asks with the DOM event "qdts:data-req" {id, op: 'vixClose', day}
 * and gets "qdts:data-res" {id, op, day, prev, close}: the close of the last day before `day` (weekends and holidays
 * have no row). DOM events with JSON strings work across the worlds.
 */
(() => {
  'use strict';
  if (window.__qdtsData) return;
  window.__qdtsData = 1;
  const URL = 'https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv';
  const REFETCH_MS = 60 * 60 * 1000; // a missing day: load the file again after 1 h (Cboe adds the day after the close)
  let rows = null;      // [{ day: 'YYYY-MM-DD', close }] ascending
  let loadedAt = -Infinity;
  let loading = null;

  function get(url) {
    return new Promise((resolve, reject) => {
      const gm = typeof GM !== 'undefined' && GM && GM.xmlHttpRequest ? GM.xmlHttpRequest.bind(GM)
        : typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : null;
      if (!gm) {
        reject(new Error('GM.xmlHttpRequest is not available'));
        return;
      }
      const req = gm({
        method: 'GET', url, timeout: 20000,
        onload: (r) => (r.status >= 200 && r.status < 300 ? resolve(r.responseText) : reject(new Error(`HTTP ${r.status}`))),
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timeout')),
      });
      // Violentmonkey's GM.xmlHttpRequest also returns a promise that rejects on an error: the callbacks above handle it.
      if (req && typeof req.catch === 'function') req.catch(() => {});
    });
  }

  // "DATE,OPEN,HIGH,LOW,CLOSE" with dates as MM/DD/YYYY (or YYYY-MM-DD).
  function parse(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const head = lines.findIndex((l) => /date/i.test(l) && /close/i.test(l));
    if (head < 0) return [];
    const cols = lines[head].split(',').map((c) => c.trim().toUpperCase());
    const di = cols.indexOf('DATE');
    const ci = cols.indexOf('CLOSE');
    const out = [];
    for (const l of lines.slice(head + 1)) {
      const f = l.split(',');
      const d = (f[di] || '').trim();
      const c = Number(f[ci]);
      let day = '';
      let m = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (m) day = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
      else if ((m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/))) day = d;
      if (day && c > 0) out.push({ day, close: c });
    }
    return out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  }

  function load(force) {
    if (loading) return loading;
    if (rows && !force) return Promise.resolve(rows);
    loading = get(URL).then((t) => {
      rows = parse(t);
      loadedAt = performance.now();
      return rows;
    }).finally(() => { loading = null; });
    return loading;
  }

  // The weekday before a day ("2026-10-12" -> "2026-10-09"; holidays are not known).
  function prevWeekday(day) {
    const d = new Date(`${day}T12:00:00Z`);
    do d.setUTCDate(d.getUTCDate() - 1); while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
    return d.toISOString().slice(0, 10);
  }

  // The close of the last day before `day`.
  function prior(day) {
    let r = null;
    for (const x of rows || []) {
      if (x.day >= day) break;
      r = x;
    }
    return r;
  }

  const send = (detail) => document.dispatchEvent(new CustomEvent('qdts:data-res', { detail: JSON.stringify(detail) }));
  document.addEventListener('qdts:data-req', async (e) => {
    let req;
    try {
      req = JSON.parse(e.detail);
    } catch {
      return;
    }
    if (!req || req.op !== 'vixClose' || !/^\d{4}-\d{2}-\d{2}$/.test(req.day || '')) return;
    try {
      await load(false);
      let r = prior(req.day);
      // The session before is not in the file yet (Cboe adds a day after the close): load it again, max once per hour.
      if ((!r || r.day < prevWeekday(req.day)) && performance.now() - loadedAt > REFETCH_MS) {
        await load(true);
        r = prior(req.day);
      }
      send({ id: req.id, op: 'vixClose', day: req.day, prev: r ? r.day : null, close: r ? r.close : null, last: rows.length ? rows[rows.length - 1].day : null });
    } catch (err) {
      send({ id: req.id, op: 'vixClose', day: req.day, error: String((err && err.message) || err) });
    }
  });
  // QD Toolkit asks with "qdts:data-ping" when it starts; it also listens for this message at any time.
  const ready = () => document.dispatchEvent(new CustomEvent('qdts:data-ready', { detail: JSON.stringify({ source: 'cboe' }) }));
  document.addEventListener('qdts:data-ping', ready);
  ready();
})();
