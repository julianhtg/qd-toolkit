// ==UserScript==
// @name         QD Toolkit
// @description  An unofficial all-round toolkit for QuantData: one global time slider to replay a session on all charts, σ lines and more.
// @version      1.0.0
// @namespace    https://github.com/julianhtg/qd-toolkit
// @homepageURL  https://github.com/julianhtg/qd-toolkit
// @supportURL   https://github.com/julianhtg/qd-toolkit/issues
// @updateURL    https://github.com/julianhtg/qd-toolkit/releases/latest/download/qd-toolkit.user.js
// @downloadURL  https://github.com/julianhtg/qd-toolkit/releases/latest/download/qd-toolkit.user.js
// @license      MIT
// @match        https://quantdata.us/*
// @match        https://*.quantdata.us/*
// @run-at       document-idle
// @inject-into  page
// @noframes
// @grant        none
// ==/UserScript==

/*
 * QD Toolkit: page bridge.
 * Runs in the page world (the extension loads it with "world": "MAIN"; the userscript has it at the top).
 * The content-script world cannot see React data. This part reads the data of the zoom bars
 * (rows, row times or strikes, tool name) and sets a zoom range with the bar's own onChangeEnd.
 * It also reads the plot area and the visible x range of each chart canvas (for the crosshair line).
 * content.js talks to it with the DOM events "qdts:req" and "qdts:res" (JSON strings).
 * It answers only where it can see React data, so a copy in the content-script world stays silent.
 */
(() => {
  'use strict';
  if (window.__qdTsBridge) return;
  window.__qdTsBridge = 1;
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  const etMin = (ms) => {
    const p = fmt.formatToParts(new Date(ms));
    const g = (t) => Number(p.find((x) => x.type === t).value);
    return (g('hour') % 24) * 60 + g('minute');
  };
  // The time of a minute of the ET day of `ms` (epoch ms), with 1 call of etMin (formatToParts is slow): the ET offset is
  // whole minutes, so the seconds of `ms` are the same in ET.
  const etAt = (ms, min) => ms - (etMin(ms) * 60000 + (((ms % 60000) + 60000) % 60000)) + min * 60000;
  const cache = new WeakMap(); // timestamps array -> ET minutes
  const minutesOf = (ts) => {
    let m = cache.get(ts);
    if (!m || m.length !== ts.length) {
      m = ts.map(etMin);
      cache.set(ts, m);
    }
    return m;
  };
  const fiberOf = (el) => {
    const k = Object.keys(el).find((x) => x.startsWith('__reactFiber$'));
    return k ? el[k] : null;
  };
  // React keeps 2 versions of a fiber. Use the one on the screen now: the same method as React's own
  // findCurrentFiberUsingSlowPath (the return pointers of a child can point into the old tree).
  // If the trees do not look as expected, use the fiber as it is.
  const current = (fiber) => {
    const alt = fiber.alternate;
    if (!alt) return fiber;
    let a = fiber;
    let b = alt;
    for (let guard = 0; guard < 500; guard++) {
      const pa = a.return;
      if (!pa) break;
      const pb = pa.alternate;
      if (!pb) {
        if (!pa.return) break;
        a = b = pa.return;
        continue;
      }
      if (pa.child === pb.child) {
        for (let c = pa.child; c; c = c.sibling) {
          if (c === a) return fiber;
          if (c === b) return alt;
        }
        return fiber;
      }
      if (a.return !== b.return) {
        a = pa;
        b = pb;
      } else {
        let found = false;
        for (let c = pa.child; c && !found; c = c.sibling) {
          if (c === a) { found = true; a = pa; b = pb; } else if (c === b) { found = true; b = pa; a = pb; }
        }
        for (let c = pb.child; c && !found; c = c.sibling) {
          if (c === a) { found = true; a = pb; b = pa; } else if (c === b) { found = true; b = pb; a = pa; }
        }
        if (!found) return fiber;
      }
      if (a.alternate !== b) return fiber;
    }
    if (a.tag !== 3 || !a.stateNode) return fiber;
    return a.stateNode.current === a ? fiber : alt;
  };
  // The strikes of a vertical strike bar (Interval Map, REALSITE-1.md section 17): no list, but the lowest and the highest
  // strike next to the row times; row 0 = the lowest strike, even steps. Kept per (min, max, rows), so a list stays the same.
  const stepStrikes = new Map();
  function strikesFrom(c, n) {
    const lo = c.minimumStrikePriceInCents;
    const hi = c.maximumStrikePriceInCents;
    if (typeof lo !== 'number' || typeof hi !== 'number' || !(hi > lo) || n < 2) return null;
    const step = (hi - lo) / (n - 1);
    if (Math.abs(step / 50 - Math.round(step / 50)) > 1e-6) return null; // not whole steps of $0.50: do not guess
    const key = `${lo}|${hi}|${n}`;
    let a = stepStrikes.get(key);
    if (!a) {
      a = Array.from({ length: n }, (_, i) => Math.round(lo + i * step));
      if (stepStrikes.size > 50) stepStrikes.clear();
      stepStrikes.set(key, a);
    }
    return a;
  }
  const isVertical = (root, p) => [...root.classList].some((c) => /^QDChartZoomSlider-module__.*__rootVertical$/.test(c)) || (p && p.orientation === 'vertical');
  function find(root) {
    let f = fiberOf(root);
    for (let i = 0; f && i < 8; i++, f = f.return) {
      const p = f.memoizedProps;
      if (p && typeof p === 'object' && typeof p.dataLength === 'number') break;
    }
    if (!f || !f.memoizedProps || typeof f.memoizedProps.dataLength !== 'number') return null;
    const zoom = current(f);
    const out = { props: zoom.memoizedProps, times: null, strikes: null, tool: null, vertical: isVertical(root, zoom.memoizedProps) };
    for (let g = zoom.return, i = 0; g && i < 40 && ((!out.times && !out.strikes) || !out.tool); g = g.return, i++) {
      const p = g.memoizedProps;
      if (!out.tool && p && typeof p === 'object' && typeof p.toolId === 'string' && p.toolName) {
        const meta = (p.tool && p.tool.metadata) || (p.cachedTool && p.cachedTool.metadata) || {};
        out.tool = { id: p.toolId, name: String(p.toolName), type: String(p.toolType || meta.type || '') };
      }
      if (!out.times && !out.strikes && typeof g.type !== 'string') {
        for (let h = g.memoizedState, j = 0; h && typeof h === 'object' && 'next' in h && j < 120; h = h.next, j++) {
          const c = h.memoizedState && typeof h.memoizedState === 'object' ? h.memoizedState.current : null;
          // The rows of this bar: a list of time stamps with (about) as many items as the bar has rows.
          // A new live row can come before the bar renders again: allow 2 more or less. Else it is not the list of this bar.
          if (c && typeof c === 'object' && Array.isArray(c.timestamps) && c.timestamps.length && Math.abs(c.timestamps.length - out.props.dataLength) <= 2) {
            out.times = c.timestamps;
            break;
          }
          // The Interval Map: the row times are "sortedEpochMillisTimestamps" (REALSITE-1.md section 17).
          if (!out.vertical && c && typeof c === 'object' && Array.isArray(c.sortedEpochMillisTimestamps) && c.sortedEpochMillisTimestamps.length
            && Math.abs(c.sortedEpochMillisTimestamps.length - out.props.dataLength) <= 2) {
            out.times = c.sortedEpochMillisTimestamps;
            out.im = true;
            break;
          }
          // Its vertical bar: the strikes from the lowest and the highest strike.
          if (out.vertical && c && typeof c === 'object' && 'minimumStrikePriceInCents' in c) {
            const s = strikesFrom(c, out.props.dataLength);
            if (s) {
              out.strikes = s;
              out.im = true;
              break;
            }
          }
          // A strike chart: the rows of its bar are the strikes (ascending, in cents).
          if (c && typeof c === 'object' && Array.isArray(c.sortedStrikes) && c.sortedStrikes.length && Math.abs(c.sortedStrikes.length - out.props.dataLength) <= 2) {
            out.strikes = c.sortedStrikes;
            break;
          }
        }
      }
    }
    return out;
  }
  // The value of the fiber on the screen. liveValueRef only if the bar has no value prop.
  const valueOf = (p, n) => {
    const v = Array.isArray(p.value) ? p.value : p.liveValueRef && Array.isArray(p.liveValueRef.current) ? p.liveValueRef.current : null;
    if (!Array.isArray(v)) return null;
    return [v[0] ?? 0, v[1] ?? n - 1]; // null = to the last row
  };
  function info(root) {
    const k = root.getAttribute('data-qdts-bar');
    const f = find(root);
    if (!f) return { k, ok: false };
    const m = f.times ? minutesOf(f.times) : null;
    const n = f.props.dataLength; // The handles show row / (dataLength - 1).
    const nm = m ? Math.min(n, m.length) : n; // rows that have a time
    const v = valueOf(f.props, n);
    const s = f.strikes;
    const sAt = (i) => s[Math.max(0, Math.min(s.length - 1, i))];
    return {
      k, ok: true, api: typeof f.props.onChangeEnd === 'function', n, times: !!m,
      value: v, vt: m && v ? [m[Math.max(0, Math.min(nm - 1, v[0]))], m[Math.max(0, Math.min(nm - 1, v[1]))]] : null,
      first: m ? m[0] : null, last: m ? m[nm - 1] : null,
      toolId: f.tool ? f.tool.id : null, name: f.tool ? f.tool.name : null, type: f.tool ? f.tool.type : null,
      strikes: !!s, sv: s && v ? [sAt(v[0]), sAt(v[1])] : null, sr: s ? [s[0], s[s.length - 1]] : null, vertical: f.vertical,
    };
  }
  // left: ET minute for the left end (the first row at or after it); right: ET minute for the right end (the last row at or before it).
  function set({ k, left, right, apply }) {
    const root = document.querySelector(`[data-qdts-bar="${k}"]`);
    const f = root && find(root);
    if (!f || !f.times) return { ok: false };
    const m = minutesOf(f.times);
    const dl = f.props.dataLength;
    const n = Math.min(m.length, dl); // rows that have a time
    let r = -1;
    for (let i = 0; i < n && m[i] <= right; i++) r = i;
    if (r < 0) r = 0;
    let l = m.findIndex((x) => x >= left);
    // The left time is after the right end (for example a replay before 09:30): show from the first row.
    // The left end then stays there until the right end passes the left time again (Julian, 2026-10-09).
    if (l < 0 || l > r) l = 0;
    let how = 'none';
    if (apply && typeof f.props.onChangeEnd === 'function') {
      // The Interval Map shows the range of onChange; its onChangeEnd only stores it (Julian, 2026-10-11: with
      // onChangeEnd alone its time bar did not move; its strike bar moved with the live follow, which calls both).
      if (f.im && typeof f.props.onChange === 'function') f.props.onChange([l, r]);
      f.props.onChangeEnd([l, r]);
      how = 'api';
    }
    // The handles show row / (dataLength - 1): the drag fallback needs these fractions.
    return { ok: true, how, l, r, n: dl, lt: m[l], rt: m[r], fl: dl > 1 ? l / (dl - 1) : 0, fr: dl > 1 ? r / (dl - 1) : 1 };
  }
  // Strike charts: show the strikes lo..hi (cents): the nearest rows, set with the bar's own onChangeEnd.
  // live: with onChange (during your drag or wheel; QuantData stores the zoom only at onChangeEnd).
  function setStrikes({ k, lo, hi, live }) {
    const root = document.querySelector(`[data-qdts-bar="${k}"]`);
    const f = root && find(root);
    const fn = f && (live ? f.props.onChange : f.props.onChangeEnd);
    if (!f || !f.strikes || typeof fn !== 'function') return { ok: false };
    const s = f.strikes;
    const n = Math.min(s.length, f.props.dataLength);
    const near = (x) => {
      let b = 0;
      for (let i = 1; i < n; i++) if (Math.abs(s[i] - x) < Math.abs(s[b] - x)) b = i;
      return b;
    };
    let l = near(lo);
    let r = near(hi);
    if (r <= l) r = Math.min(n - 1, l + 1);
    if (r <= l) l = Math.max(0, r - 1);
    if (!live && f.im && typeof f.props.onChange === 'function') f.props.onChange([l, r]); // see set()
    fn([l, r]);
    return { ok: true, l, r, lo: s[l], hi: s[r] };
  }
  // The visible strikes of a bar now: liveValueRef changes during a drag before the value prop.
  function liveRange({ k }) {
    const root = document.querySelector(`[data-qdts-bar="${k}"]`);
    const f = root && find(root);
    if (!f || !f.strikes) return { ok: false };
    const p = f.props;
    const n = p.dataLength;
    const lv = p.liveValueRef && Array.isArray(p.liveValueRef.current) ? p.liveValueRef.current : null;
    const v = lv ? [lv[0] ?? 0, lv[1] ?? n - 1] : valueOf(p, n);
    if (!v) return { ok: false };
    const at = (i) => f.strikes[Math.max(0, Math.min(f.strikes.length - 1, i))];
    return { ok: true, sv: [at(v[0]), at(v[1])] };
  }
  // The layout of a chart canvas: a ref of the renderer (a few fibers above the canvas) with plotLeft, plotRight,
  // plotTop, plotBottom (CSS px in the canvas), xMin and xMax (the visible x range: cents for strikes, ms for times).
  // Found by its key names, not by the hook index. The ref box stays the same: keep it per canvas.
  const layoutRefs = new WeakMap();
  const isLayout = (c) => c && typeof c === 'object' && typeof c.plotLeft === 'number' && typeof c.plotRight === 'number' && typeof c.xMin === 'number' && typeof c.xMax === 'number';
  function layoutRef(canvas) {
    const known = layoutRefs.get(canvas);
    if (known && isLayout(known.current)) return known;
    let f = fiberOf(canvas);
    if (f) f = current(f);
    for (let i = 0; f && i < 6; f = f.return, i++) {
      if (typeof f.type === 'string') continue;
      for (let h = f.memoizedState, j = 0; h && typeof h === 'object' && 'next' in h && j < 120; h = h.next, j++) {
        const box = h.memoizedState;
        if (box && typeof box === 'object' && 'current' in box && isLayout(box.current)) {
          layoutRefs.set(canvas, box);
          return box;
        }
      }
    }
    return null;
  }
  // The x values of a chart (sorted): the strikes (sortedStrikes) or the row times (timestamps, also candleSeries.timestamps)
  // in a hook .current of the chart components above the canvas. Found by key names; the ref box is kept per canvas.
  const valueRefs = new WeakMap();
  const pick = (c) => {
    if (!c || typeof c !== 'object') return null;
    if (Array.isArray(c.sortedStrikes) && c.sortedStrikes.length) return c.sortedStrikes;
    if (Array.isArray(c.timestamps) && c.timestamps.length) return c.timestamps;
    if (Array.isArray(c.sortedEpochMillisTimestamps) && c.sortedEpochMillisTimestamps.length) return c.sortedEpochMillisTimestamps;
    if (c.candleSeries && Array.isArray(c.candleSeries.timestamps) && c.candleSeries.timestamps.length) return c.candleSeries.timestamps;
    return null;
  };
  function valuesOf(canvas) {
    const known = valueRefs.get(canvas);
    const a = known && pick(known.current);
    if (a) return a;
    let f = fiberOf(canvas);
    if (f) f = current(f);
    for (let i = 0; f && i < 15; f = f.return, i++) {
      if (typeof f.type === 'string') continue;
      for (let h = f.memoizedState, j = 0; h && typeof h === 'object' && 'next' in h && j < 120; h = h.next, j++) {
        const box = h.memoizedState;
        if (box && typeof box === 'object' && 'current' in box && pick(box.current)) {
          valueRefs.set(canvas, box);
          return pick(box.current);
        }
      }
    }
    return null;
  }
  // The nearest value of a sorted list, inside lo..hi if one is there.
  function nearest(a, v, lo, hi) {
    let l = 0;
    let r = a.length - 1;
    while (r - l > 1) {
      const m = (l + r) >> 1;
      if (a[m] < v) l = m; else r = m;
    }
    let b = Math.abs(a[l] - v) <= Math.abs(a[r] - v) ? l : r;
    if (a[b] < lo && b + 1 < a.length && a[b + 1] <= hi) b++;
    if (a[b] > hi && b > 0 && a[b - 1] >= lo) b--;
    return a[b];
  }
  const chartOf = (k) => document.querySelector(`[data-qdts-chart="${k}"]`);
  const kindOf = (L) => ('visibleStart' in L || 'yDomain' in L ? 'strike' : L.xMin > 1e11 ? 'time' : '');
  // The crosshair line: the value under the mouse (lx, ly: CSS px in the source canvas), snapped like QuantData's own
  // crosshair (to a strike or a row time of the source), and its place in each other chart (x in CSS px of that canvas).
  // A strike chart shows the line at its own nearest strike.
  function xhair({ k, lx, ly, strikePeers, timePeers }) {
    const src = chartOf(k);
    const ref = src && layoutRef(src);
    if (!ref) return { ok: false };
    const L = ref.current;
    const kind = kindOf(L);
    if (!kind || L.plotRight <= L.plotLeft || L.xMax <= L.xMin || lx < L.plotLeft || lx > L.plotRight || ly < L.plotTop || ly > L.plotBottom) return { ok: false };
    let v = L.xMin + ((lx - L.plotLeft) / (L.plotRight - L.plotLeft)) * (L.xMax - L.xMin);
    const vals = valuesOf(src);
    if (vals) v = nearest(vals, v, L.xMin, L.xMax);
    const lines = [];
    for (const pk of kind === 'strike' ? strikePeers : timePeers) {
      const c = chartOf(pk);
      const tr = c && !c.closest('#qd-time-sync-freeze') && layoutRef(c);
      if (!tr) continue;
      const T = tr.current;
      if (kindOf(T) !== kind || T.xMax <= T.xMin) continue;
      let tv = v;
      if (kind === 'strike') {
        const tvals = valuesOf(c);
        if (tvals) tv = nearest(tvals, v, T.xMin, T.xMax);
      }
      if (tv < T.xMin || tv > T.xMax) continue;
      lines.push({ k: pk, v: tv, x: T.plotLeft + ((tv - T.xMin) / (T.xMax - T.xMin)) * (T.plotRight - T.plotLeft), top: T.plotTop, bottom: T.plotBottom });
    }
    return { ok: true, kind, v, lines };
  }
  // The candles of a price chart (Stock Price / Time): candleSeries {opens, highs, lows, closes, timestamps} in a hook
  // .current or a prop of the components above the canvas (REALSITE-1.md section 14). Prices in cents.
  const candleRefs = new WeakMap();
  const candleMiss = new WeakMap(); // canvas -> time of the last search without candles (not a price chart)
  const pickCandles = (c) => {
    if (!c || typeof c !== 'object') return null;
    const s = c.candleSeries && typeof c.candleSeries === 'object' ? c.candleSeries : c;
    return Array.isArray(s.closes) && Array.isArray(s.timestamps) && s.timestamps.length && s.closes.length === s.timestamps.length ? s : null;
  };
  function candlesOf(canvas) {
    const known = candleRefs.get(canvas);
    const a = known && pickCandles(known.get());
    if (a) return a;
    if (performance.now() - (candleMiss.get(canvas) ?? -Infinity) < 5000) return null;
    let f = fiberOf(canvas);
    if (f) f = current(f);
    for (let i = 0; f && i < 15; f = f.return, i++) {
      if (typeof f.type === 'string') continue;
      const props = f.memoizedProps;
      if (pickCandles(props)) {
        const fiber = f;
        candleRefs.set(canvas, { get: () => fiber.memoizedProps });
        return pickCandles(props);
      }
      for (let h = f.memoizedState, j = 0; h && typeof h === 'object' && 'next' in h && j < 120; h = h.next, j++) {
        const box = h.memoizedState;
        if (box && typeof box === 'object' && 'current' in box && pickCandles(box.current)) {
          candleRefs.set(canvas, { get: () => box.current });
          return pickCandles(box.current);
        }
      }
    }
    candleMiss.set(canvas, performance.now());
    return null;
  }
  const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  // Per price chart: its day (ET), the close at 16:00 (the candle that starts at 15:59 or before) and the last close
  // (the official close: the index takes the closing auction prints in the minutes after 16:00).
  function candles() {
    const out = [];
    for (const c of document.querySelectorAll('[data-qdts-chart]')) {
      if (c.closest('#qd-time-sync-freeze')) continue;
      const s = candlesOf(c);
      if (!s) continue;
      const n = s.timestamps.length;
      const day = dayFmt.format(new Date(s.timestamps[n - 1]));
      const cut = etAt(s.timestamps[n - 1], 960);
      let close16 = null;
      for (let i = n - 1; i >= 0; i--) {
        if (s.timestamps[i] < cut) {
          close16 = s.closes[i];
          break;
        }
      }
      out.push({ k: c.getAttribute('data-qdts-chart'), day, close16, last: s.closes[n - 1], n });
    }
    return out;
  }
  // The prior close from Net Drift (no request): its rows (sortedData: epochMillisTimestamp, stockPriceInCents) start at
  // 00:00 ET. Before 09:30 the index does not trade: the last row before 09:30 holds the official close of the day
  // before (seen on the real page, sd2 / sd3: Oct 9 before 09:30 = 7,765.43 = the last value of Oct 8; the 00:00 row
  // can hold another value). Per zoom bar: its day (ET) and that price in cents. ks: only these bars (the time bars).
  function preClose(args) {
    const out = [];
    const ks = args && Array.isArray(args.ks) ? new Set(args.ks.map(String)) : null;
    for (const root of document.querySelectorAll('[data-qdts-bar]')) {
      if (ks && !ks.has(root.getAttribute('data-qdts-bar'))) continue;
      let f = fiberOf(root);
      if (f) f = current(f);
      let rows = null;
      for (let i = 0; f && i < 20 && !rows; f = f.return, i++) {
        if (typeof f.type === 'string') continue;
        for (let h = f.memoizedState, j = 0; h && typeof h === 'object' && 'next' in h && j < 120; h = h.next, j++) {
          const c = h.memoizedState && typeof h.memoizedState === 'object' ? h.memoizedState.current : null;
          const a = c && typeof c === 'object' && Array.isArray(c.sortedData) ? c.sortedData : null;
          if (a && a.length && a[0] && typeof a[0].stockPriceInCents === 'number' && typeof a[0].epochMillisTimestamp === 'number') {
            rows = a;
            break;
          }
        }
      }
      if (!rows) continue;
      // The last row before 09:30 ET (the rows are in time order): a binary search, no etMin per row.
      const cut = etAt(rows[0].epochMillisTimestamp, 570);
      let lo = 0;
      let hi = rows.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (rows[mid].epochMillisTimestamp < cut) lo = mid + 1;
        else hi = mid;
      }
      const pre = lo > 0 ? rows[lo - 1] : null;
      if (pre) out.push({ k: root.getAttribute('data-qdts-bar'), day: dayFmt.format(new Date(pre.epochMillisTimestamp)), cents: pre.stockPriceInCents });
    }
    return out;
  }
  function charts() {
    return [...document.querySelectorAll('[data-qdts-chart]')].filter((c) => !c.closest('#qd-time-sync-freeze')).map((c) => {
      const k = c.getAttribute('data-qdts-chart');
      const ref = layoutRef(c);
      if (!ref) return { k, ok: false };
      const L = ref.current;
      const kind = kindOf(L);
      const out = { k, ok: true, kind, plot: [L.plotLeft, L.plotRight, L.plotTop, L.plotBottom], xMin: L.xMin, xMax: L.xMax };
      // The y range of the Interval Map: strikes (cents).
      if (typeof L.yMin === 'number' && typeof L.yMax === 'number') Object.assign(out, { yMin: L.yMin, yMax: L.yMax });
      return out;
    });
  }
  // The tool of each time slider: the nearest toolId above it (content.js keeps a slider on or off by its tool).
  function sliders() {
    return [...document.querySelectorAll('[data-qdts-slider]')].filter((el) => !el.closest('#qd-time-sync-freeze')).map((el) => {
      let f = fiberOf(el);
      for (let i = 0; f && i < 80; f = f.return, i++) {
        const p = f.memoizedProps;
        if (p && typeof p === 'object' && typeof p.toolId === 'string' && p.toolId) return { k: el.getAttribute('data-qdts-slider'), toolId: p.toolId };
      }
      return { k: el.getAttribute('data-qdts-slider'), toolId: null };
    });
  }
  // A copy in the content-script world sees no React keys on the bars: it must not answer.
  const seesReact = () => [...document.querySelectorAll('[data-qdts-bar], [data-qdts-chart], [data-qdts-slider]')].some((el) => Object.keys(el).some((k) => k.startsWith('__reactFiber$')));
  document.addEventListener('qdts:req', (e) => {
    if (!seesReact()) return;
    let req;
    try {
      req = JSON.parse(e.detail);
    } catch {
      return;
    }
    let result = null;
    try {
      if (req.op === 'bars') result = [...document.querySelectorAll('[data-qdts-bar]')].map(info);
      else if (req.op === 'set') result = set(req.args);
      else if (req.op === 'setStrikes') result = setStrikes(req.args);
      else if (req.op === 'charts') result = charts();
      else if (req.op === 'xhair') result = xhair(req.args);
      else if (req.op === 'liveRange') result = liveRange(req.args);
      else if (req.op === 'candles') result = candles();
      else if (req.op === 'preClose') result = preClose(req.args);
      else if (req.op === 'sliders') result = sliders();
    } catch (err) {
      result = { ok: false, error: String((err && err.message) || err) };
    }
    document.dispatchEvent(new CustomEvent('qdts:res', { detail: JSON.stringify({ id: req.id, result }) }));
  });

})();
/*
 * QD Toolkit (formerly QuantData Time Sync), an unofficial toolkit for QuantData
 * Adds one control panel to QuantData. The panel moves all time sliders on the page together.
 * Uses no browser extension API. The same file runs as a Safari/Chrome content script and as a userscript.
 */
(() => {
  'use strict';
  if (window.__qdTimeSync) return;
  window.__qdTimeSync = true;

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------
  const STORE_KEY = 'qdTimeSync.v1';
  const SELECTOR = '[role="slider"], input[type="range"]';
  const SPEEDS = [
    ['auto', 'Auto'],
    [500, '0.5 s'],
    [1000, '1 s'],
    [2000, '2 s'],
    [3000, '3 s'],
    [4000, '4 s'],
    [5000, '5 s'],
    [10000, '10 s'],
  ];
  const MAX_PRESSES = 1000; // Upper limit of key presses for one jump on a custom slider.
  const SHIFT_STEPS = 5;    // Shift + arrow key moves this number of steps.
  const RENDER_TIMEOUT = 600; // Time (ms) to wait for a slider to show its new value after one key press.
  const CLICK_MIN_STEPS = 4;  // Use a click on the track only for a jump of more than this number of steps.
  const PAGE_MIN_STEPS = 20;  // Try Page Up / Page Down only for a jump of more than this number of steps.

  // QuantData slider values are minutes. The start point depends on the ticker:
  //   SPX (range 0–1440): minutes from 00:00 ET. 570 = 09:30.
  //   SPY, QQQ, stocks (range 0–390 / 0–405): minutes from 09:30 ET. 405 = 16:15.
  // The panel works in ET minutes from midnight. QuantData itself shows your local time.
  const RTH_OPEN = 570;  // 09:30 ET
  const RTH_CLOSE = 960; // 16:00 ET

  const defaults = { x: null, y: null, collapsed: false, speed: 'auto', rth: true, off: [], zoom: {}, zoomMask: true, freeze: true, link: {}, xhair: true,
    sd: { on: true, vix: null, close: {}, levels: [1, 2], info: false, charts: {} }, localTime: false };
  let cfg = loadCfg();
  delete cfg.zoomRange; // Own zoom ranges (version 1.10) are not used any more.
  delete cfg.moveBudget; // The rate-limit budget (versions 1.8–1.11) is not used any more.
  delete cfg.budget;
  delete cfg.arrows; // Since 1.14 the arrow keys always move all sliders (no option).
  delete cfg.zoomSafe; // Since 1.13 the right end of a zoom bar is at the synced minute (no option).
  if (!cfg.maskOnV12) {
    cfg.zoomMask = true; // "Cover the preview" is on by default since version 1.12.
    cfg.maskOnV12 = true;
    saveCfg();
  }
  if (!SPEEDS.some(([v]) => v === cfg.speed)) cfg.speed = 'auto';

  function loadCfg() {
    try {
      return { ...defaults, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') };
    } catch {
      return { ...defaults };
    }
  }
  function saveCfg() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(cfg));
    } catch { /* Storage is not available. The panel works without it. */ }
  }

  // ---------------------------------------------------------------------------
  // Find the sliders
  // ---------------------------------------------------------------------------
  let autoList = [];   // Sliders found with SELECTOR, in page order.
  const learnedStep = new WeakMap(); // Custom slider -> value change of 1 arrow key press.

  function scan() {
    const all = [...document.querySelectorAll(SELECTOR)].filter((el) => !el.closest('#qd-time-sync-freeze')); // not in a freeze copy
    // A custom slider that contains a range input is the same control. Keep only the input.
    autoList = all.filter(
      (el) => !(el.matches('[role="slider"]') && !(el instanceof HTMLInputElement) && el.querySelector('input[type="range"]'))
    );
    keySliders();
    takeOldOff();
  }

  // A slider on the screen. A tool in a hidden tab stays in the page with a 0 x 0 box (flexlayout; REALSITE-1.md section
  // 17): the panel does not list and does not move it (no requests for a chart that you cannot see). When its tab
  // shows again, its slider goes to the time of the others once (refresh).
  const shownEl = (el) => el.getClientRects().length > 0; // display: none (also of a parent) gives no box at all
  const hiddenSliders = new WeakSet();

  // A slider that you switch off stays off by its tool, also when other tools come or go (Julian, 2026-10-11; before,
  // cfg.disabled held places in the list, so then another slider was off). The key: "tool:<toolId>|<n>" (the n-th
  // slider of the tool; the tool id from the page data), else "<page>|<tool name>|<n>". cfg.off = the keys that are off.
  const sliderKeys = new WeakMap(); // slider -> key
  let sliderSeq = 0;
  let keysSure = false;             // the page data gave the tools
  let keysAt = -Infinity;
  function keySliders() {
    const all = autoList.every((el) => sliderKeys.has(el));
    if (all && (keysSure || performance.now() - keysAt < 2000)) return; // without the page data: ask again every 2 s
    keysAt = performance.now();
    for (const el of autoList) if (!el.hasAttribute('data-qdts-slider')) el.setAttribute('data-qdts-slider', String(++sliderSeq));
    const ans = autoList.length ? bridge('sliders') : null;
    keysSure = Array.isArray(ans);
    const ids = new Map(keysSure ? ans.map((a) => [a.k, a.toolId]) : []);
    const count = new Map();
    for (const el of autoList) {
      const id = ids.get(el.getAttribute('data-qdts-slider'));
      const base = id ? `tool:${id}` : `${location.pathname}|${sliderName(el)}`;
      const n = count.get(base) || 0;
      count.set(base, n + 1);
      sliderKeys.set(el, `${base}|${n}`);
    }
  }
  // Up to 0.17: cfg.disabled (places in the list). Taken over once, when the page data answered and the list is long
  // enough (max 20 s after the load).
  function takeOldOff() {
    const old = cfg.disabled;
    if (!Array.isArray(old)) return;
    const ready = keysSure && autoList.length > Math.max(-1, ...old);
    if (old.length && !ready && performance.now() < 20000) return;
    cfg.off = [...new Set([...cfg.off, ...old.map((i) => autoList[i] && sliderKeys.get(autoList[i])).filter(Boolean)])];
    delete cfg.disabled;
    saveCfg();
  }
  const isOff = (el, i) => cfg.off.includes(sliderKeys.get(el)) || (Array.isArray(cfg.disabled) && cfg.disabled.includes(i));
  function setOff(el, off) {
    const k = sliderKeys.get(el);
    if (!k) return;
    cfg.off = off ? [...cfg.off.filter((x) => x !== k), k].slice(-200) : cfg.off.filter((x) => x !== k);
    saveCfg();
  }
  function activeSliders() {
    return autoList.filter((el, i) => !isOff(el, i) && shownEl(el));
  }

  function num(v) {
    if (v === null || v === undefined || v === '') return NaN;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }

  function read(el) {
    const text = el.getAttribute('aria-valuetext') || '';
    if (el instanceof HTMLInputElement) {
      const min = num(el.min);
      const max = num(el.max);
      const step = num(el.step);
      return {
        value: num(el.value),
        min: isNaN(min) ? 0 : min,
        max: isNaN(max) ? 100 : max,
        step: isNaN(step) || step <= 0 ? 1 : step,
        text,
      };
    }
    return {
      value: num(el.getAttribute('aria-valuenow')),
      min: num(el.getAttribute('aria-valuemin')),
      max: num(el.getAttribute('aria-valuemax')),
      step: learnedStep.get(el) ?? NaN,
      text,
    };
  }

  function refSlider() {
    return activeSliders().find((el) => !isNaN(read(el).value)) || null;
  }

  // ET time (minutes from midnight) at slider value 0. NaN = this slider does not show a time.
  // Current time in ET, in minutes from midnight.
  const etClock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  function nowEt() {
    const parts = etClock.formatToParts(new Date());
    const get = (t) => Number(parts.find((p) => p.type === t).value);
    return (get('hour') % 24) * 60 + get('minute');
  }
  const LIVE_TOLERANCE = 20; // Minutes. The end of a live slider can be some minutes behind the clock.

  function timeBase(r) {
    if (r.text || isNaN(r.min) || isNaN(r.max) || r.min < 0) return NaN;
    // A complete day has a fixed range.
    if (r.max === 1440 || r.max === 1439) return 0;      // SPX: full day from 00:00 ET
    if (r.max === 390 || r.max === 405) return RTH_OPEN; // SPY, QQQ, stocks: from 09:30 ET
    // A live day ends at the current time. Compare the end of the slider with the clock.
    const now = nowEt();
    if (Math.abs(r.max - now) <= LIVE_TOLERANCE) return 0;
    if (now >= RTH_OPEN && Math.abs(r.max - (now - RTH_OPEN)) <= LIVE_TOLERANCE) return RTH_OPEN;
    return NaN;
  }
  const isTime = (r) => !isNaN(timeBase(r));
  const etOf = (r) => timeBase(r) + r.value;

  // A live slider ends at the current time (not at the end of a full day).
  const FULL_ENDS = [1439, 1440, 390, 405];
  const isLive = (r) => isTime(r) && !FULL_ENDS.includes(r.max);
  // On a live day, no slider may go after the latest data. Some QuantData sliders allow
  // the full session also on a live day, so the live sliders set the limit for all sliders.
  function liveEnd() {
    let end = null;
    for (const el of activeSliders()) {
      const r = read(el);
      if (isLive(r)) end = Math.max(end === null ? -Infinity : end, timeBase(r) + r.max);
    }
    return end;
  }
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m) % 60).padStart(2, '0')}`;
  // The time in the panel: ET, or the time of this computer (option "Show the time in your time zone", Julian,
  // 2026-10-11). Inside, everything stays in ET minutes (the sync is by ET time). The difference to ET depends on the
  // day (summer time starts on other days in Europe and in the US): the day of the replay (the date chip of the tool
  // of slider 1, read every 10 s), else today.
  let tzDay = '';
  let tzDayAt = -Infinity;
  function localShift() {
    if (performance.now() - tzDayAt > 10000) {
      tzDayAt = performance.now();
      const ref = refSlider();
      tzDay = (ref && toolDay(toolOf(ref))) || etDay.format(new Date());
    }
    const [y, mo, d] = tzDay.split('-').map(Number);
    const at = new Date(Date.UTC(y, mo - 1, d, 17)); // 12:00 or 13:00 ET of that day
    const p = etClock.formatToParts(at);
    const etWall = (Number(p.find((x) => x.type === 'hour').value) % 24) * 60 + Number(p.find((x) => x.type === 'minute').value);
    return -at.getTimezoneOffset() - (etWall - 17 * 60); // local offset - ET offset, in minutes
  }
  const wrap = (m) => ((m % 1440) + 1440) % 1440;
  // An ET time for the panel: "10:00 ET", or "16:00" in your time zone (like the QuantData axes, without a suffix).
  const clock = (m) => (cfg.localTime ? hhmm(wrap(m + localShift())) : `${hhmm(m)} ET`);
  // A typed time to ET minutes. With the option, the time is in your time zone, except with "ET" after it.
  function parseClock(text) {
    const m = parseTime(text);
    if (isNaN(m) || !cfg.localTime || /et\s*$/i.test(String(text).trim())) return m;
    return wrap(m - localShift());
  }
  function dayMode() {
    const ref = refSlider();
    return !!ref && isTime(read(ref));
  }
  const rthOn = () => !!cfg.rth && dayMode();

  // Range (in slider values) for start, end, master slider and play: RTH, or the full slider.
  function playRange(r) {
    const b = timeBase(r);
    if (isNaN(b)) return { lo: r.min, hi: r.max };
    const le = liveEnd();
    const cap = le === null ? r.max : Math.min(r.max, le - b);
    if (cfg.rth) return { lo: Math.max(r.min, Math.min(RTH_OPEN - b, cap)), hi: Math.min(cap, RTH_CLOSE - b) };
    return { lo: r.min, hi: cap };
  }

  // A "set" job carries the ET time, so an SPX slider and an SPY slider go to the same time.
  // A slider that shows no time uses the raw value v.
  function jobFromRef(r, v) {
    return isTime(r) ? { et: timeBase(r) + v, v } : { v };
  }
  function targetFor(el, job, cap = null) {
    if (job.et === undefined) return job.v;
    const r = read(el);
    const b = timeBase(r);
    if (isNaN(b)) return job.v === undefined ? NaN : job.v;
    const et = cap === null ? job.et : Math.min(job.et, cap);
    return Math.max(r.min, Math.min(r.max, et - b));
  }

  // "9:30", "0930", "930", "9.30", "10", "1:30 pm" -> minutes from midnight.
  function parseTime(text) {
    const m = String(text).trim().toLowerCase().match(/^(\d{1,2})(?:[:.h]?(\d{2}))?\s*(am|pm)?(?:\s*et)?$/);
    if (!m) return NaN;
    let h = Number(m[1]);
    const mi = Number(m[2] || 0);
    if (m[3] === 'pm' && h < 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    if (h > 24 || mi > 59) return NaN;
    return h * 60 + mi;
  }

  // ---------------------------------------------------------------------------
  // Move one slider
  // ---------------------------------------------------------------------------
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  const KEY_CODES = { ArrowRight: 39, ArrowLeft: 37, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
  const pageStep = new WeakMap();  // Custom slider -> value change of 1 Page Up press. 0 = the slider ignores Page Up.
  const clickWorks = new WeakMap(); // Custom slider -> false if a click on its track does not move it.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isTyping(t) {
    if (!t || t.nodeType !== 1) return false;
    if (t.isContentEditable) return true;
    if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
    if (t.tagName === 'INPUT') return !['range', 'checkbox', 'radio', 'button', 'submit', 'reset'].includes(t.type);
    return false;
  }

  // Native range input: set the value with the prototype setter (React then sees the change), then send input and change.
  function setInput(el, v) {
    valueSetter.call(el, String(v)); // The browser keeps the value between min and max.
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Custom slider: give it focus, then send the key to it.
  // Do not take the focus from a text field. Else the typed text goes to the slider.
  function pressKey(el, key) {
    const code = KEY_CODES[key];
    const init = { key, code: key, keyCode: code, which: code, bubbles: true, cancelable: true, composed: true };
    if (document.activeElement !== el && !isTyping(document.activeElement) && typeof el.focus === 'function') {
      el.focus({ preventScroll: true });
    }
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  // React renders a key press later, not at once. A second press before the render
  // starts from the old value again, and 5 fast presses move the slider only 1 step.
  // Thus: 1 press, then wait until the slider shows the new value.
  async function waitForChange(el, before, timeout = RENDER_TIMEOUT) {
    if (isNaN(before)) {
      await sleep(40); // The slider shows no value. Wait a short fixed time.
      return true;
    }
    if (read(el).value !== before) return true; // The slider showed the value at once.
    const t0 = performance.now();
    while (performance.now() - t0 < timeout) {
      await sleep(0);
      if (read(el).value !== before) return true;
    }
    return false;
  }

  function atBound(r, dir) {
    if (isNaN(r.value)) return false;
    if (dir < 0 && !isNaN(r.min) && r.value <= r.min) return true;
    if (dir > 0 && !isNaN(r.max) && r.value >= r.max) return true;
    return false;
  }

  async function stepSlider(el, dir) {
    const r = read(el);
    if (atBound(r, dir)) return;
    if (dir > 0 && isTime(r)) {
      const le = liveEnd();
      if (le !== null && etOf(r) >= le) return; // Live day: no step after the latest data.
    }
    if (el instanceof HTMLInputElement) {
      setInput(el, r.value + dir * r.step);
      return;
    }
    pressKey(el, dir > 0 ? 'ArrowRight' : 'ArrowLeft');
    if (await waitForChange(el, r.value)) {
      const after = read(el).value;
      if (!learnedStep.has(el) && !isNaN(after) && !isNaN(r.value) && after !== r.value) learnedStep.set(el, Math.abs(after - r.value));
    }
  }

  async function edgeSlider(el, which) {
    const r = read(el);
    if (el instanceof HTMLInputElement) {
      setInput(el, which === 'start' ? r.min : r.max);
      return;
    }
    pressKey(el, which === 'start' ? 'Home' : 'End');
    await waitForChange(el, r.value);
  }

  // The track is the first wide parent of the thumb. Its width maps to the range min–max.
  function findTrack(el) {
    const own = el.getBoundingClientRect();
    let n = el.parentElement;
    for (let i = 0; n && n !== document.body && i < 6; i++, n = n.parentElement) {
      const r = n.getBoundingClientRect();
      if (r.width >= Math.max(80, own.width * 4) && r.height > 0 && r.height <= 80) return n;
    }
    return null;
  }

  function mouse(type, target, x, y, buttons) {
    const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons, view: window };
    if (type.startsWith('pointer') && typeof PointerEvent === 'function') {
      target.dispatchEvent(new PointerEvent(type, { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    } else {
      target.dispatchEvent(new MouseEvent(type, init));
    }
  }

  // Jump with 1 click on the track at the target position. The events go to the track only,
  // never to an element under the point, so no other control on the page gets a click.
  async function clickTrack(el, target) {
    const r = read(el);
    const track = findTrack(el);
    if (!track || isNaN(r.min) || isNaN(r.max) || r.max <= r.min) return false;
    const tr = track.getBoundingClientRect();
    const x = tr.left + ((target - r.min) / (r.max - r.min)) * tr.width;
    const y = tr.top + tr.height / 2;
    try {
      mouse('pointerdown', track, x, y, 1);
      mouse('mousedown', track, x, y, 1);
      mouse('pointerup', track, x, y, 0);
      mouse('mouseup', track, x, y, 0);
    } catch { /* The slider rejected the synthetic pointer. */ }
    return waitForChange(el, r.value);
  }

  async function pressAndWait(el, key) {
    const before = read(el).value;
    pressKey(el, key);
    return (await waitForChange(el, before)) ? read(el).value - before : 0;
  }

  // Order: 1 click on the track, then Page Up / Page Down (mostly 10 steps), then arrow keys for the last steps.
  // Each method that does not work on this slider is not used again.
  async function driveTo(el, target) {
    if (el instanceof HTMLInputElement) {
      setInput(el, target);
      return;
    }
    let r = read(el);
    if (isNaN(r.value) || isNaN(target)) return;
    const unit = () => learnedStep.get(el) || 1;

    if (Math.abs(target - r.value) > CLICK_MIN_STEPS * unit() && clickWorks.get(el) !== false) {
      clickWorks.set(el, await clickTrack(el, target));
      r = read(el);
    }

    // Without a click: go to the start or the end first if that is nearer to the target.
    if (clickWorks.get(el) === false && Math.abs(target - r.value) > PAGE_MIN_STEPS * unit()) {
      if (target < r.value && !isNaN(r.min) && target - r.min < r.value - target) {
        pressKey(el, 'Home');
        await waitForChange(el, r.value);
      } else if (target > r.value && !isNaN(r.max) && r.max - target < target - r.value) {
        pressKey(el, 'End');
        await waitForChange(el, r.value);
      }
    }

    for (let i = 0; i < 300; i++) {
      const diff = target - read(el).value;
      const ps = pageStep.get(el);
      if (ps === 0) break;
      if (ps === undefined ? Math.abs(diff) < PAGE_MIN_STEPS * unit() : Math.abs(diff) < ps) break;
      const moved = await pressAndWait(el, diff > 0 ? 'PageUp' : 'PageDown');
      if (ps === undefined) pageStep.set(el, Math.abs(moved));
      if (!moved) break;
    }

    let v = read(el).value;
    for (let i = 0; i < MAX_PRESSES; i++) {
      const step = learnedStep.get(el);
      const diff = target - v;
      if (diff === 0 || (step && Math.abs(diff) < step / 2)) return;
      const dir = Math.sign(diff);
      pressKey(el, dir > 0 ? 'ArrowRight' : 'ArrowLeft');
      if (!(await waitForChange(el, v))) return; // The slider does not move. Stop.
      const v2 = read(el).value;
      if (!learnedStep.has(el)) learnedStep.set(el, Math.abs(v2 - v));
      if (Math.sign(target - v2) === -dir) {
        // The slider went past the target. Go back 1 step if the old value was nearer.
        if (Math.abs(target - v) < Math.abs(target - v2)) {
          pressKey(el, dir > 0 ? 'ArrowLeft' : 'ArrowRight');
          await waitForChange(el, v2);
        }
        return;
      }
      v = v2;
    }
  }

  // ---------------------------------------------------------------------------
  // Action queue: one action at a time, for all sliders together
  // ---------------------------------------------------------------------------
  let pendingSteps = 0;   // Steps that wait (+ forward, - back). A held arrow key adds steps here.
  let pendingJob = null;  // { t: 'set', et?, v? } or { t: 'edge', which }. A new job replaces an old job.
  let working = false;
  const idleWaiters = [];

  const MAX_WAITING = 10; // max. steps that wait in the queue (for example while a jump runs)
  function queueSteps(n) {
    pendingSteps = Math.max(-MAX_WAITING, Math.min(MAX_WAITING, pendingSteps + n));
    kick();
  }
  function queueJob(job) {
    pendingSteps = 0;
    pendingJob = job;
    kick();
  }
  function whenIdle() {
    return working || pendingSteps || pendingJob ? new Promise((r) => idleWaiters.push(r)) : Promise.resolve();
  }

  async function kick() {
    if (working) return;
    working = true;
    const prevFocus = document.activeElement;
    try {
      while (pendingJob || pendingSteps) {
        try {
          if (pendingJob) {
            const job = pendingJob;
            pendingJob = null;
            const els = activeSliders();
            const cap = liveEnd();
            freezeTools((el) => willMove(el, job, cap)); // Keep the old charts visible until the new data is drawn.
            await Promise.all(els.map((el) => (job.t === 'set' ? driveTo(el, targetFor(el, job, cap)) : edgeSlider(el, job.which))));
          } else {
            const dir = Math.sign(pendingSteps);
            pendingSteps -= dir;
            freezeTools((el) => willStep(el, dir));
            await Promise.all(activeSliders().map((el) => stepSlider(el, dir)));
            await sleep(0);
          }
        } catch (err) {
          console.warn('[QD Toolkit]', err);
        }
        refresh();
      }
    } finally {
      // Keep the focus where the user had it. A focus ring on the last slider only confuses.
      if (document.activeElement !== prevFocus) {
        if (prevFocus && prevFocus !== document.body && prevFocus.isConnected && typeof prevFocus.focus === 'function') {
          prevFocus.focus({ preventScroll: true });
        } else if (document.activeElement && typeof document.activeElement.blur === 'function') {
          document.activeElement.blur();
        }
      }
      working = false;
      refresh();
      idleWaiters.splice(0).forEach((r) => r());
    }
  }

  // ---------------------------------------------------------------------------
  // Sync between QuantData tabs and windows
  // ---------------------------------------------------------------------------
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('qd-time-sync') : null;
  // Each message carries the page path. A tab with the same page has the same tools: QuantData itself
  // moves their sliders in all sessions (over its WebSocket). A second step from here would move them twice.
  const send = (msg) => channel && channel.postMessage({ ...msg, path: location.pathname });
  if (channel) {
    channel.onmessage = ({ data }) => {
      if (!data) return;
      const samePage = data.path === location.pathname;
      if (data.t === 'step') {
        if (!samePage) queueSteps(data.n);
      } else if (data.t === 'set' || data.t === 'edge') {
        // RTH jump in the other tab: the left ends go to 09:30 here too. On the same page, QuantData moves the
        // sliders later (over its server): wait for that time change, else the zoom moves twice.
        if (data.rth && !samePage) zoomLeftReset = true;
        if (data.rth && samePage) {
          const ref = refSlider();
          zoomResetWait = { at: performance.now(), et: ref && isTime(read(ref)) ? etOf(read(ref)) : null };
        }
        if (!samePage) queueJob(data);
      }
    };
  }

  const act = {
    step(n) { queueSteps(n); send({ t: 'step', n }); },
    set(target) { queueJob({ t: 'set', ...target }); send({ t: 'set', ...target }); },
    edge(which) {
      const le = liveEnd();
      if (rthOn()) {
        zoomLeftReset = true; // The RTH jump sets the left end of each zoom bar to 09:30.
        return act.set({ et: which === 'start' ? RTH_OPEN : Math.min(RTH_CLOSE, le === null ? Infinity : le), rth: true });
      }
      if (which === 'end' && le !== null) return act.set({ et: le });
      queueJob({ t: 'edge', which });
      send({ t: 'edge', which });
    },
    align() {
      const ref = refSlider();
      if (ref) queueJob({ t: 'set', ...jobFromRef(read(ref), read(ref).value) }); // Only this tab.
    },
  };

  // ---------------------------------------------------------------------------
  // Play
  // ---------------------------------------------------------------------------
  // "Auto" speed: after a step, wait until the data requests of the page stop.
  // The browser reports a request when it is complete (Resource Timing).
  function watchData() {
    const t0 = performance.now();
    let seen = false;
    let last = t0;
    let obs = null;
    try {
      obs = new PerformanceObserver((list) => {
        if (list.getEntries().some((e) => e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest')) {
          seen = true;
          last = performance.now();
        }
      });
      obs.observe({ type: 'resource' });
    } catch {
      obs = null; // No observer. wait() uses a fixed time.
    }
    return {
      // firstMax: time to wait for the first request. quiet: time without new requests. settle: time to draw the chart.
      wait({ firstMax = 4000, quiet = 500, max = 15000, settle = 300 } = {}) {
        return new Promise((resolve) => {
          const done = () => {
            if (obs) obs.disconnect();
            setTimeout(resolve, settle);
          };
          const tick = () => {
            const now = performance.now();
            if (!obs) return now - t0 >= 1500 ? done() : setTimeout(tick, 100);
            if (now - t0 >= max) return done();
            if (!seen && now - t0 >= firstMax) return done();
            if (seen && now - last >= quiet) return done();
            setTimeout(tick, 100);
          };
          setTimeout(tick, 100);
        });
      },
      stop() {
        if (obs) obs.disconnect();
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Rate limit: QuantData blocks too many requests in a short time
  // ("You're making requests too quickly"). The panel reacts only to this message:
  // Play pauses for 20 s and then runs at half speed (each new message halves it again, max 1/4).
  // Your own steps (keys, buttons, time field, master slider) always run.
  // ---------------------------------------------------------------------------
  const RATE_BACKOFF = 20000;
  const MAX_SLOW = 4;
  let slowFactor = 1;   // 1 = full speed, 2 = half speed, 4 = quarter speed
  let backoffUntil = 0; // performance.now() time: Play does not step before this time
  let lastLimitAt = -Infinity; // Not 0: a message in the first 5 s after the page load counts too.
  function onRateLimit() {
    const now = performance.now();
    if (now - lastLimitAt < 5000) return; // QuantData often shows the message several times at once.
    lastLimitAt = now;
    backoffUntil = now + RATE_BACKOFF;
    if (playing) slowFactor = Math.min(MAX_SLOW, slowFactor * 2);
    // QuantData's bucket is empty now (other tabs or devices can use it too). All tabs pause.
    const b = budgetState();
    b.level = 0;
    b.pauseUntil = Date.now() + RATE_BACKOFF;
    budgetSave(b);
    refresh();
  }
  // QuantData shows the rate-limit message as a toast. Our own panel is in a shadow root and is not seen here.
  const RATE_TEXT = /requests too quickly|too many requests/i;
  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 3 ? RATE_TEXT.test(n.data) : n.nodeType === 1 && n.childElementCount < 20 && RATE_TEXT.test(n.textContent || '')) {
          onRateLimit();
          return;
        }
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // ---------------------------------------------------------------------------
  // Request budget for Play (measured on the real site, see REALSITE-1.md): QuantData allows about
  // 120 requests at once, then 2 per second (a token bucket per account). A step costs 2 requests
  // (PUT + GET) for each tool with a time slider. Before each step, Play waits until the step fits and
  // BUDGET_RESERVE requests stay free for your own clicks. Your own steps never wait: they use the budget,
  // and Play waits longer after them.
  // All QuantData tabs of this browser share 1 estimate in localStorage: the requests of every tab count
  // (also the page load after a reload, and the steps that the tab sync sends to other tabs).
  // Other devices are not seen: the reserve and the pause after the QuantData message cover them.
  // ---------------------------------------------------------------------------
  const BUDGET_CAP = 120;
  const BUDGET_RATE = 2; // requests per second
  const BUDGET_RESERVE = 20;
  const BUDGET_KEY = 'qdTimeSync.budget'; // { level, at, pauseUntil } with Date.now() times
  let budgetMem = { level: BUDGET_CAP, at: Date.now(), pauseUntil: 0 }; // used when localStorage does not work
  let budgetWaitUntil = 0; // performance.now() time: Play waits for the budget until then
  let budgetWaitFrom = 0;  // the start of this wait (for the ring on the Play button)
  let pending = 0;   // requests of the last Play step that are not counted yet (still on the way)
  let pendingAt = 0;
  function budgetState() {
    let b = budgetMem;
    try {
      const v = JSON.parse(localStorage.getItem(BUDGET_KEY) || 'null');
      if (v && typeof v.level === 'number' && typeof v.at === 'number') b = v;
    } catch { /* Use the copy in memory. */ }
    const now = Date.now();
    b.level = Math.min(BUDGET_CAP, b.level + (Math.max(0, now - b.at) / 1000) * BUDGET_RATE);
    b.at = now;
    b.pauseUntil = b.pauseUntil || 0;
    return b;
  }
  function budgetSave(b) {
    budgetMem = b;
    try {
      localStorage.setItem(BUDGET_KEY, JSON.stringify(b));
    } catch { /* The copy in memory is enough for this tab. */ }
  }
  function budgetUse(n) {
    const b = budgetState();
    b.level -= n; // Can go below 0: then Play waits longer.
    budgetSave(b);
  }
  // Free requests now: the shared estimate minus the requests of the last step that are still on the way.
  function budgetNow() {
    if (performance.now() - pendingAt > 3000) pending = 0;
    return budgetState().level - pending;
  }
  const isApi = (name) => {
    try {
      const u = new URL(name);
      return /(^|\.)quantdata\.us$/.test(u.hostname) && u.pathname.startsWith('/api/');
    } catch {
      return false;
    }
  };
  try {
    // buffered: also the requests of the page load before this script started.
    new PerformanceObserver((list) => {
      let n = 0;
      for (const e of list.getEntries()) if ((e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest') && isApi(e.name)) n++;
      if (!n) return;
      pending = Math.max(0, pending - n);
      budgetUse(n);
    }).observe({ type: 'resource', buffered: true });
  } catch { /* No observer: Play uses only the speed setting and the reaction to the message. */ }
  // Cost of 1 step: 2 requests for each tool with an active time slider.
  function stepCost() {
    const tools = new Set();
    for (const el of activeSliders()) if (isTime(read(el))) tools.add(toolOf(el) || el);
    return 2 * tools.size;
  }
  // Time (ms) until a step of this cost fits and the reserve stays free.
  const budgetWait = (cost) => Math.max(0, ((cost + BUDGET_RESERVE - budgetNow()) / BUDGET_RATE) * 1000);
  // Time (ms) left of the pause after a rate-limit message, in this tab or in another tab.
  const pauseLeft = () => Math.max(backoffUntil - performance.now(), budgetState().pauseUntil - Date.now(), 0);


  let playing = false;
  let playToken = 0;
  // Before each Play move: wait for the pause after a rate-limit message and for the budget, in 1 loop.
  // Then reserve the cost of the move. False: Play stopped meanwhile.
  async function playWait(token, cost) {
    for (;;) {
      if (!playing || token !== playToken) return false;
      const pause = pauseLeft();
      const budget = budgetWait(cost);
      if (pause <= 0 && budget <= 0) break;
      const until = pause > 0 ? 0 : performance.now() + budget;
      if (until && !budgetWaitUntil) budgetWaitFrom = performance.now();
      budgetWaitUntil = until;
      refresh();
      await sleep(Math.min(Math.max(pause, budget), 500));
    }
    budgetWaitUntil = 0;
    pending = cost;
    pendingAt = performance.now();
    return true;
  }
  const atPlayEnd = () => {
    const ref = refSlider();
    if (!ref) return false;
    const r = read(ref);
    const { hi } = playRange(r);
    return !isNaN(hi) && r.value >= hi;
  };
  async function play() {
    if (playing || !activeSliders().length) return;
    playing = true;
    const token = ++playToken;
    render();
    // RTH: outside 09:30–16:00, start at the open. This jump waits like a step.
    const first = refSlider();
    if (first && rthOn()) {
      const et = etOf(read(first));
      if (et < RTH_OPEN || et >= RTH_CLOSE) {
        if (!(await playWait(token, stepCost()))) return;
        act.set({ et: RTH_OPEN });
        await whenIdle();
      }
    }
    while (playing && token === playToken) {
      if (atPlayEnd()) break;
      if (!(await playWait(token, stepCost()))) return;
      if (atPlayEnd()) break; // You can push End or step while Play waits.
      const t0 = performance.now();
      const watch = cfg.speed === 'auto' ? watchData() : null;
      act.step(1);
      await whenIdle();
      if (token !== playToken) {
        if (watch) watch.stop();
        return;
      }
      if (watch) await watch.wait();
      else await sleep(cfg.speed);
      // Half speed (or slower) after a rate-limit message: wait the step time again.
      if (slowFactor > 1 && playing && token === playToken) await sleep((performance.now() - t0) * (slowFactor - 1));
    }
    if (token === playToken) {
      playing = false;
      render();
    }
  }
  function stop() {
    playing = false;
    playToken++;
    render();
  }
  const togglePlay = () => (playing ? stop() : play());

  // ---------------------------------------------------------------------------
  // Panel (Shadow DOM, so the page CSS does not change it)
  // ---------------------------------------------------------------------------
  // Outline icons (24 px grid, stroke 2), like the Tabler icons of the QuantData header.
  const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const icon = {
    start: svg('<path d="M5.5 5v14"/><path d="M19 5.5v13L9.5 12z"/>'),
    back: svg('<path d="M15 6l-6 6 6 6"/>'),
    fwd: svg('<path d="M9 6l6 6-6 6"/>'),
    end: svg('<path d="M18.5 5v14"/><path d="M5 5.5v13L14.5 12z"/>'),
    play: svg('<path d="M7.5 4.5v15L19.5 12z"/>'),
    pause: svg('<path d="M6.5 5H10v14H6.5zM14 5h3.5v14H14z"/>'),
    sliders: svg('<path d="M4 6h8M16 6h4M4 12h2M10 12h10M4 18h11M19 18h1"/><circle cx="14" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>'),
    clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>'),
    min: svg('<path d="M5 12h14"/>'),
  };

  const host = document.createElement('div');
  host.id = 'qd-time-sync';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  .panel {
    --bg: rgba(17, 19, 24, 0.94);
    --line: rgba(255, 255, 255, 0.09);
    --fg: #e8eaef;
    --muted: #8b93a3;
    --hover: rgba(255, 255, 255, 0.08);
    --accent: #f5a524;
    --warn: #ff6b5e;
    position: fixed;
    left: 50%;
    bottom: 14px;
    transform: translateX(-50%);
    z-index: 2147483647;
    font: 12px/1.25 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif;
    color: var(--fg);
    -webkit-font-smoothing: antialiased;
  }
  .bar, .pill {
    display: flex; align-items: center; gap: 2px;
    padding: 5px 6px;
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 10px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
    -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  }
  .pill { gap: 6px; padding: 6px 10px; cursor: pointer; color: #c7ccd6; font-variant-numeric: tabular-nums; }
  .pill:hover { color: #fff; }
  .pill svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; color: var(--accent); }
  button {
    all: unset; box-sizing: border-box;
    height: 26px; min-width: 26px; padding: 0 6px;
    display: inline-flex; align-items: center; justify-content: center; gap: 5px;
    border-radius: 6px; color: #c7ccd6; cursor: pointer;
    font: inherit; font-variant-numeric: tabular-nums;
  }
  button:hover { background: var(--hover); color: #fff; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  button svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex: none; }
  .play { background: var(--accent); color: #17130a; margin: 0 2px; }
  .play:hover { background: #ffb941; color: #000; }
  .play.on { background: #3a3f4b; color: var(--accent); }
  .grip { width: 14px; height: 26px; cursor: grab; display: grid; place-items: center; color: #555c6a; }
  .grip:active { cursor: grabbing; }
  .grip::before { content: ""; width: 4px; height: 14px; background: radial-gradient(circle, currentColor 1.2px, transparent 1.4px) 0 0 / 4px 4.6px; }
  .sep { width: 1px; height: 18px; background: var(--line); margin: 0 4px; }
  .master { width: 240px; margin: 0 6px; accent-color: var(--accent); cursor: pointer; }
  .master:disabled { opacity: 0.35; cursor: default; }
  .time {
    all: unset; box-sizing: border-box; width: 84px; height: 26px; padding: 0 4px; border-radius: 6px;
    color: var(--fg); font: inherit; font-weight: 600; font-variant-numeric: tabular-nums; text-align: center;
    cursor: text;
  }
  .time:hover { background: var(--hover); }
  .time:focus { background: rgba(255, 255, 255, 0.12); box-shadow: inset 0 0 0 2px var(--accent); }
  .time.busy { color: var(--accent); }
  .time.bad { box-shadow: inset 0 0 0 2px var(--warn); }
  .rth { font-weight: 600; color: var(--muted); }
  .rth.on { color: var(--accent); background: rgba(245, 165, 36, 0.12); box-shadow: inset 0 0 0 1px var(--accent); }
  select {
    -webkit-appearance: none; appearance: none; margin: 0; border: 0; outline: 0; background: transparent;
    height: 26px; padding: 0 6px; border-radius: 6px;
    color: #c7ccd6; cursor: pointer; font: inherit; font-variant-numeric: tabular-nums;
  }
  select:hover { background: var(--hover); color: #fff; }
  select:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  option { color: initial; background: initial; }
  .align { color: var(--accent); font-weight: 600; }
  .slow { color: var(--warn); font-weight: 600; }
  .rate { color: var(--warn); font-weight: 600; padding: 0 4px; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .pace { color: var(--muted); padding: 0 4px; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .mask {
    position: fixed; display: none; pointer-events: none; z-index: 160; box-sizing: border-box; /* below QuantData's menus, above the freeze copies */
    border-left: 2px solid #f5a524;
    background: repeating-linear-gradient(135deg, rgba(14, 16, 20, 0.97) 0 6px, rgba(36, 40, 48, 0.97) 6px 9px);
  }
  /* The crosshair line in the other charts (0.16), like QuantData's own crosshair (measured at scale 1): 1 px wide,
     dashes 4 px on / 4 px off from the plot top, the full primary color, on a whole pixel column. --s = the scale of
     the target chart (Infinite Page): the width, the dashes and the label scale with it. */
  .xline { position: fixed; display: none; pointer-events: none; z-index: 160; --s: 1;
    background: repeating-linear-gradient(to bottom, var(--qd-themeColor-primary, hsl(201, 99%, 50%)) 0 calc(4px * var(--s)), transparent calc(4px * var(--s)) calc(8px * var(--s))); }
  /* The label like QuantData's crosshair label: about 45 x 18 px for "$7,560" (measured on the real page, s7), the
     primary color as the ground, white semi-bold text, a soft shadow in the background color (1px 1px 2px). */
  .xlabel { position: fixed; display: none; pointer-events: none; z-index: 160; --s: 1; box-sizing: border-box; white-space: nowrap;
    transform: translateX(-50%) scale(var(--s)); transform-origin: 50% 0;
    padding: 2px 6px; border-radius: 3px; background: var(--qd-themeColor-primary, hsl(201, 99%, 50%)); color: var(--qd-themeColor-primaryText, #fff);
    box-shadow: 1px 1px 2px var(--qd-themeColor-background, hsl(201, 99%, 4.65%)); text-shadow: 1px 1px 2px var(--qd-themeColor-background, hsl(201, 99%, 4.65%));
    font: 600 11px/14px interVariableFont, "interVariableFont Fallback", Inter, -apple-system, system-ui, sans-serif; font-variant-numeric: tabular-nums; }
  .count.zero { color: var(--warn); }
  .end-sep { display: none; }
  .play svg.ring { display: none; }
  .pi { display: inline-flex; }
  .spd { display: contents; }
  .spd-t { display: none; }
  .hl { position: fixed; z-index: 2147483646; pointer-events: none; border: 2px solid var(--accent); border-radius: 6px; box-shadow: 0 0 0 4px rgba(245, 165, 36, 0.25); }
  /* The slider list. Floating: the panel colors. Docked: the QuantData menu style (REALSITE-1.md section 13). */
  .list {
    --l-bg: var(--bg); --l-line: var(--line); --l-accent: var(--accent); --l-hover: var(--hover); --l-muted: var(--muted);
    --l-text: #e8eaef; --l-chip: rgba(255, 255, 255, 0.06); --l-on-accent: #17130a; --l-off: rgba(255, 255, 255, 0.18);
    position: fixed; z-index: 2147483647; width: min(680px, calc(100vw - 16px)); max-height: calc(100vh - 32px); overflow: auto;
    background: var(--l-bg); border: 1px solid var(--l-line); border-radius: 10px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
    -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
    padding: 4px 10px 10px; color: var(--l-text); font-size: 13px;
  }
  /* The list opens in the middle of the window over a dark backdrop, like the QuantData settings (Julian, 2026-10-11:
     before, it opened at the left below its button and looked crammed). The bar of the panel stays above the backdrop,
     so its buttons work while the list is open; docked, the backdrop starts below the header. A click on the backdrop
     closes the list. */
  /* Dark and blurred like the backdrop of QuantData's own menus (Julian, 2026-10-11: the first one was too light). */
  .backdrop { position: fixed; left: 0; top: 0; z-index: 2147483644; background: rgba(0, 0, 0, 0.62);
    -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); animation: qdts-fade 0.15s ease-out; }
  .list:not([hidden]) { animation: qdts-fade 0.15s ease-out; } /* no scale: fixAt() measures the box at the opening */
  @keyframes qdts-fade { from { opacity: 0; } }
  .bar { position: relative; z-index: 2147483645; }
  /* 2 columns (0.17): the list grows in width, not in height. A narrow window gets 1 column. */
  .cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); column-gap: 18px; }
  .col { min-width: 0; }
  @media (max-width: 620px) { .cols { grid-template-columns: minmax(0, 1fr); } }
  .sd-in { display: grid; grid-template-columns: 1fr 96px; gap: 4px 8px; align-items: center; margin: 0 6px 6px; }
  .sd-in span { font-weight: 600; }
  .sd-in input { width: 96px; box-sizing: border-box; height: 26px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--l-line);
    background: rgba(0, 0, 0, 0.25); color: var(--l-text); font: inherit; font-variant-numeric: tabular-nums; text-align: right; }
  .sd-in input:focus { outline: 2px solid var(--l-accent); outline-offset: -1px; }
  .sd-hint { margin: 0 6px 8px; color: var(--l-muted); font-size: 12px; }
  .sd-ch-h { margin: 6px 6px 2px; color: var(--l-muted); font-size: 12px; }
  .sd-lv { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 2px 6px 6px; }
  .sd-lv button { height: 24px; min-width: 40px; padding: 0 8px; border-radius: 6px; background: var(--l-chip); color: var(--l-text);
    box-shadow: inset 0 0 0 1px var(--l-line); font-weight: 600; font-variant-numeric: tabular-nums; }
  .sd-lv button.on { background: var(--l-accent); color: var(--l-on-accent); box-shadow: none; }
  /* "i": a round button at the right end of the levels; it shows the values of ±1σ, ±2σ, ±3σ below. */
  .sd-lv .sd-info { margin-left: auto; min-width: 24px; width: 24px; padding: 0; border-radius: 50%; font: italic 700 13px/24px Georgia, "Times New Roman", serif; }
  .sd-out { display: grid; grid-template-columns: auto auto 1fr; column-gap: 14px; margin: 2px 6px 4px; color: var(--l-muted); font-variant-numeric: tabular-nums; line-height: 1.6; }
  .sd-out .sd-t { grid-column: 1 / -1; display: flex; justify-content: space-between; gap: 8px; margin-top: 2px; color: var(--l-text); font-weight: 600; }
  .sd-out .sd-p { color: var(--l-muted); font-weight: 500; }
  .sd-out .sd-r { display: contents; }
  .sd-out .sd-r span:nth-child(n+2) { text-align: right; }
  .sec { padding: 8px 0 6px; border-bottom: 1px solid var(--l-line); }
  .sec-h { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0 2px 6px; color: var(--l-muted); font-size: 12px; font-weight: 600; }
  .sec-v { color: var(--l-muted); font-weight: 500; font-variant-numeric: tabular-nums; }
  .sec-v b { color: var(--l-text); font-weight: 700; }
  .meter { position: relative; height: 6px; margin: 0 2px; border-radius: 3px; background: var(--l-off); overflow: hidden; }
  .meter .b-bar { position: absolute; left: 0; top: 0; bottom: 0; width: 100%; background: var(--l-accent); border-radius: 3px; transition: width 0.3s; }
  .meter .b-res { position: absolute; left: calc(100% / 6); top: 0; bottom: 0; width: 2px; background: var(--l-bg); }
  .budget-info.low .b-bar { background: var(--warn); }
  .sub { display: flex; justify-content: space-between; gap: 8px; margin: 6px 2px 0; color: var(--l-muted); font-size: 11.5px; }
  .sub b { color: var(--l-text); font-weight: 600; font-variant-numeric: tabular-nums; }
  .rows { max-height: 220px; overflow: auto; }
  .row { display: flex; align-items: center; gap: 8px; min-height: 30px; padding: 0 6px; border-radius: 8px; cursor: pointer; font-weight: 600; }
  .row:hover { background: var(--l-hover); }
  .row .name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row .name i { font-style: normal; color: var(--l-muted); font-weight: 500; margin-right: 8px; font-variant-numeric: tabular-nums; }
  .row .val { color: var(--l-muted); font-weight: 500; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .list input[type=checkbox] {
    -webkit-appearance: none; appearance: none; flex: none; margin: 0; width: 16px; height: 16px; border-radius: 4px; cursor: pointer;
    border: 1px solid color-mix(in srgb, var(--l-accent), transparent 40%); background: color-mix(in srgb, var(--l-accent), transparent 80%);
  }
  .list input[type=checkbox]:checked { background: var(--l-accent) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3.5 8.5l3 3 6-7' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / 12px no-repeat; border-color: var(--l-accent); }
  .list input[type=checkbox]:disabled { opacity: 0.4; cursor: default; }
  .list input[type=checkbox]:focus-visible { outline: 2px solid var(--l-accent); outline-offset: 1px; }
  /* A switch: the knob is a background picture (Safari draws no pseudo-elements on inputs). */
  .list input.sw {
    width: 30px; height: 16px; border-radius: 8px; border: 0;
    background: radial-gradient(circle, #fff 0 5.5px, transparent 6.5px) 0 0 / 16px 16px no-repeat, var(--l-off);
    transition: background-position 0.2s, background-color 0.2s;
  }
  .list input.sw:checked { background: radial-gradient(circle, #fff 0 5.5px, transparent 6.5px) 14px 0 / 16px 16px no-repeat, var(--l-accent); border: 0; }
  .opt { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 30px; padding: 0 6px; border-radius: 8px; cursor: pointer; font-weight: 600; }
  .opt:hover { background: var(--l-hover); }
  .key { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 26px; padding: 0 6px; color: var(--l-text); }
  .key > span:last-child { display: inline-flex; align-items: center; gap: 4px; }
  .key i { font-style: normal; color: var(--l-muted); font-size: 11px; margin: 0 2px; }
  kbd { display: inline-block; min-width: 20px; text-align: center; font: 600 11px/1 ui-monospace, Menlo, monospace; padding: 4px 5px; border-radius: 4px; background: var(--l-chip); border: 1px solid var(--l-line); color: var(--l-text); }
  .empty { padding: 6px; color: var(--l-muted); }
  .msg { margin: 8px 2px 0; color: var(--l-accent); }
  .report { margin-top: 8px; }
  .link { width: 100%; height: 30px; border-radius: 8px; background: var(--l-chip); color: var(--l-text); font-weight: 600; }
  .link:hover { background: var(--l-hover); color: #fff; }
  .link.on { background: var(--l-accent); color: var(--l-on-accent); }
  .report-text { display: block; width: 100%; height: 90px; margin-top: 6px; resize: vertical; background: rgba(0,0,0,0.35); color: #c7ccd6; border: 1px solid var(--l-line); border-radius: 6px; font: 10px/1.3 ui-monospace, Menlo, monospace; }
  .panel.docked .list {
    --l-bg: var(--qfg); --l-line: var(--qsec); --l-accent: var(--qd); --l-hover: color-mix(in srgb, var(--qd), transparent 80%);
    --l-muted: var(--qmuted); --l-text: var(--qtext); --l-chip: var(--qter); --l-on-accent: var(--qtext); --l-off: color-mix(in srgb, var(--qd), transparent 70%);
    border: 1px solid var(--l-accent); border-radius: 8px; box-shadow: 1px 1px 2px var(--qbg), 0 12px 32px color-mix(in srgb, var(--qbg), transparent 45%);
    -webkit-backdrop-filter: none; backdrop-filter: none; text-shadow: 1px 1px 2px var(--qbg);
    font-family: interVariableFont, "interVariableFont Fallback", Inter, -apple-system, system-ui, sans-serif;
  }
  .panel.docked .list .link { background: var(--l-chip); box-shadow: inset 0 0 0 1px var(--l-line); }
  .panel.docked .list .link:hover { background: var(--l-accent); }
  /* A short message while the list is closed (report mode): the style of the QuantData tooltips. */
  .tip { position: absolute; right: 0; bottom: calc(100% + 6px); width: max-content; max-width: 340px; padding: 8px 12px; border-radius: 8px; pointer-events: none;
    background: var(--accent); color: #17130a; font-weight: 600; font-size: 12.5px; line-height: 1.35; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45); }
  .tip.below { bottom: auto; top: calc(100% + 6px); }
  .panel.docked .tip { position: fixed; right: auto; bottom: auto; top: auto; z-index: 2147483647; background: var(--qd); color: var(--qtext);
    text-shadow: 1px 1px 2px var(--qbg); font-family: interVariableFont, "interVariableFont Fallback", Inter, -apple-system, system-ui, sans-serif; }
  .list .more { display: none; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 4px 8px; }
  .list .b-status { display: none; }
  .panel.docked .list .b-status { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 6px 2px 0; }
  .panel.docked .list .b-status:not(:has(> :not([hidden]))) { display: none; }
  .list .rate2 { color: #ff8a7a; font-weight: 600; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .list .pace2 { color: var(--l-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .list .slow2 { height: 24px; padding: 0 10px; border-radius: 8px; color: #ff8a7a; font-weight: 600; box-shadow: inset 0 0 0 1px #ff8a7a; }
  .list .more .lbl { color: var(--muted); }
  .list .more select, .list .more .rth { box-shadow: inset 0 0 0 1px var(--line); }

  /* Docked in the QuantData header: the styles of its buttons (REALSITE-1.md sections 5 and 12).
     The host takes only the free space of the header part (flex 1 1 0, min-width 0), so it never pushes the
     rest of the header out. A narrow panel hides controls (container queries below). The gap after the brand is a
     padding of the panel: the page's CSS reset sets the margin of the host to 0 (seen on the real page). */
  :host(.docked) { display: block; flex: 1 1 0; min-width: 0; height: 60px; }
  .panel.docked {
    /* The colors of the QuantData color scheme: QuantData sets these variables on <html> (REALSITE-1.md section 13).
       They reach the shadow root. The values after the comma are the default scheme. */
    --qd: var(--qd-themeColor-primary, hsl(201, 99%, 50%));
    --qbg: var(--qd-themeColor-background, hsl(201, 99%, 4.65%));
    --qfg: var(--qd-themeColor-foreground, hsl(201, 99%, 12%));
    --qter: var(--qd-themeColor-tertiary, hsl(201, 99%, 16%));
    --qsec: var(--qd-themeColor-secondary, hsl(201, 99%, 22%));
    --qtext: var(--qd-themeColor-primaryText, #ffffff);
    --qmuted: var(--qd-themeColor-secondaryText, #aaaaaa);
    --accent: color-mix(in srgb, var(--qd), white 50%);
    position: relative; left: auto; top: auto; bottom: auto; transform: none; z-index: 170; /* above the masks (160): never over the list */
    width: 100%; height: 60px; display: flex; align-items: center; min-width: 0; padding: 0 24px 0 10px;
    container-type: inline-size;
    font: 12.25px/1.2 interVariableFont, "interVariableFont Fallback", Inter, -apple-system, system-ui, sans-serif;
    color: var(--qtext);
  }
  .panel.docked .bar {
    background: transparent; border: 0; border-radius: 0; box-shadow: none; -webkit-backdrop-filter: none; backdrop-filter: none;
    flex: 1 1 auto; padding: 8px 6px; gap: 8px; min-width: 0; overflow: hidden; flex-wrap: nowrap;
  }
  .panel.docked .bar > * { flex: none; }
  .panel.docked .bar .rate, .panel.docked .bar .slow, .panel.docked .bar .pace { display: none; } /* On the Play button and in the list. */
  .panel.docked .bar .grip, .panel.docked .bar [data-act=collapse] { display: none; }
  /* Icon buttons like the QuantData header icons: 30.6 px square, radius 8, the primary color, a 21 px outline icon
     with a drop shadow. Buttons with text (the list button) also get the box and text shadow of QDButton. */
  .panel.docked .bar button {
    height: 30.6px; min-width: 30.6px; padding: 0; border-radius: 8px;
    background: var(--qd); color: var(--qtext); box-shadow: none; font-size: 12.25px; font-weight: 600;
    text-shadow: var(--qbg) 1px 1px 2px; transition: background 0.1s ease-in-out;
  }
  .panel.docked .bar button:hover { background: color-mix(in srgb, var(--qd), white 15%); color: var(--qtext); }
  .panel.docked .bar button:focus-visible { outline: 2px solid var(--qtext); outline-offset: 1px; }
  .panel.docked .bar button svg { width: 21px; height: 21px; filter: drop-shadow(var(--qbg) 1px 1px 2px); }
  /* The list button: square like the QuantData filter button; the number of sliders is a badge at the top right. */
  .panel.docked .bar .count { position: relative; width: 30.6px; padding: 0; overflow: visible; }
  /* The badge like the QuantData indicator on the filter button (measured): 14.9 px, the success color, centered on the corner. */
  .panel.docked .bar .count .n {
    position: absolute; top: -3.9px; right: -7.5px; min-width: 14.9px; height: 14.9px; padding: 0 3.5px; border-radius: 999px; box-sizing: border-box;
    background: var(--qd-themeColor-success, #009908); color: #fff; font: 700 11px/14.9px interVariableFont, Inter, -apple-system, system-ui, sans-serif;
    text-align: center; text-shadow: var(--qbg) 1px 1px 2px; box-shadow: var(--qbg) 1px 1px 2px; font-variant-numeric: tabular-nums;
  }
  .panel.docked .bar .count.zero .n { background: var(--qd-themeColor-danger, #ad341f); }
  /* The divider after the panel, like the QuantData dividers in the header: 1 x 28 px, the primary color, 24 px on each side. */
  .panel.docked .bar .end-sep { display: block; width: 1px; height: 28px; margin-left: 16px; background: var(--qd); }
  .panel.docked .bar .play { margin: 0; position: relative; overflow: visible; }
  /* The ring: an SVG with an even stroke (a CSS mask on 30.6 px rounded unevenly). It empties with stroke-dasharray. */
  .panel.docked .bar .play svg.ring {
    position: absolute; left: -4px; top: -4px; width: calc(100% + 8px); height: calc(100% + 8px); overflow: visible;
    pointer-events: none; opacity: 0; filter: none;
  }
  .panel.docked .bar .play svg.ring rect { fill: none; stroke: var(--ring, #ff1f1f); stroke-width: var(--ring-w, 2); stroke-linecap: round; }
  /* Rate limit: a strong red. The budget wait: thinner and light. They must never look alike (Julian). */
  .panel.docked .bar .play.limited svg.ring { opacity: 1; --ring: #ff1f1f; --ring-w: 2; }
  .panel.docked .bar .play.waiting svg.ring { opacity: 1; --ring: color-mix(in srgb, var(--qtext), transparent 55%); --ring-w: 1.4; }
  .panel.docked .bar .play[data-slow]::before {
    content: attr(data-slow); position: absolute; top: -3.9px; right: -9px; z-index: 1; min-width: 14.9px; height: 14.9px; padding: 0 4.4px;
    border-radius: 999px; box-sizing: border-box; background: var(--qd-themeColor-danger, #ad341f); color: #fff; text-shadow: var(--qbg) 1px 1px 2px;
    box-shadow: var(--qbg) 1px 1px 2px; font: 700 9.5px/14.9px interVariableFont, Inter, -apple-system, system-ui, sans-serif; text-align: center; white-space: nowrap;
  }
  .panel.docked .bar .play.on { background: var(--qfg); box-shadow: inset 0 0 0 2px var(--qd); }
  .panel.docked .bar .sep { width: 1px; height: 28px; margin: 0 8px; background: var(--qd); }
  /* The master slider like the QuantData time sliders: a 7 px round track (primary at 20 %), filled up to the thumb
     (primary at 50 %), a white 18 px thumb. */
  .panel.docked .bar .master {
    flex: 1 1 200px; min-width: 90px; max-width: 200px; width: auto; height: 18px; margin: 0 4px; padding: 0;
    -webkit-appearance: none; appearance: none; background: transparent; cursor: pointer; --p: 0;
  }
  .panel.docked .bar .master::-webkit-slider-runnable-track {
    height: 7px; border-radius: 28px; border: 0;
    background: linear-gradient(to right, color-mix(in srgb, var(--qd), transparent 50%) calc(9px + (100% - 18px) * var(--p)),
      color-mix(in srgb, var(--qd), transparent 80%) calc(9px + (100% - 18px) * var(--p)));
  }
  .panel.docked .bar .master::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none; width: 18px; height: 18px; margin-top: -5.5px; border: 0; border-radius: 50%; background: #fff;
  }
  .panel.docked .bar .master::-moz-range-track { height: 7px; border-radius: 28px; border: 0; background: color-mix(in srgb, var(--qd), transparent 80%); }
  .panel.docked .bar .master::-moz-range-progress { height: 7px; border-radius: 28px; background: color-mix(in srgb, var(--qd), transparent 50%); }
  .panel.docked .bar .master::-moz-range-thumb { width: 18px; height: 18px; border: 0; border-radius: 50%; background: #fff; }
  .panel.docked .bar .master:focus-visible { outline: 2px solid var(--qtext); outline-offset: 3px; border-radius: 9px; }
  .panel.docked .bar .master:disabled { opacity: 0.35; cursor: default; }
  .panel.docked .bar .time { width: 84px; height: 30.6px; flex: none; border-radius: 8px; background: color-mix(in srgb, var(--qtext), transparent 94%);
    color: var(--qtext); font-size: 14px; font-weight: 600; text-shadow: var(--qbg) 1px 1px 2px; }
  .panel.docked .bar .time.busy { color: var(--accent); }
  .panel.docked .bar select, .panel.docked .bar .rth {
    height: 22.6px; min-width: 0; padding: 2px 9px; border-radius: 16px; box-shadow: none;
    font-size: 12px; font-weight: 700; text-shadow: var(--qbg) 1px 1px 2px;
  }
  .panel.docked .bar .play svg.ring { display: block; }
  .panel.docked .bar .spd {
    position: relative; display: inline-flex; align-items: center; justify-content: center; flex: none;
    height: 22.6px; min-width: 44px; padding: 0 10px; border-radius: 16px; box-sizing: border-box; background: var(--qd); color: var(--qtext);
    font-size: 12px; font-weight: 700; line-height: 1; text-shadow: var(--qbg) 1px 1px 2px; cursor: pointer; white-space: nowrap;
  }
  .panel.docked .bar .spd-t { display: block; pointer-events: none; }
  .panel.docked .bar .spd select { position: absolute; inset: 0; width: 100%; height: 100%; padding: 0; margin: 0; opacity: 0; cursor: pointer; }
  .panel.docked .bar .spd:hover { background: color-mix(in srgb, var(--qd), white 15%); }
  .panel.docked .bar .spd:focus-within { outline: 2px solid var(--qtext); outline-offset: 1px; }
  /* RTH: on = filled with the primary color, off = only an outline. The mouse over it makes each only a bit lighter, so
     the state stays clear also during the hover (Julian, 2026-10-11: on a large screen he could not see if a click
     switched it on; before, the hover of "off" looked like "on"). */
  /* The outline is a border, not an inset shadow: the browser puts a border on whole device pixels, so both ends
     are equal at each zoom (Julian, 2026-10-11: with the shadow one end was thicker at some zoom levels). */
  .panel.docked .bar .rth { background: transparent; border: 1.5px solid color-mix(in srgb, var(--qd), transparent 25%);
    color: color-mix(in srgb, var(--qtext), transparent 35%); }
  .panel.docked .bar .rth:hover { background: color-mix(in srgb, var(--qd), transparent 82%); color: var(--qtext); }
  .panel.docked .bar .rth.on { background: var(--qd); border-color: var(--qd); color: var(--qtext); }
  .panel.docked .bar .rth.on:hover { background: color-mix(in srgb, var(--qd), white 15%); }
  .panel.docked .bar .align { background: transparent; box-shadow: none; color: var(--accent); padding: 0 10px; }
  .panel.docked .bar .slow { background: transparent; box-shadow: inset 0 0 0 1px #ff8a7a; color: var(--qtext); }
  .panel.docked .bar .rate { color: #ff8a7a; }
  .panel.docked .bar .pace { color: color-mix(in srgb, var(--qtext), transparent 25%); }
  /* Narrow: the master slider stays as long as possible (Julian: also on a MacBook). First the start and end
     buttons go, then speed, RTH and the rate texts move into the list, then the step buttons go (the keys step too). */
  @container (max-width: 680px) {
    .panel.docked .bar [data-act=start], .panel.docked .bar [data-act=end] { display: none; }
  }
  @container (max-width: 560px) {
    .panel.docked .bar .spd, .panel.docked .bar .rth, .panel.docked .bar .align, .panel.docked .bar .sep { display: none; }
    .list .more { display: flex; }
  }
  @container (max-width: 400px) {
    .panel.docked .bar [data-act=back], .panel.docked .bar [data-act=fwd] { display: none; }
  }
  @container (max-width: 300px) {
    .panel.docked .bar .master { display: none; }
  }
  @container (max-width: 200px) {
    .panel.docked .bar { gap: 6px; }
    .panel.docked .bar .time { width: 60px; font-size: 12.5px; }
  }
  @container (max-width: 170px) {
    .panel.docked .bar .time { display: none; }
  }
</style>
<div class="panel">
  <div class="backdrop" hidden></div>
  <div class="hl" hidden></div>
  <div class="tip" hidden></div>
  <div class="list" hidden>
    <div class="more"><span class="lbl">Play speed</span><select class="speed speed2" title="Time between two steps during play">${SPEEDS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select><button data-act="rth" class="rth rth2" title="RTH 09:30–16:00 ET">RTH</button></div>
    <div class="cols"><div class="col">
    <section class="sec budget-info" title="QuantData allows about 120 requests, then 2 per second. Play waits until a step fits and 20 requests stay free for your own clicks. The requests of all QuantData tabs in this browser count.">
      <div class="sec-h"><span>Play budget</span><span class="sec-v"><b class="b-free">–</b> of 120 free</span></div>
      <div class="meter"><i class="b-bar"></i><i class="b-res"></i></div>
      <div class="sub"><span>1 step: <b class="b-cost">–</b></span><span>20 kept for your clicks</span></div>
      <div class="b-status"><span class="rate2" hidden></span><span class="pace2" hidden></span><button class="slow2" data-act="full-speed" hidden title="Play runs slower after a QuantData rate-limit message. Click for full speed again."></button></div>
    </section>
    <section class="sec">
      <div class="sec-h"><span>Time sliders</span></div>
      <div class="rows"></div>
    </section>
    <section class="sec zsec" hidden>
      <div class="sec-h zoom-h"><span>Zoom bars that follow the time</span></div>
      <div class="rows zrows"></div>
    </section>
    <section class="sec lsec" hidden>
      <div class="sec-h"><span>Linked strike charts</span></div>
      <div class="rows lrows"></div>
    </section>
    </div><div class="col">
    <section class="sec sdsec" hidden title="1σ = prior close × prior-close VIX ÷ 15.87 % (the 15.87 rule: √252 = 15.87 trading days). The lines show prior close ± each selected σ on the strike charts.">
      <div class="sec-h"><span>Standard deviation (VIX ÷ 15.87)</span><input type="checkbox" class="sw opt-sd" title="Show the σ lines on the strike charts"></div>
      <div class="sd-in"></div>
      <div class="sd-hint">A value that you type is for the day of the charts only. Keep a field empty to use the automatic value.</div>
      <div class="sd-lv"></div>
      <div class="sd-ch"></div>
      <div class="sd-out" hidden></div>
    </section>
    <section class="sec">
      <div class="sec-h"><span>Options</span></div>
      <label class="opt zopts" hidden title="Covers the mini chart in the zoom bar after the right end. The mini chart shows the full day."><span>Cover the preview after the right end</span><input type="checkbox" class="sw opt-mask"></label>
      <label class="opt" title="When the mouse is over a chart, a dashed line shows the same strike or time in the other charts of the same kind."><span>Crosshair line in the other charts</span><input type="checkbox" class="sw opt-xhair"></label>
      <label class="opt" title="After a step, each chart shows the old data until QuantData has drawn the new data. You do not see the loading text."><span>Keep the old chart while new data loads</span><input type="checkbox" class="sw opt-freeze"></label>
      <label class="opt" title="The time field and the times in this list show the time of your computer, not New York time (ET). In the time field you can also type a time with ET after it, for example 10:30 ET."><span>Show the time in your time zone</span><input type="checkbox" class="sw opt-local"></label>
    </section>
    <section class="sec keys">
      <div class="sec-h"><span>Keys</span></div>
      <div class="key"><span>1 step</span><span><kbd>←</kbd><kbd>→</kbd><i>or</i><kbd>,</kbd><kbd>.</kbd></span></div>
      <div class="key"><span>${SHIFT_STEPS} steps</span><span><kbd>⇧</kbd><i>+</i><kbd>←</kbd><kbd>→</kbd></span></div>
      <div class="key"><span>Play / pause</span><span><kbd>-</kbd></span></div>
    </section>
    </div></div>
    <div class="msg" hidden></div>
    <div class="report">
      <button class="link" data-act="report" title="Copies the slider data and the structure of 1 element that you click. Paste it in the chat with the developer.">Copy report…</button>
      <textarea class="report-text" readonly hidden></textarea>
    </div>
  </div>
  <div class="bar">
    <span class="grip" title="Drag to move the panel"></span>
    <button data-act="start" title="Go to the start">${icon.start}</button>
    <button data-act="back" title="1 step back (← or ,)">${icon.back}</button>
    <button data-act="play" class="play" title="Play (-)"><span class="pi">${icon.play}</span><svg class="ring" viewBox="0 0 40 40" preserveAspectRatio="none" aria-hidden="true"><rect x="1.2" y="1.2" width="37.6" height="37.6" rx="11" ry="11" pathLength="100"/></svg></button>
    <button data-act="fwd" title="1 step forward (→ or .)">${icon.fwd}</button>
    <button data-act="end" title="Go to the end">${icon.end}</button>
    <input type="range" class="master" title="Set all sliders to this time">
    <input class="time" type="text" spellcheck="false" autocomplete="off" value="–" title="Type a time (for example 10:45) and press Enter. All sliders go to this time.">
    <span class="rate" hidden></span>
    <span class="pace" hidden title="Play waits for the QuantData request budget (about 120 requests, then 2 per second). Your own steps do not wait."></span>
    <button class="slow" data-act="full-speed" hidden title="Play runs slower after a QuantData rate-limit message. Click for full speed again."></button>
    <label class="spd"><span class="spd-t">Auto</span><select class="speed" title="Time between two steps during play. Auto waits until the data is loaded.">${SPEEDS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
    <button data-act="rth" class="rth" title="RTH 09:30–16:00 ET: start, end, master slider and play use this range" hidden>RTH</button>
    <button data-act="align" class="align" title="The sliders show different times. Click to set all sliders to the time of slider 1." hidden>≠ Align</button>
    <span class="sep"></span>
    <button data-act="list" class="count" title="Sliders that move together">${icon.sliders}<span class="n">0</span></button>
    <button data-act="collapse" title="Make the panel small">${icon.min}</button>
    <span class="end-sep" aria-hidden="true"></span>
  </div>
  <div class="pill" hidden title="Open QD Toolkit">${icon.clock}<span class="n">0</span></div>
</div>
<div class="masks"></div>
<div class="xhair"></div>`;

  const $ = (s) => root.querySelector(s);
  const panel = $('.panel');
  const bar = $('.bar');
  const pill = $('.pill');
  const list = $('.list');
  const backdrop = $('.backdrop');
  backdrop.addEventListener('click', () => openList(false)); // a click outside the list closes it (the page does not get it)
  const rows = $('.rows');
  const zrows = $('.zrows');
  const zoomH = $('.zsec');
  const zopts = $('.zopts');
  const optFreeze = $('.opt-freeze');
  const optMask = $('.opt-mask');
  const msg = $('.msg');
  const hl = $('.hl');
  const tip = $('.tip');
  const masks = $('.masks');
  const xhairBox = $('.xhair');
  const lrows = $('.lrows');
  const linkH = $('.lsec');
  const optXhair = $('.opt-xhair');
  const sdSec = $('.sdsec');
  const sdIn = $('.sd-in');
  const sdLv = $('.sd-lv');
  const sdOut = $('.sd-out');
  const sdCh = $('.sd-ch');
  const optSd = $('.opt-sd');
  const optLocal = $('.opt-local');
  const rateEl = $('.rate');
  const rateEl2 = $('.rate2');
  const paceEl2 = $('.pace2');
  const paceEl = $('.pace');
  const budgetInfo = $('.budget-info');
  const bFree = $('.b-free');
  const bCost = $('.b-cost');
  const bBar = $('.b-bar');
  const master = $('.master');
  const timeEl = $('.time');
  const speedSel = $('.bar .speed');
  const speedSel2 = $('.speed2'); // in the list, for a narrow header
  const alignBtn = $('.align');
  const playBtn = $('.play');
  const playIcon = playBtn.querySelector('.pi');
  const ringRect = playBtn.querySelector('.ring rect');
  const speedText = $('.spd-t');
  const reportBtn = $('[data-act=report]');
  const slowBtn = $('.slow');
  const slowBtn2 = $('.slow2'); // in the list, for a narrow header
  const reportText = $('.report-text');
  const rthBtn = $('.bar .rth');
  const rthBtn2 = $('.rth2');
  const startBtn = root.querySelector('[data-act=start]');
  const endBtn = root.querySelector('[data-act=end]');

  (document.body || document.documentElement).appendChild(host);

  // ---------------------------------------------------------------------------
  // Panel position (drag at the grip)
  // ---------------------------------------------------------------------------
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function place(x, y) {
    if (docked) return; // In the header the page places the panel.
    const r = panel.getBoundingClientRect();
    x = clamp(x, 0, Math.max(0, innerWidth - r.width));
    y = clamp(y, 0, Math.max(0, innerHeight - r.height));
    cfg.x = x;
    cfg.y = y;
    Object.assign(panel.style, { left: `${x}px`, top: `${y}px`, bottom: 'auto', transform: 'none' });
  }
  function startDrag(e) {
    if (e.button !== 0 || docked) return;
    e.preventDefault();
    const r = panel.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    let moved = false;
    const move = (ev) => {
      moved = true;
      place(ev.clientX - dx, ev.clientY - dy);
    };
    const up = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      if (moved) saveCfg();
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
  }
  $('.grip').addEventListener('pointerdown', startDrag);
  window.addEventListener('resize', () => {
    if (!docked && cfg.x !== null) place(cfg.x, cfg.y);
    if (!list.hidden) placeList();
    placeTip();
  });

  // ---------------------------------------------------------------------------
  // Header panel: the panel goes into the QuantData header, after the brand (left part of the header row).
  // QuantData can render the header again: refresh() puts the panel back. No header: the floating panel.
  // ---------------------------------------------------------------------------
  let docked = false;
  let headerRow = null;
  const MIN_FREE = 130; // px between the brand and the menus. Less: the floating panel (Play, the list, the divider and the gap need about 130 px).
  const tokenIn = (el, re) => !!el && el.nodeType === 1 && [...el.classList].some((c) => re.test(c));
  function headerSlot() {
    if (!headerRow || !headerRow.isConnected) {
      headerRow = [...document.querySelectorAll('[class*="QDHeader-module__"]')].find((n) => tokenIn(n, /^QDHeader-module__.*__desktopRow$/)) || null;
    }
    const left = headerRow && headerRow.firstElementChild;
    const brand = left && [...left.children].find((n) => tokenIn(n, /^QDHeader-module__.*__brand$/));
    if (!brand || !brand.getClientRects().length) return null; // No header, or a hidden one.
    // The panel has flex-basis 0, so this free space does not change when the panel goes in or out.
    const free = left.getBoundingClientRect().right - brand.getBoundingClientRect().right - 14;
    return free >= MIN_FREE ? { left, brand } : null;
  }
  // The docked panel is a size container. Some browsers make it the box of its fixed elements (list, highlight):
  // place them, then correct by the measured offset.
  function fixAt(el, left, top) {
    Object.assign(el.style, { left: `${left}px`, top: `${top}px` });
    const r = el.getBoundingClientRect();
    if (Math.abs(r.left - left) > 0.5 || Math.abs(r.top - top) > 0.5) Object.assign(el.style, { left: `${2 * left - r.left}px`, top: `${2 * top - r.top}px` });
  }
  function setDocked(on) {
    docked = on;
    host.classList.toggle('docked', on);
    panel.classList.toggle('docked', on);
    if (on) Object.assign(panel.style, { left: '', top: '', bottom: '', transform: '' });
    else if (cfg.x !== null) requestAnimationFrame(() => place(cfg.x, cfg.y));
    if (!list.hidden) openList(false); // The list opens at a new place.
    render();
    requestAnimationFrame(placeTip); // After place(): the message moves with the panel.
  }
  function mount() {
    const slot = headerSlot();
    if (slot) {
      if (host.parentElement !== slot.left || host.previousElementSibling !== slot.brand) slot.brand.after(host);
      if (!docked) setDocked(true);
      return;
    }
    const body = document.body || document.documentElement;
    if (host.parentElement !== body) body.appendChild(host);
    if (docked) setDocked(false);
  }

  // ---------------------------------------------------------------------------
  // Slider list and highlight
  // ---------------------------------------------------------------------------
  function describe(el) {
    const lbl = el.getAttribute('aria-label');
    if (lbl) return lbl;
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim()).filter(Boolean).join(' ');
      if (t) return t;
    }
    return el.id ? `#${el.id}` : el instanceof HTMLInputElement ? 'Range input' : 'Slider';
  }

  // The tool name of a slider: its tab button ("DEX by Strike"), else the chart title, else the slider's own label.
  function sliderName(el) {
    const tab = el.closest('[data-layout-path]');
    const path = tab && tab.getAttribute('data-layout-path');
    const btn = path ? document.querySelector(`[data-layout-path="${path.replace(/\/t(\d+)$/, '/tb$1')}"]`) : null;
    if (btn && btn.textContent.trim()) return btn.textContent.trim().slice(0, 40);
    const tool = toolOf(el);
    const head = tool && [...tool.querySelectorAll('[class*="QDChartHeader-module__"]')].find((n) => hasToken(n, /^QDChartHeader-module__.*__title$/));
    return head && head.textContent.trim() ? head.textContent.trim().slice(0, 40) : describe(el);
  }

  function showHighlight(el) {
    // Not on the screen (a hidden tab): no frame (before, the frame went up to a parent and covered the whole page).
    if (!el || !el.isConnected || !el.getClientRects().length) return hideHighlight();
    // A visually hidden range input (MUI) has no size. Then show the parent (max 3 levels up).
    let target = el;
    let r = target.getBoundingClientRect();
    for (let up = 0; (r.width < 4 || r.height < 4) && target.parentElement && up < 3; up++) {
      target = target.parentElement;
      r = target.getBoundingClientRect();
    }
    Object.assign(hl.style, { width: `${r.width + 8}px`, height: `${r.height + 8}px` });
    hl.hidden = false;
    fixAt(hl, r.left - 4, r.top - 4);
  }
  function hideHighlight() {
    hl.hidden = true;
  }

  let listSig = '';
  // The strike charts come from linkShown: they stay in the list while QuantData loads them after a step.
  const signature = () => `${autoList.filter(shownEl).map((el) => sliderKeys.get(el)).join(',')}|${zoomBars.filter(listedBar).map((z) => z.key).join(',')}|${linkViewRows().map((e) => e.key + e.gid + e.title).join(',')}|${sdTickers().join(',')}`;

  function buildList() {
    const entries = autoList.map((el, i) => ({ el, i })).filter((e) => shownEl(e.el));
    listSig = signature();
    buildZoomList();
    buildLinkList();
    buildSdList();
    rows.innerHTML = '';
    if (!entries.length) {
      rows.innerHTML = '<div class="empty">No slider found. Click “Copy report…” and send the report to the developer.</div>';
      return;
    }
    entries.forEach((entry, n) => {
      const row = document.createElement('label');
      row.className = 'row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !isOff(entry.el, entry.i);
      cb.addEventListener('change', () => {
        setOff(entry.el, !cb.checked);
        refresh();
      });
      const name = document.createElement('span');
      name.className = 'name';
      name.innerHTML = `<i>${n + 1}</i>`;
      name.append(sliderName(entry.el));
      const val = document.createElement('span');
      val.className = 'val';
      entry.valEl = val;
      row.append(cb, name, val);
      row.addEventListener('mouseenter', () => showHighlight(entry.el));
      row.addEventListener('mouseleave', hideHighlight);
      row._entry = entry;
      rows.appendChild(row);
    });
    updateListValues();
  }
  function updateListValues() {
    for (const row of rows.children) {
      const e = row._entry;
      if (e && e.valEl) e.valEl.textContent = fmt(read(e.el));
    }
    for (const row of zrows.children) {
      const z = row._zoom && (barOf(row._zoom.key) || row._zoom); // QuantData can render a zoom bar again as a new element
      if (z && row._val) row._val.textContent = z.strike ? 'strike chart' : zoomOn(z) ? zoomText(z) : 'off';
    }
    for (const row of lrows.children) {
      const e = row._link && linkShown.get(row._link);
      if (e) row._val.textContent = linkLabel(e);
    }
  }

  // The status of a zoom bar: its time span (ET, or local with the option), else "no data" and so on.
  const zoomText = (z) => {
    const sp = z.span && z.status === `${hhmm(z.span[0])}–${hhmm(z.span[1])}` ? z.span : null;
    return sp && cfg.localTime ? `${hhmm(wrap(sp[0] + localShift()))}–${hhmm(wrap(sp[1] + localShift()))}` : z.status || 'on';
  };
  // Only the zoom bars that can follow the time: not a strike chart, and the page gives the minutes of the bar.
  const timeBar = (z) => !z.strike && !z.vertical && !!z.info && z.info.ok && z.info.times;
  const listedBar = (z) => timeBar(z) && shownEl(z.root); // not a chart in a hidden tab
  function buildZoomList() {
    zrows.innerHTML = '';
    const bars = zoomBars.filter(listedBar);
    zoomH.hidden = bars.length === 0;
    zopts.hidden = bars.length === 0;
    optMask.checked = !!cfg.zoomMask;
    for (const z of bars) {
      const row = document.createElement('label');
      row.className = 'row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = zoomOn(z);
      cb.disabled = z.strike;
      if (z.strike) row.title = 'This chart has its own time slider (strike axis). Its zoom bar does not follow the time.';
      cb.addEventListener('change', () => {
        cfg.zoom = { ...cfg.zoom, [z.key]: cb.checked };
        if (cb.checked) leftEt.delete(z.key); // Switched on: the left end goes to 09:30.
        saveCfg();
        z.status = '';
        z.touched = false;
        zoomGen++;
        refresh();
      });
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = z.title;
      const val = document.createElement('span');
      val.className = 'val';
      row.append(cb, name, val);
      row.addEventListener('mouseenter', () => showHighlight((barOf(z.key) || z).root));
      row.addEventListener('mouseleave', hideHighlight);
      row._zoom = z;
      row._val = val;
      zrows.appendChild(row);
    }
  }

  // The list opens in the middle of the window (docked and floating), over a backdrop. Docked, the backdrop starts below
  // the header: the header stays as it is (the panel buttons work, QuantData's header parts are not half dark).
  // Placed at the opening and at a resize only: when its content changes, it grows down and scrolls, it does not jump.
  function placeList() {
    const y0 = docked ? Math.max(0, Math.round(panel.getBoundingClientRect().bottom)) : 0;
    Object.assign(backdrop.style, { width: `${innerWidth}px`, height: `${Math.max(0, innerHeight - y0)}px` });
    fixAt(backdrop, 0, y0);
    // The middle of the visible page (without a scroll bar): below the header (docked), or in the larger room above or
    // below the floating panel (the list never covers the panel buttons).
    const vw = document.documentElement.clientWidth || innerWidth;
    const vh = document.documentElement.clientHeight || innerHeight;
    let a = y0 + 8;
    let b = vh - 16;
    if (!docked) {
      const r = bar.getBoundingClientRect();
      if (r.top - 8 >= vh - r.bottom - 8) [a, b] = [8, r.top - 8];
      else [a, b] = [r.bottom + 8, vh - 8];
    }
    list.style.maxHeight = '';
    const w = list.offsetWidth || Math.min(680, vw - 16);
    const h = Math.min(list.offsetHeight, Math.max(120, b - a));
    const top = Math.round(a + Math.max(0, (b - a - h) / 2));
    list.style.maxHeight = `${Math.max(120, b - top)}px`;
    fixAt(list, Math.max(8, Math.round((vw - w) / 2)), top);
  }
  // A message below the list button (docked) or above the panel (floating), while the list is closed.
  let tipTimer = null;
  function showTip(text, ms) {
    clearTimeout(tipTimer);
    tip.textContent = text || '';
    tip.hidden = !text;
    if (!text) return;
    placeTip();
    if (ms) tipTimer = setTimeout(() => { tip.hidden = true; }, ms);
  }
  // Docked: below the list button. Floating: on the side of the panel with more room.
  function placeTip() {
    if (tip.hidden) return;
    if (docked) {
      const b = root.querySelector('.bar [data-act=list]').getBoundingClientRect();
      const w = tip.offsetWidth;
      fixAt(tip, Math.max(8, Math.min(innerWidth - w - 8, b.right - w)), b.bottom + 8);
    } else {
      const r = panel.getBoundingClientRect();
      Object.assign(tip.style, { left: '', top: '' });
      tip.classList.toggle('below', innerHeight - r.bottom > r.top);
    }
  }

  // The state of Play on the Play button, for the header (Julian, 1.14: no text in the bar, so the buttons do not move):
  // a ring that empties during the rate-limit pause (red) or the budget wait (light), and a badge for the slow speed.
  let ringTimer = 0;
  function updatePlayState() {
    const now = performance.now();
    const wait = pauseLeft();
    const bw = playing ? budgetWaitUntil - now : 0;
    let kind = '';
    let p = 0;
    if (wait > 0) {
      kind = 'limited';
      p = Math.min(1, wait / RATE_BACKOFF);
    } else if (bw > 0) {
      kind = 'waiting';
      p = Math.min(1, bw / Math.max(1, budgetWaitUntil - budgetWaitFrom));
    }
    playBtn.classList.toggle('limited', kind === 'limited');
    playBtn.classList.toggle('waiting', kind === 'waiting');
    playBtn.style.setProperty('--rp', p.toFixed(3));
    ringRect.setAttribute('stroke-dasharray', `${(p * 100).toFixed(2)} 100`);
    if (slowFactor > 1) playBtn.dataset.slow = `1/${slowFactor}`;
    else delete playBtn.dataset.slow;
    playBtn.title = (playing ? 'Pause (-)' : 'Play (-)')
      + (kind === 'limited' ? ` · QuantData rate limit: Play pauses ${Math.ceil(wait / 1000)} s` : kind === 'waiting' ? ' · Play waits for the request budget' : '')
      + (slowFactor > 1 ? ` · 1/${slowFactor} speed (open the list for full speed)` : '');
    clearTimeout(ringTimer);
    if (kind && docked) ringTimer = setTimeout(updatePlayState, 100); // A smooth ring between the refreshes.
  }

  // The budget in the list, always shown (Julian, 1.14): the free requests, a meter with the reserve, the cost of 1 step.
  function showBudget() {
    const cost = stepCost();
    const free = Math.max(0, Math.min(BUDGET_CAP, budgetNow()));
    bFree.textContent = String(Math.floor(free));
    bCost.textContent = `${cost} requests (${cost / 2} tool${cost === 2 ? '' : 's'} × 2)`;
    bBar.style.width = `${(free / BUDGET_CAP) * 100}%`;
    budgetInfo.classList.toggle('low', free < BUDGET_RESERVE + cost);
  }

  function openList(open) {
    list.hidden = !open;
    backdrop.hidden = !open;
    if (open) showTip('');
    if (open) {
      buildList();
      showBudget();
      placeList(); // after the content: its height places it in the middle
    } else {
      hideHighlight();
      msg.hidden = true; // An old message does not stay in the list.
      reportText.hidden = true;
      if (reportMode) {
        reportMode = false;
        reportBtn.classList.remove('on');
        document.removeEventListener('keydown', onReportKey, true);
        for (const t of SWALLOW) document.removeEventListener(t, swallow, true);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Zoom bars (QuantData chart zoom slider, for example Net Drift)
  // A zoom bar uses row indexes, 1 row per minute with data (missing minutes have no row).
  // The page bridge (below) reads the rows, their times and the tool name from the React data of the bar,
  // and sets a range with the bar's own onChangeEnd. If the bar has no onChangeEnd, a synthetic drag moves
  // the handles to the same rows. A bar without row times does not follow ("no data").
  // The left end goes to 09:30 ET only when you switch the bar on, after a page load, and on the RTH jump
  // to the start or the end. Else it stays where it is (also where you dragged it).
  // The right end is at the synced minute (the last row at or before it), so the chart never shows the future.
  // (Up to 1.12 it stayed 2 minutes behind, because a drag could not hit the exact minute. Julian, 2026-10-10: the exact minute fits.)
  // A mask covers the preview in the zoom bar after the right end (the preview shows the full day).
  // ---------------------------------------------------------------------------
  const hasToken = (el, re) => [...el.classList].some((c) => re.test(c));
  const ZOOM = (part) => new RegExp(`^QDChartZoomSlider-module__.*__${part}$`);

  // The page bridge (bridge.js) runs in the page world: the content-script world cannot see React data.
  // The extension loads it with "world": "MAIN", the userscript has it at the top of the file.

  // A call to the page bridge. DOM events run at once (also across the worlds), so the answer is there when dispatchEvent returns.
  let bridgeSeq = 0;
  let bridgeAnswer;
  document.addEventListener('qdts:res', (e) => {
    try {
      const r = JSON.parse(e.detail);
      if (r.id === bridgeSeq) bridgeAnswer = r.result;
    } catch { /* not for us */ }
  });
  function bridge(op, args) {
    bridgeAnswer = undefined;
    const id = ++bridgeSeq;
    document.dispatchEvent(new CustomEvent('qdts:req', { detail: JSON.stringify({ id, op, args }) }));
    return bridgeAnswer;
  }

  let zoomBars = [];                  // { root, k, tool, key, title, strike, info, status, applied, touched }
  let zoomSeq = 0;
  let zoomBusy = false;
  let zoomGen = 0; // +1 when a zoom setting changes: every zoom bar is set again
  const leftEt = new Map(); // bar key -> ET minute of the left end. Not set = 09:30 (after a page load).
  let zoomLeftReset = false; // RTH jump to the start or the end: all left ends go to 09:30
  let zoomResetWait = null;  // RTH jump in a tab with the same page: { at, et } until the time changes here
  let userPointerDown = false;
  let userDownTarget = null;
  // Your own zoom on a chart has priority until the next time change. Clicks on this panel do not count.
  function markTouched(e) {
    if (!e.isTrusted || e.composedPath().includes(host)) return false;
    for (const z of zoomBars) if (z.tool && z.tool.contains(e.target)) z.touched = true;
    return true;
  }
  window.addEventListener('pointerdown', (e) => {
    if (!markTouched(e)) return;
    userPointerDown = true;
    userDownTarget = e.target;
  }, true);
  window.addEventListener('pointerup', (e) => {
    if (!e.isTrusted) return;
    userPointerDown = false;
    userDownTarget = null;
  }, true);
  window.addEventListener('wheel', markTouched, { capture: true, passive: true });
  window.addEventListener('blur', () => { userPointerDown = false; userDownTarget = null; });
  // True while you hold the mouse button on this chart.
  const userOn = (z) => userPointerDown && !!z.tool && !!userDownTarget && z.tool.contains(userDownTarget);

  function toolOf(root) {
    let n = root.parentElement;
    while (n && !hasToken(n, /^QDToolLayout-module__.*__container$/)) n = n.parentElement;
    return n || root.closest('.flexlayout__tab') || root.parentElement;
  }

  // Name of a chart without the page bridge: the tab button ("Net Drift"), else the chart header, else the toolbar.
  function chartName(tool, root) {
    const tab = root.closest('[data-layout-path]');
    const path = tab && tab.getAttribute('data-layout-path');
    const btn = path ? document.querySelector(`[data-layout-path="${path.replace(/\/t(\d+)$/, '/tb$1')}"]`) : null;
    if (btn && btn.textContent.trim()) return btn.textContent.trim();
    const head = tool && [...tool.querySelectorAll('[class*="QDChartHeader-module__"]')].find((n) => hasToken(n, /^QDChartHeader-module__.*__title$/));
    if (head && head.textContent.trim()) return head.textContent.trim();
    return tool && tool.firstElementChild ? (tool.firstElementChild.textContent || '').trim().split('\n')[0].trim() : '';
  }

  function scanZoom() {
    const old = new Map(zoomBars.map((z) => [z.root, z]));
    // Not the copies of the freeze picture.
    const roots = [...document.querySelectorAll('[class*="QDChartZoomSlider-module__"]')].filter((n) => hasToken(n, ZOOM('root')) && !freezeBox.contains(n));
    for (const root of roots) if (!root.hasAttribute('data-qdts-bar')) root.setAttribute('data-qdts-bar', String(++zoomSeq));
    const answer = roots.length ? bridge('bars') : [];
    const infos = new Map((Array.isArray(answer) ? answer : []).map((b) => [b.k, b]));
    zoomBars = roots.map((root, i) => {
      const z = old.get(root) || { root, status: '', applied: null, touched: false };
      z.k = root.getAttribute('data-qdts-bar');
      if (!z.tool || !z.tool.isConnected) {
        z.tool = toolOf(root);
        z.fallbackName = chartName(z.tool, root); // Read once per tool: the page data gives the name in most cases.
      }
      z.info = infos.get(z.k) || null;
      const ok = z.info && z.info.ok;
      // A vertical bar (Interval Map, Exposure Forecast: the y axis) never follows the time. It has its own key: the
      // horizontal bar of the same tool has the key of the tool (REALSITE-1.md section 17).
      z.vertical = hasToken(root, /^QDChartZoomSlider-module__.*__rootVertical$/) || !!(ok && z.info.vertical);
      z.title = ((ok && z.info.name) || z.fallbackName || `Chart ${i + 1}`).slice(0, 40);
      const tab = root.closest('[data-layout-path]');
      z.key = (ok && z.info.toolId ? `tool:${z.info.toolId}` : `${location.pathname}|${tab ? tab.getAttribute('data-layout-path') : i}|${z.title}`) + (z.vertical ? '|v' : '');
      // A chart with its own time slider has a strike axis (Exposure by Strike). Never move its zoom bar.
      z.strike = !!z.tool && autoList.some((el) => z.tool.contains(el));
      return z;
    });
  }

  // On by default for every bar that is not a strike chart. A bar without row times does not move ("no data").
  const zoomOn = (z) => !z.strike && !z.vertical && (z.key in cfg.zoom ? !!cfg.zoom[z.key] : true);

  function zoomParts(root) {
    const all = [...root.querySelectorAll('*')];
    const inner = all.find((n) => hasToken(n, ZOOM('inner')));
    const handles = all.filter((n) => hasToken(n, ZOOM('handle')));
    if (!inner || handles.length !== 2) return null;
    const cx = (h) => {
      const b = h.getBoundingClientRect();
      return b.left + b.width / 2;
    };
    handles.sort((a, b) => cx(a) - cx(b));
    return { inner, left: handles[0], right: handles[1], cx };
  }

  // Drag 1 handle with synthetic pointer and mouse events. Wait between the events,
  // because the page can add its move listeners only after the next render.
  // Wait for n rendered frames (max 250 ms: a hidden tab renders no frames).
  const frames = (n) => new Promise((resolve) => {
    let i = 0;
    const done = setTimeout(resolve, 250);
    const tick = () => {
      if (++i >= n) {
        clearTimeout(done);
        resolve();
      } else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  function release(h, x, y) {
    if (userPointerDown) return; // You hold the mouse button: your drag runs, the page ends it at your release.
    mouse('pointerup', h, x, y, 0);
    mouse('mouseup', h, x, y, 0);
  }

  // While the panel drags a handle (about 0.1 s), your real mouse moves do not reach the page.
  // Else the handle follows your mouse for a moment instead of the panel.
  let synthDrag = false;
  const blockMove = (e) => {
    // If you hold the mouse button yourself, your moves pass: you take over.
    if (synthDrag && e.isTrusted && !userPointerDown) e.stopImmediatePropagation();
  };
  window.addEventListener('pointermove', blockMove, true);
  window.addEventListener('mousemove', blockMove, true);

  let dragSeq = 0;
  async function dragHandle(h, toX, slow = 1) {
    synthDrag = true;
    try {
      await dragHandleInner(h, toX, slow);
    } finally {
      synthDrag = false;
    }
  }
  async function dragHandleInner(h, toX, slow) {
    const my = ++dragSeq;
    const b = h.getBoundingClientRect();
    const x0 = b.left + b.width / 2;
    const y = b.top + b.height / 2;
    mouse('pointerdown', h, x0, y, 1);
    mouse('mousedown', h, x0, y, 1);
    // The page can add its move and up listeners only after the next render.
    await frames(2);
    await sleep(20 * slow);
    for (const f of [0.34, 0.67, 1]) {
      const x = x0 + (toX - x0) * f;
      mouse('pointermove', h, x, y, 1);
      mouse('mousemove', h, x, y, 1);
      await sleep(20 * slow);
    }
    await frames(1);
    release(h, toX, y);
    await frames(2);
    // If the page missed the first "up", the handle follows your real mouse. A second "up" ends the drag.
    release(h, toX, y);
    await sleep(20 * slow);
    // Late pages: 1 more "up" after 300 ms. Not if a new drag started since (it would end that drag),
    // and not while you hold the mouse button yourself.
    setTimeout(() => {
      if (dragSeq === my && !zoomBusy && !userPointerDown && h.isConnected) release(h, toX, y);
    }, 300);
  }

  // Fallback for a bar without onChangeEnd: drag the handles to the fractions fl and fr (row / (rows - 1)).
  // Stop at once when you take the mouse. One move per handle; no correction moves after it.
  async function dragBar(z, fl, fr, n) {
    let p = zoomParts(z.root);
    if (!p) return false;
    const ib = p.inner.getBoundingClientRect();
    if (ib.width < 20) return false;
    const lx = ib.left + fl * ib.width;
    const rx = ib.left + fr * ib.width;
    const atEnd = fr >= 1;
    const pxPerRow = ib.width / Math.max(1, n - 1);
    const moveHandle = async (which, x, dragTo, tolerance) => {
      if (userOn(z)) throw new Error('user');
      const pos = p.cx(p[which]);
      if (Math.abs(pos - x) < tolerance) return;
      await dragHandle(p[which], dragTo);
      p = zoomParts(z.root) || p;
      updateMasks(); // The mask follows the handle at once.
      if (Math.abs(p.cx(p[which]) - pos) < 0.05 && Math.abs(pos - x) > 1.5) {
        if (userOn(z)) throw new Error('user');
        await dragHandle(p[which], dragTo, 3);
        p = zoomParts(z.root) || p;
      }
    };
    const moveLeft = () => moveHandle('left', lx, fl <= 0 ? ib.left - 30 : lx, Math.min(1, pxPerRow / 2));
    const moveRight = () => moveHandle('right', rx, atEnd ? ib.right + 30 : rx, 0.3);
    // The left end must not pass the right end. Move the end that makes space first.
    if (lx > p.cx(p.right)) {
      await moveRight();
      await moveLeft();
    } else {
      await moveLeft();
      await moveRight();
    }
    if (userOn(z)) throw new Error('user');
    return true;
  }

  // You moved the left handle of this bar by hand (since the last sync): it stays there.
  function adoptLeft(z) {
    const info = z.info;
    if (z.touched && z.applied && info && info.value && info.vt && info.value[0] !== z.applied.l) leftEt.set(z.key, info.vt[0]);
  }

  async function syncZoom() {
    if (zoomBusy || working || !zoomBars.length) return;
    const ref = refSlider();
    if (!ref) return;
    const r = read(ref);
    if (!isTime(r)) return;
    const et = etOf(r);
    if (zoomResetWait && (et !== zoomResetWait.et || performance.now() - zoomResetWait.at > 3000)) {
      zoomResetWait = null;
      zoomLeftReset = true;
    }
    if (zoomLeftReset) {
      zoomLeftReset = false;
      leftEt.clear(); // The RTH jump is a time change: your own zoom goes, all left ends go to 09:30.
      for (const z of zoomBars) z.touched = false;
      zoomGen++;
    }
    const gen = zoomGen;
    zoomBusy = true;
    let cur = null;
    try {
      for (const z of zoomBars) {
        cur = z;
        if (!zoomOn(z) || !z.root.isConnected || userOn(z)) continue;
        const info = z.info;
        if (!info || !info.ok || !info.times) {
          z.status = 'no data';
          continue;
        }
        // The fallback drag waits while you hold the mouse button anywhere: else it would follow your mouse.
        if (!info.api && userPointerDown) continue;
        const a = z.applied;
        const fresh = !a || a.gen !== gen || a.et !== et;
        let left = leftEt.has(z.key) ? leftEt.get(z.key) : RTH_OPEN;
        if (!fresh) {
          // Same time: act only if QuantData moved the right end past the target (the chart shows the future).
          // Keep QuantData's left end. Max 1 repair per time change, and not within 5 s of the last one.
          if (z.touched || a.repaired || !info.value || !info.vt || info.value[1] <= a.r + (info.api ? 0 : 1)) continue;
          if (performance.now() - (z.repairAt ?? -Infinity) < 5000) continue;
          z.repairAt = performance.now();
          a.repaired = true;
          left = info.vt[0];
        } else {
          adoptLeft(z);
          if (leftEt.has(z.key)) left = leftEt.get(z.key);
        }
        z.touched = false;
        const rightEt = et;
        const res = bridge('set', { k: z.k, left, right: rightEt, apply: !!info.api });
        if (!res || !res.ok) {
          z.status = 'no data';
          continue;
        }
        if (res.how !== 'api' && !(await dragBar(z, res.fl, res.fr, res.n))) {
          z.status = 'no effect';
          continue;
        }
        if (!leftEt.has(z.key)) leftEt.set(z.key, RTH_OPEN);
        z.status = `${hhmm(res.lt)}–${hhmm(res.rt)}`;
        z.span = [res.lt, res.rt];
        // Save the targets: a later check compares the bar with the targets, not with a failed result.
        if (fresh) z.applied = { gen, et, l: res.l, r: res.r };
      }
    } catch (err) {
      // You took the mouse: keep your zoom until the next time change.
      if (err.message === 'user' && cur) {
        cur.touched = true;
        if (cur.applied) Object.assign(cur.applied, { et, gen });
        else cur.applied = { gen, et, l: -1, r: -1 };
      } else console.warn('[QD Toolkit] zoom', err);
    } finally {
      zoomBusy = false;
    }
    updateMasks();
    // QuantData draws the new handle positions in a later frame: move the masks again then.
    requestAnimationFrame(() => requestAnimationFrame(updateMasks));
    if (!list.hidden) updateListValues();
  }

  // Mask after the right end of each followed zoom bar: the preview there shows the future.
  const maskEls = [];
  function updateMasks() {
    let n = 0;
    for (const z of cfg.zoomMask ? zoomBars : []) {
      if (!zoomOn(z) || !z.applied || !z.root.isConnected) continue;
      const p = zoomParts(z.root);
      if (!p) continue;
      const ib = p.inner.getBoundingClientRect();
      const hb = p.right.getBoundingClientRect();
      const left = Math.max(ib.left, hb.right);
      const width = ib.right - left;
      if (width < 1 || ib.height < 2) continue;
      let m = maskEls[n];
      if (!m) {
        m = document.createElement('div');
        m.className = 'mask';
        masks.appendChild(m);
        maskEls.push(m);
      }
      Object.assign(m.style, { left: `${left}px`, top: `${ib.top}px`, width: `${width}px`, height: `${ib.height}px`, display: 'block' });
      n++;
    }
    for (let i = n; i < maskEls.length; i++) maskEls[i].style.display = 'none';
  }
  document.addEventListener('scroll', () => updateMasks(), { capture: true, passive: true });
  window.addEventListener('resize', () => { updateMasks(); drawBands(); });
  // The Infinite Page pans and zooms its plane with CSS transforms, without a scroll event. After each input that can
  // move it (wheel, drag, pinch, keys, a click that starts an animation), follow the bars in each frame for a short time.
  // Then the loop stops (no permanent frame loop).
  // The σ lines move with the plane by themselves (their canvas is next to the chart canvas). They must follow in each
  // frame only after an input on a chart with a strike bar (its zoom changes, and the linked charts follow). Other
  // input (keys in a text field, a click elsewhere): refresh() draws them (review of 0.17.0).
  let followUntil = 0;
  let followRaf = 0;
  let followSd = false;
  const onSdChart = (t) => t instanceof Node && zoomBars.some((z) => z.info && z.info.strikes && z.tool && z.tool.contains(t));
  function followFrame() {
    followRaf = 0;
    updateMasks();
    if (xPt && !xRaf) xRaf = requestAnimationFrame(drawXhair);
    if (followSd) drawBands();
    for (const t of [...freezes.keys()]) if (freezeMoved(t)) unfreeze(t);
    if (performance.now() < followUntil) followRaf = requestAnimationFrame(followFrame);
    else followSd = false;
  }
  function follow(ms, e) {
    if (onSdChart(e.target)) followSd = true;
    followUntil = Math.max(followUntil, performance.now() + ms);
    if (!followRaf) followRaf = requestAnimationFrame(followFrame);
  }
  for (const t of ['wheel', 'pointerdown', 'pointerup', 'keydown', 'gesturechange', 'touchmove']) {
    window.addEventListener(t, (e) => follow(t === 'pointerup' || t === 'keydown' ? 900 : 500, e), { capture: true, passive: true });
  }
  window.addEventListener('pointermove', (e) => { if (e.buttons) follow(500, e); }, { capture: true, passive: true });

  // ---------------------------------------------------------------------------
  // Linked strike charts (0.16, PLAN-0.16.md step 2)
  // The strike charts (Exposure by Strike: their bar rows are strikes) of the same ticker form 1 group. When you
  // zoom or scroll one of them (wheel, zoom bar), the others show the same strike range: the nearest rows in their
  // own strikes (the charts have different strike counts), set with the bar's own onChangeEnd (page bridge).
  // Our own changes do not start a new sync. When QuantData moves a chart of the group without your input (a data
  // refresh), it gets the group range again (max once in 2 s). The time sync never moves strike charts.
  // Ticker: the part of the chart title after the last " - ". No ticker: the group whose strikes overlap, else none.
  // ---------------------------------------------------------------------------
  const LINK_USER_MS = 1500; // a change within this time after your input on a chart is your change
  const LINK_REPAIR_MS = 2000;
  let linkGroups = new Map();  // group id -> { id, label, lo, hi, all: [zoom bar] }
  const linkRange = new Map(); // group id -> [lo, hi] strikes (cents) that you chose last
  // Per chart key (QuantData can render a zoom bar again as a new element): the range seen last, the range we set
  // last, and the time of the last repair.
  const linkSeen = new Map();
  const linkSet = new Map();
  const linkRepairAt = new Map();
  let userTool = null;         // the element of your last wheel / pointer input on the page, and its time
  let userAt = -Infinity;
  const linked = (z) => cfg.link[z.key] !== false;

  function tickerOf(tool) {
    const head = tool && [...tool.querySelectorAll('[class*="QDChartHeader-module__"]')].find((n) => hasToken(n, /^QDChartHeader-module__.*__title$/));
    const t = head ? head.textContent.trim() : '';
    const i = t.lastIndexOf(' - ');
    const x = i >= 0 ? t.slice(i + 3).trim().toUpperCase() : '';
    return /^[A-Z0-9.^$/]{1,12}$/.test(x) ? x : '';
  }

  function groupLinks() {
    const groups = new Map();
    const bars = zoomBars.filter((z) => z.info && z.info.ok && z.info.strikes && z.info.sr && z.root.isConnected);
    const add = (z, id, label) => {
      let g = groups.get(id);
      if (!g) groups.set(id, (g = { id, label, lo: Infinity, hi: -Infinity, all: [] }));
      g.all.push(z);
      g.lo = Math.min(g.lo, z.info.sr[0]);
      g.hi = Math.max(g.hi, z.info.sr[1]);
      z.gid = id;
    };
    for (const z of bars) {
      z.ticker = tickerOf(z.tool);
      z.gid = '';
      if (z.ticker) add(z, `t:${z.ticker}`, z.ticker);
    }
    for (const z of bars) {
      if (z.gid) continue;
      const [lo, hi] = z.info.sr;
      const g = [...groups.values()].find((x) => x.lo <= hi && lo <= x.hi);
      add(z, g ? g.id : `r:${z.key}`, g ? g.label : 'by strikes');
    }
    for (const z of zoomBars) if (!bars.includes(z)) z.gid = '';
    linkGroups = groups;
    keepLinkView(groups);
  }

  // The list keeps the strike charts while QuantData loads them (Julian, 2026-10-11): a step removes the header and the
  // zoom bar of each strike chart for its load, and the rows of "Linked strike charts" and the σ fields must not go away
  // or move for that time. A chart that is not on the page stays in the list while its tool is on the page (max 60 s;
  // it comes back after the load), else 3 s. The day of its date chip stays too (readSdAuto). A tool in a hidden tab
  // is not in the list (Julian, 2026-10-11; it stays in its group, so it has the range of the group when it shows).
  const VIEW_KEEP_MS = 60000;
  const VIEW_GONE_MS = 3000;
  const linkShown = new Map(); // chart key -> { key, title, gid, label, ticker, day, tool, at }
  const linkOrder = new Map(); // chart key -> place when seen first (a chart of a hidden tab keeps its place)
  function keepLinkView(groups) {
    const now = performance.now();
    const seen = new Set();
    for (const g of groups.values()) {
      for (const z of g.all) {
        if (!linkOrder.has(z.key)) linkOrder.set(z.key, linkOrder.size);
        if (z.tool && !shownEl(z.tool)) continue;
        const old = linkShown.get(z.key);
        linkShown.set(z.key, { key: z.key, title: z.title, gid: z.gid, label: g.label, ticker: sdTicker(z), day: old ? old.day : '', tool: z.tool, at: now });
        seen.add(z.key);
      }
    }
    for (const [k, e] of linkShown) {
      if (seen.has(k)) continue;
      const z = zoomBars.find((x) => x.key === k);
      const hidden = e.tool && e.tool.isConnected && !shownEl(e.tool);
      if ((z && timeBar(z)) || hidden || now - e.at > (e.tool && e.tool.isConnected ? VIEW_KEEP_MS : VIEW_GONE_MS)) linkShown.delete(k);
    }
  }
  // The list rows: by group, in the order the charts were seen first.
  function linkViewRows() {
    const all = [...linkShown.values()].sort((a, b) => linkOrder.get(a.key) - linkOrder.get(b.key));
    return [...new Set(all.map((e) => e.gid))].flatMap((gid) => all.filter((e) => e.gid === gid));
  }
  const barOf = (key) => zoomBars.find((z) => z.key === key) || null;

  // You changed this chart: you hold the mouse button on it, or your last wheel or pointer input was on it a moment ago.
  const userHolds = (z) => userPointerDown && !!z.tool && !!userDownTarget && z.tool.contains(userDownTarget);
  const userIn = (z) => userHolds(z) || (!!z.tool && !!userTool && z.tool.contains(userTool) && performance.now() - userAt < LINK_USER_MS);
  const same = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1];

  function linkApply(z, range) {
    const res = bridge('setStrikes', { k: z.k, lo: range[0], hi: range[1] });
    if (res && res.ok) linkSet.set(z.key, [res.lo, res.hi]);
    return !!(res && res.ok);
  }

  function linkCheck() {
    const now = performance.now();
    for (const g of linkGroups.values()) {
      const m = g.all.filter(linked);
      if (m.length < 2) {
        for (const z of g.all) linkSeen.set(z.key, z.info.sv);
        continue;
      }
      if (m.some(userHolds) || (linkLive && linkLive.gid === g.id)) continue; // You drag or wheel in the group: the live follow does it.
      let src = null;
      const moved = [];
      for (const z of m) {
        const cur = z.info.sv;
        const was = linkSeen.get(z.key);
        linkSeen.set(z.key, cur);
        if (!cur || !was || same(was, cur) || same(linkSet.get(z.key), cur)) continue; // no change, or our own change
        if (!src && userIn(z)) src = z;
        else moved.push(z);
      }
      if (src) {
        linkRange.set(g.id, src.info.sv);
        linkSet.delete(src.key);
        for (const z of m) if (z !== src) linkApply(z, src.info.sv);
      } else if (linkRange.has(g.id)) {
        for (const z of moved) {
          if (now - (linkRepairAt.get(z.key) ?? -Infinity) < LINK_REPAIR_MS) continue;
          linkRepairAt.set(z.key, now);
          linkApply(z, linkRange.get(g.id));
        }
      }
    }
  }
  // Live follow (Julian, 2026-10-10: "seamless"): while you drag or wheel in a chart of a group, read its range in
  // each frame and give the others the same strikes with their bar's onChange (at most once per frame). When you
  // release the button (or 250 ms after the last wheel event), each other chart gets the final range once with
  // onChangeEnd, so QuantData stores it. A chart without onChange follows only then. Never blocks your input.
  const LIVE_WHEEL_MS = 250;
  let linkLive = null; // { z, gid, last, wheelAt }
  function linkLiveStart(z, wheel) {
    if (linkLive && linkLive.z !== z) linkLiveEnd();
    if (!linkLive) {
      // The range before your input: this capture listener runs before the page's own handlers.
      const r = bridge('liveRange', { k: z.k });
      linkLive = { z, gid: z.gid, last: r && r.ok ? r.sv : null, wheelAt: 0, moved: false };
      requestAnimationFrame(linkLiveFrame);
    }
    if (wheel) linkLive.wheelAt = performance.now();
  }
  const linkLiveOthers = (L) => {
    const g = linkGroups.get(L.gid);
    return g && linked(L.z) ? g.all.filter((t) => t !== L.z && linked(t) && t.root.isConnected) : [];
  };
  function linkLiveFrame() {
    const L = linkLive;
    if (!L) return;
    const r = bridge('liveRange', { k: L.z.k });
    if (r && r.ok && !same(r.sv, L.last)) {
      L.last = r.sv;
      L.moved = true;
      for (const t of linkLiveOthers(L)) {
        const res = bridge('setStrikes', { k: t.k, lo: r.sv[0], hi: r.sv[1], live: true });
        if (res && res.ok) linkSet.set(t.key, [res.lo, res.hi]);
      }
    }
    if (userHolds(L.z) || performance.now() - L.wheelAt < LIVE_WHEEL_MS) requestAnimationFrame(linkLiveFrame);
    else linkLiveEnd();
  }
  function linkLiveEnd() {
    const L = linkLive;
    linkLive = null;
    if (!L) return;
    const r = bridge('liveRange', { k: L.z.k });
    if (!r || !r.ok || (!L.moved && same(r.sv, L.last))) return; // nothing changed (a click)
    linkRange.set(L.gid, r.sv);
    linkSeen.set(L.z.key, r.sv);
    linkSet.delete(L.z.key);
    for (const t of linkLiveOthers(L)) linkApply(t, r.sv);
  }
  function noteUser(e) {
    if (!e.isTrusted || e.composedPath().includes(host)) return;
    userTool = e.target;
    userAt = performance.now();
    if (e.type === 'pointerup') return;
    const z = zoomBars.find((x) => x.gid && linked(x) && x.tool && x.tool.contains(e.target));
    if (z) linkLiveStart(z, e.type === 'wheel');
  }
  for (const t of ['pointerdown', 'pointerup', 'wheel']) window.addEventListener(t, noteUser, { capture: true, passive: true });

  // The label of a list row (e: an entry of linkShown, so a chart that loads keeps its label).
  function linkLabel(e) {
    if (!linked(e)) return 'not linked';
    const n = [...linkShown.values()].filter((x) => x.gid === e.gid && linked(x)).length;
    return n > 1 ? `${e.label} · ${n} charts` : `${e.label} · alone`;
  }
  function buildLinkList() {
    lrows.innerHTML = '';
    const entries = linkViewRows();
    linkH.hidden = entries.length === 0;
    optXhair.checked = !!cfg.xhair;
    for (const e of entries) {
      const row = document.createElement('label');
      row.className = 'row';
      row.title = 'Linked charts show the same strike range when you zoom or scroll one of them.';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = linked(e);
      cb.addEventListener('change', () => {
        cfg.link = { ...cfg.link, [e.key]: cb.checked };
        saveCfg();
        linkSeen.delete(e.key);
        // Back in the group: show the range of the group at once.
        const z = barOf(e.key);
        if (cb.checked && z && z.gid && linkRange.has(z.gid)) linkApply(z, linkRange.get(z.gid));
        updateListValues();
      });
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = e.title;
      const val = document.createElement('span');
      val.className = 'val';
      row.append(cb, name, val);
      row.addEventListener('mouseenter', () => { const z = barOf(e.key); showHighlight(z ? z.root : e.tool); });
      row.addEventListener('mouseleave', hideHighlight);
      row._link = e.key;
      row._val = val;
      lrows.appendChild(row);
    }
  }

  // ---------------------------------------------------------------------------
  // Crosshair line (0.16, PLAN-0.16.md step 3)
  // When your mouse is over a chart, the other charts of the same kind show a dashed line at the same x value:
  // strike charts of the same group by strike, time charts (Net Drift, Stock Price / Time, VIX) by time.
  // Only a line and a label on the x axis: no events go to the other charts, so QuantData shows no tooltip there.
  // The plot area and the visible x range come from the renderer of each chart (page bridge). Passive listeners only.
  // ---------------------------------------------------------------------------
  const CHART_CANVAS = /^nativeChartSurface-module__.*__canvas$/;
  let chartSeq = 0;
  let xPt = null; // { x, y, el } of your last mouse move
  let xRaf = 0;
  const xEls = [];
  const isChart = (el) => el instanceof HTMLCanvasElement && hasToken(el, CHART_CANVAS) && !el.closest('#qd-time-sync-freeze');
  // The labels look like QuantData's own crosshair labels: the local time like its time axis ("5:25 PM"), the strike
  // in $ ("$7,520"; no decimals for a whole strike, else 2: "$754.50").
  const localFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
  function xText(kind, v) {
    if (kind === 'time') return localFmt.format(new Date(v));
    const d = Math.round(v) / 100;
    const whole = Number.isInteger(d);
    return '$' + d.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 });
  }
  function hideXhair() {
    for (const e of xEls) e.line.style.display = e.label.style.display = 'none';
  }
  // The other charts that can get a line: for a strike chart the charts of its group, for a time chart all others.
  function xPeers(src) {
    const tool = toolOf(src);
    const gidOf = (c) => (zoomBars.find((z) => z.gid && !z.vertical && z.tool && z.tool.contains(c)) || {}).gid || '';
    const gid = gidOf(src);
    const all = [...document.querySelectorAll('canvas[data-qdts-chart]')].filter((c) => c !== src && isChart(c) && !(tool && tool.contains(c)));
    const keys = (a) => a.map((c) => c.getAttribute('data-qdts-chart'));
    return { strikePeers: gid ? keys(all.filter((c) => gidOf(c) === gid)) : [], timePeers: keys(all) };
  }
  // The scale of a canvas on the screen (the Infinite Page scales its plane): the plot numbers are CSS px of the canvas.
  const scaleOf = (c, b) => b.width / (c.offsetWidth || b.width) || 1;
  function tagCharts() {
    for (const c of document.querySelectorAll('canvas[class*="nativeChartSurface-module__"]')) {
      if (isChart(c) && !c.hasAttribute('data-qdts-chart')) c.setAttribute('data-qdts-chart', String(++chartSeq));
    }
  }
  function drawXhair() {
    xRaf = 0;
    const pt = xPt;
    const src = pt && cfg.xhair && isChart(pt.el) && pt.el.isConnected ? pt.el : null;
    if (!src) return hideXhair();
    tagCharts();
    const sb = src.getBoundingClientRect();
    const ssc = scaleOf(src, sb);
    // The page bridge snaps the value under the mouse like QuantData (to a strike or a row time of this chart)
    // and gives the place in each other chart.
    const res = bridge('xhair', { k: src.getAttribute('data-qdts-chart'), lx: (pt.x - sb.left) / ssc, ly: (pt.y - sb.top) / ssc, ...xPeers(src) });
    if (!res || !res.ok) return hideXhair();
    let n = 0;
    for (const t of res.lines) {
      const c = document.querySelector(`canvas[data-qdts-chart="${t.k}"]`);
      if (!c) continue;
      const b = c.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      const sc = scaleOf(c, b);
      let e = xEls[n];
      if (!e) {
        e = { line: document.createElement('div'), label: document.createElement('div') };
        e.line.className = 'xline';
        e.label.className = 'xlabel';
        xhairBox.append(e.line, e.label);
        xEls.push(e);
      }
      const x = Math.round(b.left + t.x * sc); // a whole pixel column, like QuantData's crisp line
      Object.assign(e.line.style, { left: `${x}px`, top: `${b.top + t.top * sc}px`, width: `${sc}px`, height: `${(t.bottom - t.top) * sc}px`, display: 'block' });
      e.line.style.setProperty('--s', String(sc));
      e.label.textContent = xText(res.kind, t.v);
      Object.assign(e.label.style, { left: `${x + sc / 2}px`, top: `${b.top + (t.bottom + 2) * sc}px`, display: 'block' });
      e.label.style.setProperty('--s', String(sc));
      e.line.dataset.k = e.label.dataset.k = t.k;
      n++;
    }
    for (let i = n; i < xEls.length; i++) xEls[i].line.style.display = xEls[i].label.style.display = 'none';
  }
  window.addEventListener('pointermove', (e) => {
    if (!e.isTrusted) return;
    xPt = { x: e.clientX, y: e.clientY, el: e.target };
    if (!xRaf) xRaf = requestAnimationFrame(drawXhair);
  }, { capture: true, passive: true });
  window.addEventListener('pointerout', (e) => {
    if (e.isTrusted && !e.relatedTarget) {
      xPt = null;
      hideXhair();
    }
  }, { capture: true, passive: true });
  window.addEventListener('blur', () => { xPt = null; hideXhair(); });
  document.addEventListener('scroll', () => { if (xPt && !xRaf) xRaf = requestAnimationFrame(drawXhair); }, { capture: true, passive: true });

  // ---------------------------------------------------------------------------
  // Standard deviation lines (0.17)
  // The 15.87 rule (√252 = 15.87): 1σ of one session = prior close × prior-close VIX ÷ 15.87 %.
  // The values: a typed value in the list wins. Else the prior close of a ticker comes from its Net Drift chart (the
  // last row before 09:30 ET holds the official close of the day before; no request), else from a Stock Price / Time
  // chart that shows the day before (its last close). The VIX has no Net Drift: it needs a price chart of the day
  // before or a typed value. Each strike chart with a ticker shows dashed lines at prior close ±
  // each selected σ, drawn on 1 canvas per chart (a thin DOM line could vanish at some zoom levels in Safari), with
  // "+1σ" / "−1σ" above the strike axis. QuantData's own legend of the chart gets 2 items: "+1σ <price>", "−1σ <price>".
  // ---------------------------------------------------------------------------
  const SD_DAYS = 15.87;
  const SD_LEVELS = [1, 2, 3]; // Julian, 2026-10-11: only ±1σ, ±2σ, ±3σ (nobody uses 0.5, 1.2, 1.5)
  cfg.sd = { ...defaults.sd, ...cfg.sd };
  const sdStored = Array.isArray(cfg.sd.levels) ? cfg.sd.levels : defaults.sd.levels;
  cfg.sd.levels = sdStored.filter((k) => SD_LEVELS.includes(k));
  if (!cfg.sd.levels.length && sdStored.length) cfg.sd.levels = [...defaults.sd.levels]; // only old levels were stored
  // A typed value is for 1 day: the day of the strike charts when you typed it (Julian, 2026-10-11; before, a typed VIX
  // won over the correct automatic value on each later day). Stored as { v, day }. On another day the field is empty and
  // the automatic value counts; on its day again, your value comes back. A number of 0.17 gets the day of the charts at
  // the first read (day null until then).
  const sdTypedOf = (x) => (typeof x === 'number' && x > 0 ? { v: x, day: null } : x && typeof x === 'object' && x.v > 0 ? x : null);
  cfg.sd.vix = sdTypedOf(cfg.sd.vix);
  cfg.sd.close = Object.fromEntries(Object.entries(cfg.sd.close || {}).map(([t, x]) => [t, sdTypedOf(x)]).filter(([, x]) => x));
  // Indexes: the official close is the last value of the day (the closing auction prints come after 16:00), and before
  // 09:30 there is no trade (Net Drift shows the prior close). ETFs and stocks trade before and after the session: their
  // prior close is the 16:00 close of a price chart.
  const SD_INDEX = /^(SPX|SPXW|XSP|NDX|NDXP|XND|RUT|MRUT|DJX|OEX|XEO|VIX|VIX9D|VIX1D)$/;
  let sdAuto = { vix: null, close: {}, from: {} }; // automatic values (Net Drift, Cboe, a price chart of the day before)
  let sdAutoAt = -Infinity;
  let sdAutoDay = ''; // the day of the strike charts that sdAuto is for
  // A typed number. A comma with 1 or 2 digits after it, or after a dot, is a decimal comma (a German keyboard: "15,87",
  // "7.765,43"); else a comma groups thousands ("6,400", "7,765.43").
  const sdNum = (t) => {
    let s = String(t).replace(/[$\s]/g, '');
    const c = s.lastIndexOf(',');
    const d = s.lastIndexOf('.');
    if (c > d && (d >= 0 || /^\d{1,2}$/.test(s.slice(c + 1)))) s = `${s.slice(0, c).replace(/[.,]/g, '')}.${s.slice(c + 1)}`;
    else s = s.replace(/,/g, '');
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  // The ticker of a strike chart: from its title, else from its group (a chart without a ticker in a ticker group).
  const sdTicker = (z) => z.ticker || (z.gid && z.gid.startsWith('t:') ? z.gid.slice(2) : '');
  // From linkShown: a strike chart that loads after a step keeps its ticker in the list.
  const sdTickers = () => [...new Set([...linkShown.values()].map((e) => e.ticker).filter(Boolean))].sort();
  // The day of the strike charts (their date chips, read with the automatic values), else today (ET).
  const sdDayNow = () => sdAutoDay || etDay.format(new Date());
  const sdTyped = (x) => (x && x.day === sdDayNow() ? x.v : null);
  const sdVix = () => sdTyped(cfg.sd.vix) || sdAuto.vix;
  const sdClose = (t) => sdTyped(cfg.sd.close[t]) || sdAuto.close[t] || null;
  const sdSigma = (t) => (sdVix() && sdClose(t) ? (sdClose(t) * sdVix()) / SD_DAYS / 100 : null);
  const usd = (v) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const lvText = (k) => `${k}σ`;

  // The day of a tool: its date chip ("Oct 9, 2026") as YYYY-MM-DD.
  const DATE_CHIP = /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/;
  function toolDay(tool) {
    for (const el of tool ? tool.querySelectorAll('*') : []) {
      if (el.children.length) continue;
      const t = (el.textContent || '').trim();
      if (!DATE_CHIP.test(t)) continue;
      const d = new Date(`${t} 12:00`);
      if (!isNaN(d)) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    return '';
  }
  // The prior-close VIX from the optional helper "QD Toolkit Data" (a 2nd userscript; it loads the daily VIX history of
  // Cboe with GM.xmlHttpRequest, no QuantData request). DOM events with JSON strings: "qdts:data-req" / "qdts:data-res".
  const vixByDay = new Map(); // day -> { close, prev } | null (no value)
  const vixAsked = new Map(); // day -> time of the last request
  // The weekday before a day ("2026-10-12" -> "2026-10-09"). Holidays are not known: the close of the session before a
  // holiday looks old, so the panel asks again (max every 15 min) and uses the value meanwhile.
  function prevWeekday(day) {
    const d = new Date(`${day}T12:00:00Z`);
    do d.setUTCDate(d.getUTCDate() - 1); while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
    return d.toISOString().slice(0, 10);
  }
  let dataHelper = false;
  let dataSeq = 0;
  document.addEventListener('qdts:data-ready', () => {
    dataHelper = true;
    vixAsked.clear();
    sdAutoAt = -Infinity;
  });
  document.addEventListener('qdts:data-res', (e) => {
    let r;
    try {
      r = JSON.parse(e.detail);
    } catch {
      return;
    }
    if (!r || r.op !== 'vixClose' || !r.day) return;
    if (r.error) {
      console.warn('[QD Toolkit] QD Toolkit Data:', r.error);
      return; // ask again after the wait below
    }
    vixByDay.set(r.day, r.close > 0 ? { close: r.close, prev: r.prev } : null);
    sdAutoAt = -Infinity;
  });
  document.dispatchEvent(new CustomEvent('qdts:data-ping'));
  const etDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  function askVix(day) {
    if (!dataHelper || !day) return;
    const known = vixByDay.get(day);
    if (known && known.prev >= prevWeekday(day)) return; // the close of the session before: done
    // No answer yet: ask again after 1 min (an error). An old close or no close (Cboe adds a day after the close): 15 min.
    if (performance.now() - (vixAsked.get(day) ?? -Infinity) < (vixByDay.has(day) ? 15 * 60000 : 60000)) return;
    vixAsked.set(day, performance.now());
    document.dispatchEvent(new CustomEvent('qdts:data-req', { detail: JSON.stringify({ id: ++dataSeq, op: 'vixClose', day }) }));
  }

  // Read the prior-day closes from the price charts (max every 2 s). A price chart counts when its candles are of a day
  // before the day of the strike charts (the latest such day per ticker), max 4 days before (a weekend and a holiday):
  // an older chart (for example a VIX chart left on an old day) does not count, and the field stays empty to type.
  const SD_MAX_DAYS = 4;
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000); // 'YYYY-MM-DD'
  // The day of the strike charts: their date chips. While a chart loads after a step, QuantData removes its header and
  // its date chip: then the day seen last counts (linkShown). Before (2026-10-11), the day was empty during the load:
  // the VIX of today and a price chart of the same day counted, and the VIX field showed a wrong value for a moment.
  function readSdAuto() {
    if (performance.now() - sdAutoAt < 2000) return;
    if (!sdTickers().length || (!cfg.sd.on && list.hidden)) return; // nothing shows the values: no page work
    sdAutoAt = performance.now();
    for (const z of zoomBars) {
      const e = z.info && z.info.strikes ? linkShown.get(z.key) : null;
      const d = e && toolDay(z.tool);
      if (d) e.day = d;
    }
    const days = [...linkShown.values()].map((e) => e.day).filter(Boolean).sort();
    const day = days[days.length - 1] || '';
    const pday = day || etDay.format(new Date()); // no date chip: only price charts before today
    tagCharts();
    const res = bridge('candles');
    const out = { vix: null, close: {}, from: {} };
    const best = {};
    for (const c of Array.isArray(res) ? res : []) {
      const el = document.querySelector(`canvas[data-qdts-chart="${c.k}"]`);
      const tk = el && tickerOf(toolOf(el));
      if (!tk || !c.day || c.day >= pday || daysBetween(c.day, pday) > SD_MAX_DAYS) continue;
      if (best[tk] && best[tk].day >= c.day) continue;
      best[tk] = c;
    }
    for (const [tk, c] of Object.entries(best)) {
      const v = (SD_INDEX.test(tk) ? c.last : c.close16) / 100; // an index: the last value of the day
      if (!(v > 0)) continue;
      if (tk === 'VIX') out.vix = v;
      else out.close[tk] = v;
      out.from[tk] = c.day;
    }
    // Net Drift of the same day: the last price before 09:30 ET is the prior close (it wins over a price chart).
    const pre = bridge('preClose', { ks: zoomBars.filter(timeBar).map((z) => z.k) });
    for (const r of Array.isArray(pre) ? pre : []) {
      const z = zoomBars.find((x) => x.k === r.k);
      const tk = z && tickerOf(z.tool);
      if (!tk || tk === 'VIX' || !SD_INDEX.test(tk) || !(r.cents > 0) || (day && r.day !== day)) continue;
      out.close[tk] = r.cents / 100;
      out.from[tk] = `Net Drift ${r.day}`;
    }
    // VIX from Cboe (QD Toolkit Data): the day of the strike charts, else today (ET). It wins over a price chart.
    const vday = day || etDay.format(new Date());
    askVix(vday);
    const vx = vixByDay.get(vday);
    if (vx) {
      out.vix = vx.close;
      out.from.VIX = `Cboe ${vx.prev}`;
    }
    // The same day: a value that is not readable for a moment (a chart renders again) stays.
    if (day && day === sdAutoDay) {
      if (out.vix == null && sdAuto.vix != null) {
        out.vix = sdAuto.vix;
        out.from.VIX = sdAuto.from.VIX;
      }
      for (const [tk, v] of Object.entries(sdAuto.close)) {
        if (out.close[tk] != null) continue;
        out.close[tk] = v;
        out.from[tk] = sdAuto.from[tk];
      }
    }
    const changed = JSON.stringify(out) !== JSON.stringify(sdAuto) || day !== sdAutoDay;
    sdAutoDay = day;
    // A typed value of 0.17 (no day yet): it is for the day of the charts now.
    const old = [cfg.sd.vix, ...Object.values(cfg.sd.close)].filter((x) => x && x.day === null);
    for (const x of old) x.day = sdDayNow();
    if (old.length) saveCfg();
    sdAuto = out;
    if (changed && !list.hidden) buildSdList();
  }

  // The fields are built again only when the tickers change. A new automatic value changes only the grey placeholder,
  // so the list keeps its size and a field that you type in keeps its focus (Julian, 2026-10-11).
  const sdFields = new Map(); // 'vix' | 'close:<ticker>' -> { span, inp }
  let sdFieldKeys = '';
  function sdFieldOf(k) {
    const t = k === 'vix' ? 'VIX' : k.slice(6);
    return k === 'vix'
      ? { label: 'VIX prior close', typed: sdTyped(cfg.sd.vix), auto: sdAuto.vix, from: sdAuto.from.VIX, set: (v) => { cfg.sd.vix = v; } }
      : { label: `${t} prior close`, typed: sdTyped(cfg.sd.close[t]), auto: sdAuto.close[t], from: sdAuto.from[t], set: (v) => { cfg.sd.close = { ...cfg.sd.close, [t]: v }; } };
  }
  function buildSdList() {
    const tickers = sdTickers();
    sdSec.hidden = tickers.length === 0;
    optSd.checked = !!cfg.sd.on;
    const keys = ['vix', ...tickers.map((t) => `close:${t}`)];
    if (keys.join(',') !== sdFieldKeys) {
      sdFieldKeys = keys.join(',');
      sdIn.innerHTML = '';
      sdFields.clear();
      for (const k of keys) {
        const span = document.createElement('span');
        span.textContent = sdFieldOf(k).label;
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.inputMode = 'decimal';
        inp.spellcheck = false;
        inp.autocomplete = 'off';
        inp.dataset.k = k;
        const typed = sdFieldOf(k).typed;
        inp.value = typed ? String(typed) : '';
        inp.addEventListener('input', () => {
          const v = sdNum(inp.value);
          sdFieldOf(k).set(v ? { v, day: sdDayNow() } : null);
          saveCfg();
          updateSdOut();
          drawBands();
        });
        sdIn.append(span, inp);
        sdFields.set(k, { span, inp });
      }
    }
    for (const [k, { span, inp }] of sdFields) {
      const f = sdFieldOf(k);
      const tip = f.auto ? `Read from ${/^(Net|Cboe)/.test(f.from || '') ? f.from : `the price chart of ${f.from}`}. Type a value to use your own.` : '';
      if (span.title !== tip) span.title = tip;
      const ph = f.auto ? usd(f.auto) : '–';
      if (inp.placeholder !== ph) inp.placeholder = ph;
      if (root.activeElement !== inp) {
        const v = f.typed ? String(f.typed) : '';
        if (sdNum(inp.value) !== (f.typed || null)) inp.value = v;
      }
    }
    if (!sdLv.children.length) {
      for (const k of SD_LEVELS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = `±${lvText(k)}`;
        b.dataset.lv = String(k);
        b.addEventListener('click', () => {
          const on = !cfg.sd.levels.includes(k);
          cfg.sd = { ...cfg.sd, levels: on ? [...cfg.sd.levels, k].sort((a, c) => a - c) : cfg.sd.levels.filter((x) => x !== k) };
          b.classList.toggle('on', on);
          saveCfg();
          drawBands();
        });
        sdLv.append(b);
      }
      // "i": shows the values of ±1σ, ±2σ and ±3σ (Julian, 2026-10-11: below the levels, only when you want them).
      const info = document.createElement('button');
      info.type = 'button';
      info.className = 'sd-info';
      info.textContent = 'i';
      info.title = 'Show the values of ±1σ, ±2σ and ±3σ';
      info.addEventListener('click', () => {
        cfg.sd = { ...cfg.sd, info: !cfg.sd.info };
        saveCfg();
        updateSdOut();
      });
      sdLv.append(info);
    }
    for (const b of sdLv.querySelectorAll('button[data-lv]')) b.classList.toggle('on', cfg.sd.levels.includes(Number(b.dataset.lv)));
    buildSdCharts();
    updateSdOut();
  }
  // The charts with σ lines (Julian, 2026-10-11: not on every strike chart): 1 row per strike chart with a ticker (also
  // the Interval Map). Off = cfg.sd.charts[bar key] false. Built again only when the charts change (linkShown).
  let sdChartKeys = '';
  function buildSdCharts() {
    const chs = linkViewRows().filter((e) => e.ticker);
    const keys = chs.map((e) => `${e.key}|${e.title}`).join(',');
    if (keys !== sdChartKeys) {
      sdChartKeys = keys;
      sdCh.innerHTML = '';
      if (chs.length) {
        const h = document.createElement('div');
        h.className = 'sd-ch-h';
        h.textContent = 'Charts with σ lines';
        sdCh.append(h);
      }
      for (const e of chs) {
        const row = document.createElement('label');
        row.className = 'row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.addEventListener('change', () => {
          const charts = { ...cfg.sd.charts };
          if (cb.checked) delete charts[e.key];
          else charts[e.key] = false;
          cfg.sd = { ...cfg.sd, charts };
          saveCfg();
          drawBands();
        });
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = e.title;
        const val = document.createElement('span');
        val.className = 'val';
        val.textContent = e.ticker;
        row.append(cb, name, val);
        row.addEventListener('mouseenter', () => { const z = barOf(e.key); showHighlight(z ? z.root : e.tool); });
        row.addEventListener('mouseleave', hideHighlight);
        row._sd = e.key;
        sdCh.append(row);
      }
    }
    for (const row of sdCh.querySelectorAll('.row')) row.querySelector('input').checked = cfg.sd.charts[row._sd] !== false;
  }
  // The values of each level per ticker: "1σ  ±63.99  6,335.01 – 6,462.99". Built again only when a text changes.
  let sdOutSig = '';
  function updateSdOut() {
    const open = !!cfg.sd.info;
    const info = sdLv.querySelector('.sd-info');
    if (info) {
      info.classList.toggle('on', open);
      info.setAttribute('aria-expanded', String(open));
    }
    sdOut.hidden = !open;
    if (!open) return;
    const rows = sdTickers().map((t) => {
      const sg = sdSigma(t);
      const P = sdClose(t);
      return sg
        ? [t, usd(P), ...SD_LEVELS.map((k) => [lvText(k), `±${usd(k * sg)}`, `${usd(P - k * sg)} – ${usd(P + k * sg)}`])]
        : [t, null];
    });
    const sig = JSON.stringify(rows);
    if (sig === sdOutSig) return;
    sdOutSig = sig;
    sdOut.textContent = '';
    const span = (text, cls) => {
      const s = document.createElement('span');
      s.textContent = text;
      if (cls) s.className = cls;
      return s;
    };
    for (const [t, P, ...lv] of rows) {
      const head = document.createElement('div');
      head.className = 'sd-t';
      head.append(span(t), span(P ? `prior close ${P}` : 'type the prior close and the VIX', 'sd-p'));
      sdOut.append(head);
      for (const cells of lv) {
        const r = document.createElement('div');
        r.className = 'sd-r';
        r.dataset.lv = cells[0];
        r.append(...cells.map((c) => span(c)));
        sdOut.append(r);
      }
    }
  }
  optSd.addEventListener('change', () => {
    cfg.sd = { ...cfg.sd, on: optSd.checked };
    saveCfg();
    drawBands();
  });

  // QuantData's legend of a chart: the item of its last bullet ("•"). Our items are copies of it with our text.
  function legendItem(tool) {
    const head = [...tool.querySelectorAll('[class*="QDChartHeader-module__"]')].find((h) => hasToken(h, /__chartHeader$/)) || tool;
    const walk = document.createTreeWalker(head, NodeFilter.SHOW_TEXT);
    let last = null;
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (n.nodeValue.trim() === '•' && !n.parentElement.closest('[data-qdts-sd]')) last = n;
    }
    if (!last) return null;
    let item = last.parentElement;
    while (item && item !== head && item.textContent.trim() === '•') item = item.parentElement;
    return item && item !== head ? item : null;
  }
  // The σ items in QuantData's legend: copies of its last item, so they look like QuantData's own. All selected levels:
  // "+1σ <price>", "−1σ <price>", "+2σ …". They go into the legend row when they fit (Julian, 2026-10-11: no 2nd row
  // for ±1σ); else into a 2nd row (a copy of the legend container). Built again when the texts or the width change.
  const sdLegendState = new WeakMap(); // tool -> { sig, nodes }
  function sdItem(item, text) {
    const c = item.cloneNode(true);
    c.dataset.qdtsSd = text;
    const walk = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
    let done = false;
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (n.nodeValue.trim() === '•') {
        if (n.parentElement !== c) n.parentElement.style.color = 'rgba(255, 255, 255, 0.85)';
      } else if (n.nodeValue.trim()) {
        n.nodeValue = done ? '' : text;
        done = true;
      }
    }
    if (!done) c.append(text);
    // Never cut: QuantData's items shrink and end with "…" when the row is full (Julian, 2026-10-11: with 3 levels the
    // values could not be read). Our copies keep their full width; a row without room moves them into the 2nd row.
    Object.assign(c.style, { flex: 'none', minWidth: 'max-content' });
    for (const e of c.querySelectorAll('*')) Object.assign(e.style, { maxWidth: 'none', overflow: 'visible', textOverflow: 'clip' });
    return c;
  }
  // An item that does not show its full text ("…"), or text that does not fit.
  const cutIn = (el) => [el, ...el.querySelectorAll('*')].some((e) => e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1);
  function setLegend(z, texts) {
    const st = sdLegendState.get(z.tool);
    const clear = () => {
      for (const e of z.tool.querySelectorAll('[data-qdts-sd], [data-qdts-sdrow]')) e.remove();
      sdLegendState.delete(z.tool);
    };
    if (!texts || !texts.length) {
      if (st || z.tool.querySelector('[data-qdts-sd]')) clear();
      return;
    }
    const item = legendItem(z.tool);
    if (!item) return;
    const box = item.parentElement;
    const own = box && !box.querySelector('[class*="__title"]') && !hasToken(box, /__chartHeader$/);
    const sig = `${texts.join('|')}@${own ? Math.round(box.clientWidth) : 0}`;
    if (st && st.sig === sig && st.nodes.every((n) => n.isConnected) && st.nodes[0].previousElementSibling) return;
    clear();
    if (!own) {
      // No own legend container: the items after the last item.
      let after = item;
      const nodes = texts.map((t) => sdItem(item, t));
      for (const n of nodes) {
        after.after(n);
        after = n;
      }
      sdLegendState.set(z.tool, { sig, nodes });
      return;
    }
    // In the legend row, if it fits (no wrap, no overflow).
    let after = item;
    const inline = texts.map((t) => sdItem(item, t));
    for (const n of inline) {
      after.after(n);
      after = n;
    }
    const top = item.offsetTop;
    // It fits: no overflow, 1 line, and no item cut (also none of QuantData's own: they would shrink for ours).
    const fits = box.scrollWidth <= box.clientWidth + 1 && inline.every((n) => n.offsetTop === top) && ![...box.children].some(cutIn);
    if (fits) {
      sdLegendState.set(z.tool, { sig, nodes: inline });
      return;
    }
    for (const n of inline) n.remove();
    const row = box.cloneNode(false);
    row.removeAttribute('id');
    row.dataset.qdtsSdrow = texts.join('|');
    // The 2nd row wraps when it has no room (narrow chart, 3 levels): more lines, never "…".
    Object.assign(row.style, { flexWrap: 'wrap', overflow: 'visible', whiteSpace: 'normal', height: 'auto', maxHeight: 'none', rowGap: '2px' });
    for (const t of texts) row.append(sdItem(item, t));
    box.after(row);
    sdLegendState.set(z.tool, { sig, nodes: [row] });
  }

  // The σ canvas of a chart: in the page, next to QuantData's chart canvas and before its overlay canvas (the crosshair
  // and the tooltip), so QuantData's crosshair and tooltip stay above the σ lines. Positioned in the coordinates of
  // the chart canvas: a scaled plane (Infinite Page) scales it too.
  const sdCanvasOf = new WeakMap(); // chart canvas -> σ canvas
  const sdShown = new Set();
  function sdCanvas(c) {
    let cv = sdCanvasOf.get(c);
    if (!cv || !cv.isConnected || cv.previousElementSibling !== c) {
      if (cv) cv.remove();
      cv = document.createElement('canvas');
      cv.className = 'qdts-sd';
      cv.setAttribute('aria-hidden', 'true');
      cv.style.cssText = 'position:absolute;pointer-events:none;margin:0;padding:0;border:0;';
      c.after(cv);
      sdCanvasOf.set(c, cv);
    }
    cv._chart = c;
    return cv;
  }
  // A step loads the strike charts: QuantData removes the header and the zoom bar, gives the chart canvas the height of
  // its placeholder and other layout values. Meanwhile the σ canvas stays as it is (no hide, no redraw with the loading
  // layout; Julian, 2026-10-11: no blink, no wrong places, no label jump). Only in the normal refresh (400 ms) and with
  // cheap checks: no frame loop (a frame loop in 1945e7b made the page lag and the charts load 4-5 times slower).
  const SD_KEEP_MS = 3000; // a load takes about 0.5-1.5 s; a chart in a hidden tab can stay without its zoom bar
  const sdToolLoading = (tool) => !!tool && (!!tool.querySelector('[class*="QDChartLoadingPlaceholder-module__"]')
    || !tool.querySelector('[class*="QDChartZoomSlider-module__"]'));
  function sdKeep(cv, c) {
    if (!cfg.sd.on || !cv || !cv.isConnected || !c || !c.isConnected || !c.getClientRects().length || !sdToolLoading(toolOf(c))) {
      if (cv) cv._keepSince = 0;
      return false;
    }
    const now = performance.now();
    if (!cv._keepSince) cv._keepSince = now;
    if (now - cv._keepSince >= SD_KEEP_MS) return false;
    sdWatch();
    return true;
  }
  // While a chart loads: every 50 ms 2 cheap queries per loading chart. When its zoom bar is back, 1 full pass at once
  // (find the bar, the group range, draw), not at the next refresh (400 ms): else the old lines do not fit the new
  // chart for a moment. No work in the other frames.
  let sdWatchTimer = 0;
  function sdWatch() {
    if (sdWatchTimer) return;
    sdWatchTimer = setTimeout(function tick() {
      sdWatchTimer = 0;
      let loading = false;
      let ended = false;
      for (const cv of sdShown) {
        if (!cv._keepSince) continue;
        if (performance.now() - cv._keepSince >= SD_KEEP_MS) ended = true;
        else if (cv._chart && cv._chart.isConnected && sdToolLoading(toolOf(cv._chart))) loading = true;
        else ended = true;
      }
      if (ended) drawBands(); // reads the charts again (sdLoadEnded) and calls sdWatch() while other charts still load
      else if (loading) {
        sdWatchTimer = setTimeout(tick, 50);
      }
    }, 50);
  }
  const cssVar = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  let sdColors = null;
  let sdColorsAt = -Infinity;
  function sdColorsNow() {
    if (!sdColors || performance.now() - sdColorsAt > 2000) {
      sdColors = { primary: cssVar('--qd-themeColor-primary', 'hsl(201, 99%, 50%)'), bg: cssVar('--qd-themeColor-background', 'hsl(201, 99%, 4.65%)'),
        text: cssVar('--qd-themeColor-primaryText', '#ffffff') };
      sdColorsAt = performance.now();
    }
    return sdColors;
  }
  // A label like QuantData's crosshair label: primary ground, white semibold 11 px, radius 3, padding 2 / 6, 18 px high,
  // a soft shadow in the background color. u = device px per CSS px of the chart.
  function sdLabel(g, text, X, bottom, u, colors, left = false) {
    g.font = `600 ${11 * u}px interVariableFont, Inter, -apple-system, system-ui, sans-serif`;
    const w = g.measureText(text).width + 12 * u;
    const h = 18 * u;
    const x = Math.round(left ? X : X - w / 2); // left: the box starts at X (a horizontal line)
    const y = Math.round(bottom - h);
    g.save();
    g.shadowColor = colors.bg;
    g.shadowOffsetX = u;
    g.shadowOffsetY = u;
    g.shadowBlur = 2 * u;
    g.fillStyle = colors.primary;
    g.beginPath();
    if (g.roundRect) g.roundRect(x, y, w, h, 3 * u);
    else g.rect(x, y, w, h);
    g.fill();
    g.fillStyle = colors.text;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, x + w / 2, y + h / 2 + 0.5 * u);
    g.restore();
  }
  let sdErrorShown = false;
  function drawBands() {
    try {
      drawBandsNow();
    } catch (err) {
      if (!sdErrorShown) console.warn('[QD Toolkit] σ lines', err);
      sdErrorShown = true;
    }
  }
  // A kept chart finished its load: read the zoom bars, the groups and the group range again before drawing (the list
  // of the last refresh is from the load, without this chart's zoom bar). Once per load.
  function sdLoadEnded() {
    for (const cv of sdShown) {
      if (cv._keepSince && cv._chart && cv._chart.isConnected && !sdToolLoading(toolOf(cv._chart))) return true;
    }
    return false;
  }
  function drawBandsNow() {
    if (sdLoadEnded()) {
      scanZoom();
      groupLinks();
      linkCheck();
    }
    readSdAuto();
    const shown = new Set();
    // Strike charts (strikes on the x axis: vertical lines) and the Interval Map (its vertical bar: strikes on the y axis,
    // horizontal lines; Julian, 2026-10-11). A chart can be switched off in the list (cfg.sd.charts, by bar key).
    const strike = zoomBars.filter((z) => z.info && z.info.strikes && z.tool && z.tool.isConnected);
    const bars = cfg.sd.on ? strike.filter((z) => sdTicker(z) && sdSigma(sdTicker(z)) && cfg.sd.charts[z.key] !== false) : [];
    for (const z of strike) if (!bars.includes(z)) setLegend(z, null);
    if (bars.length) {
      tagCharts();
      const infos = bridge('charts');
      const by = new Map((Array.isArray(infos) ? infos : []).filter((i) => i.ok).map((i) => [i.k, i]));
      const dpr = devicePixelRatio || 1;
      const colors = sdColorsNow();
      const levels = [...cfg.sd.levels].sort((a, c) => a - c);
      for (const z of bars) {
        const tk = sdTicker(z);
        const P = sdClose(tk);
        const sg = sdSigma(tk);
        setLegend(z, levels.flatMap((k) => [`+${lvText(k)} ${usd(P + k * sg)}`, `−${lvText(k)} ${usd(P - k * sg)}`]));
        for (const c of z.tool.querySelectorAll('canvas[data-qdts-chart]')) {
          const t = by.get(c.getAttribute('data-qdts-chart'));
          // The axis of the strikes: x on a strike chart, y on the Interval Map (its vertical bar).
          const horiz = z.vertical;
          if (!t || !isChart(c) || (horiz ? !(t.yMax > t.yMin) : t.kind !== 'strike' || t.xMax <= t.xMin)) continue;
          const sMin = horiz ? t.yMin : t.xMin;
          const sMax = horiz ? t.yMax : t.xMax;
          const old = sdCanvasOf.get(c);
          if (old && sdShown.has(old) && sdKeep(old, c)) {
            shown.add(old); // loading: keep the last picture
            continue;
          }
          const b = c.getBoundingClientRect();
          if (!b.width || !b.height) continue;
          const sc = scaleOf(c, b);
          const [tl, tr, tt, tb] = t.plot;
          const w = tr - tl; // CSS px of the chart canvas (before the scale of the plane)
          const h = tb - tt;
          if (w < 2 || h < 2) continue;
          const cv = sdCanvas(c);
          const u = dpr * sc; // device px per CSS px of the chart
          const W = Math.round(w * u);
          const H = Math.round(h * u);
          if (cv.width !== W) cv.width = W;
          if (cv.height !== H) cv.height = H;
          const pos = `${c.offsetLeft + tl}|${c.offsetTop + tt}|${w}|${h}`;
          if (cv._pos !== pos || cv.style.display !== 'block') {
            cv._pos = pos;
            Object.assign(cv.style, { left: `${c.offsetLeft + tl}px`, top: `${c.offsetTop + tt}px`, width: `${w}px`, height: `${h}px`, display: 'block' });
          }
          cv._keepSince = 0;
          const g = cv.getContext('2d');
          // Draw only when something changed (the follow loop after a wheel or a key calls this in each frame).
          const sig = JSON.stringify([horiz, sMin, sMax, W, H, P, sg, levels, colors]);
          const same = cv._sig === sig && cv.width === W;
          cv._sig = sig;
          if (!same) g.clearRect(0, 0, W, H);
          const lw = Math.max(1, Math.round(u));
          const lines = [];
          for (const k of levels) {
            for (const sign of [-1, 1]) {
              const v = Math.round((P + sign * k * sg) * 100); // cents, like the strikes
              if (v < sMin || v > sMax) continue;
              const text = `${sign > 0 ? '+' : '−'}${lvText(k)}`;
              // A strike chart: a vertical line at x, the label above the strike axis. The Interval Map: a horizontal
              // line at y (the high strikes at the top), the label at the left end.
              const X = horiz ? 0 : Math.round(((v - sMin) / (sMax - sMin)) * W) + (lw % 2 ? 0.5 : 0);
              const Y = horiz ? Math.round((1 - (v - sMin) / (sMax - sMin)) * H) + (lw % 2 ? 0.5 : 0) : 0;
              lines.push(horiz ? { v: sign * k, y: b.top + (tt * sc) + Y / dpr, text } : { v: sign * k, x: b.left + (tl * sc) + X / dpr, text });
              if (same) continue;
              g.save();
              g.strokeStyle = k <= 1 ? 'rgba(255, 255, 255, 0.9)' : 'rgba(255, 255, 255, 0.6)';
              g.lineWidth = lw;
              g.setLineDash([6 * u, 4 * u]);
              g.beginPath();
              if (horiz) {
                g.moveTo(0, Y);
                g.lineTo(W, Y);
              } else {
                g.moveTo(X, 0);
                g.lineTo(X, H);
              }
              g.stroke();
              g.restore();
              if (horiz) sdLabel(g, text, 4 * u, Math.min(H - u, Math.max(19 * u, Y + 9 * u)), u, colors, true); // inside the chart
              else sdLabel(g, text, X, H - 3 * u, u, colors);
            }
          }
          const k = c.getAttribute('data-qdts-chart');
          const json = JSON.stringify(lines);
          if (cv.dataset.k !== k) cv.dataset.k = k;
          if (cv.dataset.lines !== json) cv.dataset.lines = json;
          shown.add(cv);
        }
      }
    }
    for (const cv of sdShown) {
      if (shown.has(cv)) continue;
      if (sdKeep(cv, cv._chart)) {
        shown.add(cv); // its chart loads (no zoom bar now): keep the last picture
        continue;
      }
      cv._keepSince = 0;
      if (!cv._chart || !cv._chart.isConnected) {
        cv.remove(); // QuantData replaced its chart canvas: free the pixels
        continue;
      }
      cv.style.display = 'none';
      cv.dataset.lines = '[]';
    }
    sdShown.clear();
    for (const cv of shown) sdShown.add(cv);
  }

  // ---------------------------------------------------------------------------
  // Keep the old chart while new data loads.
  // While QuantData loads, it removes the chart header and the zoom bar, clears the chart canvas and shows
  // "Loading chart data..." with a spinner. Before a step, the panel puts an opaque copy of the chart part
  // (header, chart, zoom bar) of each synced tool on top. The copy goes away in the frame after QuantData
  // removes its loading placeholder. No placeholder in 700 ms, or 6 s passed: the copy goes too.
  // Only tools with a time slider get a copy. Clicks and hover go through it.
  // ---------------------------------------------------------------------------
  const PLACEHOLDER = /^QDChartLoadingPlaceholder-module__.*__loadingDisplayContainer$/;
  const LOADING_TEXT = /loading chart data/i;
  const freezes = new Map(); // tool -> { pic, start, sawLoading, ending, mo, timer, trace }
  let lastFreezeTrace = null;
  // The copies live in the page DOM (not in the shadow root), so the page styles apply to the copied header and zoom bar.
  const freezeBox = document.createElement('div');
  freezeBox.id = 'qd-time-sync-freeze';
  // z-index 150: above the charts, below QuantData's menus (Mantine 200+) and its toasts.
  freezeBox.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:visible;z-index:150;pointer-events:none;';
  freezeBox.inert = true; // No focus, no clicks: they go to the page under the copy.
  const freezeStyle = document.createElement('style');
  freezeStyle.textContent = '#qd-time-sync-freeze, #qd-time-sync-freeze * { pointer-events: none !important; }'
    + '#qd-time-sync-freeze .qdts-spin { position: absolute; z-index: 1; width: 14px; height: 14px; box-sizing: border-box; border-radius: 50%;'
    + ' border: 2px solid rgba(255, 255, 255, 0.22); border-top-color: var(--qd-themeColor-primary, rgb(1, 165, 254)); animation: qdts-spin 0.8s linear infinite; }'
    + '@keyframes qdts-spin { to { transform: rotate(360deg); } }';
  // A time slider that moves in this action (a step in direction dir, or a jump). Only these tools get a copy.
  function willStep(el, dir) {
    const r = read(el);
    if (!isTime(r) || atBound(r, dir)) return false;
    const le = liveEnd();
    return !(dir > 0 && le !== null && etOf(r) >= le);
  }
  function willMove(el, job, cap) {
    const r = read(el);
    if (!isTime(r)) return false;
    if (job.t === 'edge') return job.which === 'start' ? r.value !== r.min : r.value !== r.max;
    const t = targetFor(el, job, cap);
    return !isNaN(t) && Math.round(t) !== r.value;
  }
  // The new chart is drawn: its canvas has pixels again (a small copy is enough to see this).
  const sampler = document.createElement('canvas');
  sampler.width = 24;
  sampler.height = 12;
  function chartDrawn(tool) {
    const c = [...tool.querySelectorAll('canvas')].find((x) => hasToken(x, /^nativeChartSurface-module__.*__canvas$/) && !x.closest('#qd-time-sync-freeze'));
    if (!c || !c.width || !c.height) return true;
    try {
      const g = sampler.getContext('2d', { willReadFrequently: true });
      g.clearRect(0, 0, 24, 12);
      g.drawImage(c, 0, 0, 24, 12);
      const d = g.getImageData(0, 0, 24, 12).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
      return false;
    } catch {
      return true;
    }
  }
  window.addEventListener('resize', () => { for (const t of [...freezes.keys()]) unfreeze(t); }); // The copy would stay at the old place.

  const toolLoading = (tool) => [...tool.querySelectorAll('[class*="QDChartLoadingPlaceholder-module__"]')].some((n) => hasToken(n, PLACEHOLDER))
    || LOADING_TEXT.test(tool.textContent || '');

  // The chart part of a tool: the chart header and the chart container (canvas and zoom bar).
  function chartParts(tool) {
    const all = [...tool.querySelectorAll('[class]')];
    const head = all.find((n) => hasToken(n, /^QDChartHeader-module__.*__chartHeader$/));
    const chart = all.find((n) => hasToken(n, /^QDBaseChart-module__.*__container$/));
    return [head, chart].filter(Boolean);
  }

  // An opaque background like the one under the chart: the first opaque color above it, and the nearest picture (gradient) on top.
  const opaque = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return false;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return p.length < 4 || p[3] >= 1;
  };
  function paintBackground(pic, el, box) {
    let image = null;
    let color = null;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (!image && s.backgroundImage && s.backgroundImage !== 'none') {
        const r = n.getBoundingClientRect();
        image = { v: s.backgroundImage, size: `${r.width}px ${r.height}px`, pos: `${r.left - box.left}px ${r.top - box.top}px` };
      }
      if (opaque(s.backgroundColor)) {
        color = s.backgroundColor;
        break;
      }
    }
    pic.style.backgroundColor = color || 'rgb(0, 15, 24)';
    if (image) Object.assign(pic.style, { backgroundImage: image.v, backgroundSize: image.size, backgroundPosition: image.pos, backgroundRepeat: 'no-repeat' });
  }

  // lite: without QuantData's crosshair layer (a picture that waits for a reload; less memory).
  function makePicture(tool, lite = false) {
    const parts = chartParts(tool);
    if (!parts.length) return null;
    const rects = parts.map((p) => p.getBoundingClientRect());
    const left = Math.min(...rects.map((r) => r.left));
    const top = Math.min(...rects.map((r) => r.top));
    const box = { left, top, width: Math.max(...rects.map((r) => r.right)) - left, height: Math.max(...rects.map((r) => r.bottom)) - top };
    if (box.width < 50 || box.height < 30) return null;
    const pic = document.createElement('div');
    pic.className = 'qdts-freeze';
    Object.assign(pic.style, { position: 'fixed', left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`, overflow: 'hidden', pointerEvents: 'none' });
    paintBackground(pic, parts[parts.length - 1], box);
    parts.forEach((part, i) => {
      const r = rects[i];
      const copy = part.cloneNode(true);
      // A copied canvas is empty: draw the picture of the original into it.
      const src = [...part.querySelectorAll('canvas')];
      [...copy.querySelectorAll('canvas')].forEach((c, j) => {
        if (lite && src[j] && hasToken(src[j], /overlayCanvas$/)) return;
        try {
          c.getContext('2d').drawImage(src[j], 0, 0);
        } catch { /* An empty canvas stays empty. */ }
      });
      // A wrapper with the text styles that the part gets from its parent in the page (color, font).
      const wrap = document.createElement('div');
      const ps = part.parentElement ? getComputedStyle(part.parentElement) : null;
      if (ps) Object.assign(wrap.style, { color: ps.color, fontFamily: ps.fontFamily, fontSize: ps.fontSize, fontWeight: ps.fontWeight, lineHeight: ps.lineHeight, letterSpacing: ps.letterSpacing, textShadow: ps.textShadow });
      // A part in a scaled plane (Infinite Page): copy it at its own size and scale the copy like the plane.
      const sx = part.offsetWidth ? r.width / part.offsetWidth : 1;
      const sy = part.offsetHeight ? r.height / part.offsetHeight : 1;
      const scaled = Math.abs(sx - 1) > 0.01 || Math.abs(sy - 1) > 0.01;
      const w = scaled ? part.offsetWidth : r.width;
      const h = scaled ? part.offsetHeight : r.height;
      Object.assign(wrap.style, { position: 'absolute', left: `${r.left - box.left}px`, top: `${r.top - box.top}px`, width: `${w}px`, height: `${h}px` });
      if (scaled) Object.assign(wrap.style, { transform: `scale(${sx}, ${sy})`, transformOrigin: '0 0' });
      Object.assign(copy.style, { position: 'relative', left: '0', top: '0', width: `${w}px`, height: `${h}px`, margin: '0', boxSizing: 'border-box' });
      copy.removeAttribute('id');
      copy.removeAttribute('data-qdts-bar');
      for (const n of copy.querySelectorAll('[id], [data-qdts-bar], [role="slider"]')) {
        n.removeAttribute('id');
        n.removeAttribute('data-qdts-bar');
        n.removeAttribute('data-qdts-slider');
        n.removeAttribute('role'); // The scan must not find a copied slider.
      }
      wrap.appendChild(copy);
      pic.appendChild(wrap);
    });
    // A small spinner at the top right: new data loads. In the chart header (title and legend are in the middle,
    // the right part is free on the real page), else at the top right of the plot (the largest canvas).
    // Never at the bottom: there it covers the price scale (Julian, 1.14).
    const headI = parts.findIndex((p) => hasToken(p, /^QDChartHeader-module__.*__chartHeader$/));
    const chart = parts.find((p) => hasToken(p, /^QDBaseChart-module__.*__container$/));
    const plot = chart && [...chart.querySelectorAll('canvas')].map((c) => c.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0).sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const at = headI >= 0 && rects[headI].height >= 18 ? { right: rects[headI].right, top: rects[headI].top + (rects[headI].height - 14) / 2 }
      : plot ? { right: plot.right, top: plot.top + 8 } : null;
    if (at) {
      const spin = document.createElement('div');
      spin.className = 'qdts-spin';
      const x = Math.max(0, Math.min(box.width - 14, at.right - box.left - 22));
      const y = Math.max(0, Math.min(box.height - 14, at.top - box.top));
      Object.assign(spin.style, { left: `${x}px`, top: `${y}px` });
      pic.appendChild(spin);
    }
    return pic;
  }

  function freezeTools(moves) {
    if (!cfg.freeze) return;
    const tools = new Map(); // tool -> its moving sliders
    for (const el of activeSliders()) {
      const t = moves(el) && toolOf(el);
      if (t) tools.set(t, [...(tools.get(t) || []), el]);
    }
    const now = performance.now();
    for (const [tool, els] of tools) {
      // The sliders move one after the other: the "no placeholder" time counts from the move of this tool's slider.
      const watch = { els, v0: els.map((el) => read(el).value), movedAt: 0 };
      const f = freezes.get(tool);
      if (f) {
        // Still waiting for data: keep the copy of the last complete chart.
        Object.assign(f, { start: now, sawLoading: false, ending: false }, watch);
        continue;
      }
      if (toolLoading(tool)) continue; // No complete chart to copy.
      const pic = makePicture(tool);
      if (pic) startFreeze(tool, pic, watch);
    }
  }
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
  function startFreeze(tool, pic, watch, sawLoading = false) {
    if (!freezeBox.isConnected) (document.body || document.documentElement).appendChild(freezeBox);
    if (!freezeStyle.isConnected) (document.head || document.documentElement).appendChild(freezeStyle);
    freezeBox.appendChild(pic);
    const nf = { pic, start: performance.now(), sawLoading, ending: false, trace: [], rect0: rectOf(tool), ...watch };
    nf.mo = new MutationObserver(() => checkFreeze(tool));
    nf.mo.observe(tool, { childList: true, subtree: true, characterData: true });
    nf.timer = setInterval(() => checkFreeze(tool), 100);
    freezes.set(tool, nf);
  }

  // Reloads from another session of this page. QuantData moves the sliders of a page in all its sessions (about 0.5 s
  // after the step, REALSITE-1.md section 8), and each session loads the new data. A Safari web app has its own storage,
  // so no message of the panel there reaches this tab (Julian, 2026-10-11: Play in Safari on the large screen, the same
  // page in a web app on the MacBook). Thus: when a time slider moves without an action of this panel, this tab keeps
  // a picture of each chart with a time slider (after each load, max 5 s old) and puts it on top when QuantData shows
  // its loading placeholder after a time change (a MutationObserver runs before the page paints). The first reload
  // shows QuantData's placeholder. Only for 10 min after the last such move: the pictures need memory.
  const REMOTE_MS = 600000;
  let remoteAt = -Infinity;
  const seenVal = new WeakMap(); // slider -> its value at the last refresh
  const snaps = new Map();       // tool -> { pic, rect, v, at }: a picture of its last complete chart
  const stableAt = new Map();    // tool -> the time since it does not load
  const phObs = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        const ph = hasToken(n, PLACEHOLDER) ? n : n.firstElementChild ? [...n.querySelectorAll('[class*="QDChartLoadingPlaceholder-module__"]')].find((x) => hasToken(x, PLACEHOLDER)) : null;
        if (ph) showSnap(toolOf(ph));
      }
    }
  });
  const toolSliders = () => {
    const tools = new Map(); // tool -> its active time sliders
    for (const el of activeSliders()) {
      const t = isTime(read(el)) && toolOf(el);
      if (t) tools.set(t, [...(tools.get(t) || []), el]);
    }
    return tools;
  };
  function watchRemote() {
    const now = performance.now();
    for (const el of autoList) {
      const r = read(el);
      const was = seenVal.get(el);
      seenVal.set(el, r.value);
      // Not our own move, not the live end that goes on by itself.
      if (!working && !pendingJob && !pendingSteps && was !== undefined && r.value !== was && !(isLive(r) && r.value === r.max)) {
        if (now - remoteAt > REMOTE_MS) phObs.observe(document.documentElement, { childList: true, subtree: true });
        remoteAt = now;
      }
    }
    if (now - remoteAt > REMOTE_MS || !cfg.freeze) {
      if (now - remoteAt > REMOTE_MS) phObs.disconnect();
      snaps.clear();
      stableAt.clear();
      return;
    }
    for (const [tool, els] of toolSliders()) {
      if (freezes.has(tool) || toolLoading(tool) || !shownEl(tool)) {
        stableAt.delete(tool);
        continue;
      }
      if (!stableAt.has(tool)) stableAt.set(tool, now);
      const v = els.map((el) => read(el).value).join();
      const s = snaps.get(tool);
      // A new picture 300 ms after a load (the zoom bar and the σ lines are drawn then), and every 5 s.
      if (now - stableAt.get(tool) < 300 || (s && s.v === v && now - s.at < 5000) || !chartDrawn(tool)) continue;
      const pic = makePicture(tool, true);
      if (pic) snaps.set(tool, { pic, rect: rectOf(tool), v, at: now });
    }
  }
  function showSnap(tool) {
    const s = tool && snaps.get(tool);
    if (!s || freezes.has(tool) || working || !cfg.freeze) return;
    snaps.delete(tool);
    const els = toolSliders().get(tool) || [];
    if (els.map((el) => read(el).value).join() === s.v) return; // no time change (for example another ticker): no picture
    if (rectOf(tool).some((x, i) => Math.abs(x - s.rect[i]) > 2)) return; // the tool moved: the picture is at the wrong place
    startFreeze(tool, s.pic, { els, v0: els.map((el) => read(el).value), movedAt: performance.now() }, true);
  }

  // The tool moved or changed its size since the copy was made: the copy is at the wrong place now.
  function freezeMoved(tool) {
    const f = freezes.get(tool);
    if (!f || !f.rect0 || !tool.isConnected) return false;
    const r = tool.getBoundingClientRect();
    return [r.left, r.top, r.width, r.height].some((v, i) => Math.abs(v - f.rect0[i]) > 2);
  }
  function checkFreeze(tool) {
    const f = freezes.get(tool);
    if (!f || f.ending) return;
    if (freezeMoved(tool)) {
      f.trace.push([Math.round(performance.now() - f.start), 'tool moved']);
      unfreeze(tool);
      return;
    }
    const age = performance.now() - f.start;
    const loading = toolLoading(tool);
    if (loading && !f.sawLoading) f.trace.push([Math.round(age), 'loading']);
    if (loading) f.sawLoading = true;
    if (!f.movedAt && f.els.some((el, i) => read(el).value !== f.v0[i])) {
      f.movedAt = performance.now();
      f.trace.push([Math.round(age), 'slider moved']);
    }
    // Done: the placeholder came and went, or no placeholder came in 700 ms after the slider moved,
    // or the slider did not move in 2 s, or 6 s passed.
    const done = !tool.isConnected || (f.sawLoading && !loading) || age > 6000
      || (!f.sawLoading && (f.movedAt ? performance.now() - f.movedAt > 700 : age > 2000));
    if (!done) return;
    f.ending = true;
    f.trace.push([Math.round(age), f.sawLoading ? 'loaded' : age > 6000 ? 'timeout' : 'no loading placeholder']);
    // Loaded: remove the copy in the first frame in which the new chart has pixels (max 300 ms). Else at once.
    const until = performance.now() + (f.sawLoading && !loading ? 300 : 0);
    const tick = () => {
      if (!f.ending) return;
      if (performance.now() >= until || chartDrawn(tool)) unfreeze(tool);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function unfreeze(tool) {
    const f = freezes.get(tool);
    if (!f) return;
    f.mo.disconnect();
    clearInterval(f.timer);
    f.pic.remove();
    freezes.delete(tool);
    lastFreezeTrace = { trace: f.trace };
  }

  // ---------------------------------------------------------------------------
  // Report: slider data and the structure of 1 clicked element (for example the Net Drift zoom bar)
  // ---------------------------------------------------------------------------
  const KEYWORDS = /brush|zoom|navigator|slider|handle|travell|range|scroll|echarts|highcharts|recharts|apex|chart|tv-|lightweight|selection|overlay|uplot|plotly|visx|nivo|victory|amcharts/i;

  function nodeInfo(n) {
    const r = n.getBoundingClientRect();
    const attrs = {};
    for (const a of n.attributes || []) {
      if (['class', 'style', 'd', 'points'].includes(a.name)) continue;
      attrs[a.name] = a.value.slice(0, 60);
    }
    const style = getComputedStyle(n);
    const scrolls = n.scrollWidth > n.clientWidth + 1 || n.scrollHeight > n.clientHeight + 1;
    return {
      tag: n.tagName.toLowerCase(),
      cls: (n.getAttribute('class') || '').slice(0, 160),
      attrs,
      box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      cursor: style.cursor !== 'auto' ? style.cursor : undefined,
      transform: style.transform !== 'none' ? style.transform.slice(0, 80) : undefined,
      overflow: style.overflow !== 'visible' ? style.overflow : undefined,
      // [scrollLeft, scrollWidth, clientWidth, scrollTop, scrollHeight, clientHeight] if the element can scroll.
      scroll: scrolls ? [n.scrollLeft, n.scrollWidth, n.clientWidth, n.scrollTop, n.scrollHeight, n.clientHeight].map(Math.round) : undefined,
      children: n.children.length,
    };
  }

  function summary(container) {
    const tags = {};
    const classes = new Set();
    const nodes = [...container.querySelectorAll('*')].slice(0, 4000);
    for (const n of nodes) {
      const t = n.tagName.toLowerCase();
      tags[t] = (tags[t] || 0) + 1;
      for (const w of (n.getAttribute('class') || '').split(/\s+/)) if (w && KEYWORDS.test(w)) classes.add(w);
    }
    const canvases = [...container.querySelectorAll('canvas')].map((c) => nodeInfo(c).box);
    const ew = nodes.filter((n) => /e-resize|ew-resize|col-resize|grab|move/.test(getComputedStyle(n).cursor)).slice(0, 15).map(nodeInfo);
    return { tags, classes: [...classes].slice(0, 100), canvases, dragTargets: ew };
  }

  function libraryHints() {
    const q = (sel) => document.querySelectorAll(sel).length;
    return {
      echarts: q('[_echarts_instance_]'),
      highcharts: q('.highcharts-container'),
      highchartsNavigator: q('.highcharts-navigator'),
      recharts: q('.recharts-wrapper'),
      rechartsBrush: q('.recharts-brush'),
      apexcharts: q('.apexcharts-canvas'),
      lightweightCharts: q('.tv-lightweight-charts'),
      d3brush: q('.selection, .handle--e, .handle--w'),
      uplot: q('.uplot'),
      plotly: q('.js-plotly-plot'),
      canvases: q('canvas'),
      svgs: q('svg'),
    };
  }

  function buildReport(clicked, x, y) {
    scan();
    const rep = {
      tool: 'QD Toolkit 1.0',
      path: location.pathname,
      nowET: hhmm(nowEt()),
      viewport: [innerWidth, innerHeight],
      panel: docked ? 'header' : 'floating',
      sliders: autoList.map((el, i) => {
        const r = read(el);
        return {
          n: i + 1,
          active: activeSliders().includes(el),
          key: sliderKeys.get(el),
          label: describe(el),
          tag: el.tagName.toLowerCase(),
          cls: (el.getAttribute('class') || '').slice(0, 100),
          value: r.value, min: r.min, max: r.max, text: r.text || undefined,
          base: timeBase(r),
          box: nodeInfo(el).box,
        };
      }),
      libs: libraryHints(),
      liveEnd: liveEnd(),
      rate: { slowFactor, pause: Math.max(0, Math.round(backoffUntil - performance.now())) },
      budget: { free: Math.round(budgetNow()), cost: stepCost(), reserve: BUDGET_RESERVE, cap: BUDGET_CAP, rate: BUDGET_RATE },
      freeze: { on: !!cfg.freeze, active: freezes.size, last: lastFreezeTrace },
      zoomBars: zoomBars.map((z) => ({ title: z.title, key: z.key, strike: z.strike, on: zoomOn(z), status: z.status, info: z.info, left: leftEt.get(z.key), box: nodeInfo(z.root).box })),
      links: window.__qdTimeSyncDebug ? window.__qdTimeSyncDebug.link() : null,
      sd: cfg.sd,
    };
    if (clicked) {
      const chain = [];
      for (let n = clicked; n && n.nodeType === 1 && chain.length < 12; n = n.parentElement) chain.push(nodeInfo(n));
      // The widget: the first parent that is large enough to hold the full chart.
      let box = clicked;
      while (box.parentElement && box.parentElement !== document.body) {
        const r = box.getBoundingClientRect();
        if (r.width >= 300 && r.height >= 180) break;
        box = box.parentElement;
      }
      rep.click = { x: Math.round(x), y: Math.round(y), chain, widget: nodeInfo(box), inside: summary(box) };
    }
    return JSON.stringify(rep, (k, v) => (typeof v === 'number' && isNaN(v) ? null : v), 1);
  }

  function showReport(text) {
    reportText.value = text;
    reportText.hidden = true; // Shown only when the copy fails.
    const done = () => {
      msg.textContent = 'Report copied. Paste it in the chat.';
      msg.hidden = !list.hidden; // With the list closed, the message below the list button says it.
      if (list.hidden) showTip(msg.textContent, 4000);
    };
    const manual = () => {
      if (list.hidden) openList(true); // The text to copy by hand is in the list.
      reportText.hidden = false;
      reportText.focus();
      reportText.select();
      msg.textContent = 'Copy failed. The text is selected: push Cmd+C, then paste it in the chat.';
      msg.hidden = false;
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, manual);
      else manual();
    } catch {
      manual();
    }
  }

  let reportMode = false;
  const SWALLOW = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'touchstart'];
  function swallow(e) {
    if (!e.isTrusted || e.composedPath().includes(host)) return; // Our own synthetic events pass.
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'pointerdown' || e.type === 'mousedown' || e.type === 'touchstart') {
      if (!reportMode) return;
      const pt = e.touches ? e.touches[0] : e;
      endReport(e.composedPath()[0], pt.clientX, pt.clientY);
    }
  }
  function onReportKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      endReport(null, 0, 0);
    }
  }
  function startReport() {
    if (reportMode) return endReport(null, 0, 0);
    stop();
    reportMode = true;
    reportBtn.classList.add('on');
    msg.textContent = 'Click the element that you want to sync or fix (for example the Net Drift zoom bar or a GEX chart). Esc copies the report without an element.';
    msg.hidden = false;
    // The list and its backdrop go away, so that they do not cover the element. The message shows below the list button.
    list.hidden = true;
    backdrop.hidden = true;
    hideHighlight();
    showTip(msg.textContent);
    for (const t of SWALLOW) document.addEventListener(t, swallow, true);
    document.addEventListener('keydown', onReportKey, true);
  }
  function endReport(el, x, y) {
    reportMode = false;
    showTip('');
    reportBtn.classList.remove('on');
    document.removeEventListener('keydown', onReportKey, true);
    showReport(buildReport(el && el.nodeType === 1 ? el : el && el.parentElement, x, y));
    // Keep the click events of this click away from the page, then release them.
    setTimeout(() => { for (const t of SWALLOW) document.removeEventListener(t, swallow, true); }, 600);
  }

  // ---------------------------------------------------------------------------
  // Display
  // ---------------------------------------------------------------------------
  function fmt(r) {
    if (r.text) return r.text;
    const v = r.value;
    if (isNaN(v)) return '–';
    if (isTime(r)) return clock(etOf(r));
    // Large numbers are probably a Unix time (ms or s). Show the time in New York (US session).
    const ms = v > 1e12 ? v : v > 1e9 ? v * 1000 : NaN;
    if (!isNaN(ms)) {
      if (cfg.localTime) return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      return `${new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' })} ET`;
    }
    return String(Math.round(v * 1000) / 1000);
  }

  let dragging = false;

  function render() {
    const small = cfg.collapsed && !docked; // In the header the panel is never small.
    bar.hidden = small;
    pill.hidden = !small;
    if (small && !list.hidden) openList(false);
    playIcon.innerHTML = playing ? icon.pause : icon.play;
    playBtn.classList.toggle('on', playing);
    playBtn.title = playing ? 'Pause (-)' : 'Play (-)';
    updatePlayState();
    speedSel.value = String(cfg.speed);
    speedText.textContent = speedSel.selectedOptions[0] ? speedSel.selectedOptions[0].textContent : '';
    speedSel2.value = String(cfg.speed);
    optFreeze.checked = !!cfg.freeze;
    optLocal.checked = !!cfg.localTime;
    timeEl.title = `Type a time (for example ${cfg.localTime ? '16:45' : '10:45'}) and press Enter. All sliders go to this time.${cfg.localTime ? ' The time of your computer; with ET after it, New York time.' : ' New York time (ET).'}`;
  }

  function refresh() {
    mount(); // The page removed the panel, or the header came or went: put it in its place again.
    scan();
    const sl = activeSliders();
    for (const n of root.querySelectorAll('.n')) n.textContent = String(sl.length);
    root.querySelector('.count').classList.toggle('zero', sl.length === 0);

    const ref = refSlider();
    const editing = root.activeElement === timeEl;
    if (ref) {
      const r = read(ref);
      const { lo, hi } = playRange(r);
      const ok = !isNaN(lo) && !isNaN(hi) && hi > lo;
      master.disabled = !ok;
      if (ok && !dragging) {
        master.min = String(lo);
        master.max = String(hi);
        master.step = String(isNaN(r.step) ? 'any' : r.step);
        master.value = String(r.value);
        setFill();
      }
      if (!dragging && !editing) timeEl.value = fmt(r);
    } else {
      master.disabled = true;
      if (!editing) timeEl.value = '–';
    }
    timeEl.classList.toggle('busy', working);

    const day = dayMode();
    rthBtn.hidden = !day;
    rthBtn.classList.toggle('on', !!cfg.rth);
    rthBtn.setAttribute('aria-pressed', String(!!cfg.rth));
    rthBtn2.setAttribute('aria-pressed', String(!!cfg.rth));
    rthBtn2.hidden = !day;
    rthBtn2.classList.toggle('on', !!cfg.rth);
    const rth = day && cfg.rth;
    startBtn.title = rth ? 'Go to 09:30 ET (open)' : 'Go to the start';
    endBtn.title = rth ? 'Go to 16:00 ET (close)' : 'Go to the end';

    const values = new Set(sl.map((el) => { const r = read(el); return isTime(r) ? etOf(r) : r.value; }).filter((v) => !isNaN(v)));
    alignBtn.hidden = values.size < 2 || working;
    // A tab that shows again: its slider goes to the time of the others (only this tab, 1 job).
    let back = false;
    for (const el of autoList) {
      if (!shownEl(el)) hiddenSliders.add(el);
      else if (hiddenSliders.has(el)) {
        hiddenSliders.delete(el);
        back = true;
      }
    }
    if (back && values.size >= 2) act.align();

    scanZoom();
    groupLinks();
    linkCheck();
    syncZoom();
    updateMasks();
    drawBands();
    watchRemote();

    const now = performance.now();
    slowBtn.hidden = slowBtn2.hidden = slowFactor <= 1;
    slowBtn.textContent = slowBtn2.textContent = `1/${slowFactor} speed`;
    const wait = pauseLeft();
    const bw = budgetWaitUntil - now;
    paceEl.hidden = paceEl2.hidden = !(playing && bw > 0) || wait > 0;
    if (!paceEl.hidden) paceEl.textContent = paceEl2.textContent = `Budget · ${(bw / 1000).toFixed(1)} s`;
    if (!list.hidden) showBudget();
    rateEl.hidden = rateEl2.hidden = wait <= 0;
    if (wait > 0) {
      rateEl.textContent = rateEl2.textContent = `Rate limit · ${Math.ceil(wait / 1000)} s`;
      rateEl.title = 'QuantData showed "You\'re making requests too quickly". Play pauses, your own steps still run.';
    }
    updatePlayState();

    if (!list.hidden) {
      if (signature() !== listSig) buildList();
      else updateListValues();
    }
  }

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    switch (btn.dataset.act) {
      case 'start': act.edge('start'); break;
      case 'back': act.step(-1); break;
      case 'play': togglePlay(); break;
      case 'fwd': act.step(1); break;
      case 'end': act.edge('end'); break;
      case 'align': act.align(); break;
      case 'rth':
        cfg.rth = !cfg.rth;
        saveCfg();
        refresh();
        break;
      case 'list': openList(list.hidden); break;
      case 'report': startReport(); break;
      case 'full-speed':
        slowFactor = 1;
        refresh();
        break;
      case 'collapse':
        cfg.collapsed = true;
        saveCfg();
        render();
        break;
    }
  });
  pill.addEventListener('click', () => {
    cfg.collapsed = false;
    saveCfg();
    render();
    refresh();
    if (cfg.x !== null) requestAnimationFrame(() => place(cfg.x, cfg.y)); // The bar is wider than the pill. Keep it on screen.
  });

  // The filled part of the master slider in the header (the QuantData slider style): --p = 0..1.
  function setFill() {
    const lo = Number(master.min), hi = Number(master.max), v = Number(master.value);
    master.style.setProperty('--p', hi > lo ? String(Math.max(0, Math.min(1, (v - lo) / (hi - lo)))) : '0');
  }
  master.addEventListener('input', () => {
    dragging = true;
    setFill();
    const ref = refSlider();
    const v = Number(master.value);
    timeEl.value = ref ? fmt({ ...read(ref), text: '', value: v }) : String(v);
  });
  master.addEventListener('change', () => {
    dragging = false;
    const ref = refSlider();
    if (ref) act.set(jobFromRef(read(ref), Number(master.value)));
  });

  // Select the full text on focus, so typing replaces it. The mouseup after the click would clear the selection.
  let keepSelection = false;
  timeEl.addEventListener('focus', () => {
    timeEl.select();
    keepSelection = true;
  });
  timeEl.addEventListener('mouseup', (e) => {
    if (keepSelection) e.preventDefault();
    keepSelection = false;
  });
  timeEl.addEventListener('keydown', (e) => {
    e.stopPropagation(); // The keys are for this field only, not for the page.
    if (e.key === 'Escape') {
      timeEl.blur();
    } else if (e.key === 'Enter') {
      const ref = refSlider();
      if (!ref) return;
      const r = read(ref);
      const v = isTime(r) ? parseClock(timeEl.value) : Number(timeEl.value.replace(',', '.'));
      if (isNaN(v)) {
        timeEl.classList.add('bad');
        setTimeout(() => timeEl.classList.remove('bad'), 900);
        return;
      }
      act.set(isTime(r) ? { et: v } : { v: Math.max(r.min, Math.min(r.max, v)) });
      timeEl.blur();
    }
  });
  timeEl.addEventListener('blur', () => refresh());

  for (const sel of [speedSel, speedSel2]) {
    sel.addEventListener('change', () => {
      cfg.speed = sel.value === 'auto' ? 'auto' : Number(sel.value);
      saveCfg();
      render();
    });
  }
  optFreeze.addEventListener('change', () => {
    cfg.freeze = optFreeze.checked;
    saveCfg();
    if (!cfg.freeze) for (const tool of [...freezes.keys()]) unfreeze(tool);
  });
  optLocal.addEventListener('change', () => {
    cfg.localTime = optLocal.checked;
    saveCfg();
    render();
    refresh();
    updateListValues();
  });
  optXhair.addEventListener('change', () => {
    cfg.xhair = optXhair.checked;
    saveCfg();
    if (!cfg.xhair) hideXhair();
  });
  optMask.addEventListener('change', () => {
    cfg.zoomMask = optMask.checked;
    saveCfg();
    updateMasks();
  });

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------
  // Esc closes the open list (also from a field in the list).
  window.addEventListener('keydown', (e) => {
    if (e.isTrusted && e.key === 'Escape' && !list.hidden && !reportMode) openList(false);
  }, true);
  window.addEventListener(
    'keydown',
    (e) => {
      // Our own key events to the sliders are not trusted. Ignore them, else they loop.
      if (!e.isTrusted || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTyping(e.composedPath()[0])) return;
      if (!activeSliders().length) return;

      let run = null;
      if (e.key === '.') run = () => act.step(1);
      else if (e.key === ',') run = () => act.step(-1);
      else if (e.key === '-' || e.key === '/') run = togglePlay;
      else if (e.key === 'ArrowRight') run = () => act.step(e.shiftKey ? SHIFT_STEPS : 1);
      else if (e.key === 'ArrowLeft') run = () => act.step(e.shiftKey ? -SHIFT_STEPS : -1);
      if (!run) return;

      // Stop the event here. Else a focused slider also moves, and it moves 2 steps.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat || !working) run(); // A held key does not fill the queue faster than the sliders can move.
    },
    true
  );

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------
  render();
  if (cfg.x !== null) requestAnimationFrame(() => place(cfg.x, cfg.y));
  refresh();
  setInterval(refresh, 400);

  // Debug access from the console: __qdTimeSyncDebug.sliders()
  window.__qdTimeSyncDebug = {
    sliders: () => activeSliders(), read, scan: () => (scan(), autoList), report: () => buildReport(null),
    rate: () => ({ slowFactor, pause: Math.max(0, backoffUntil - performance.now()) }),
    budget: () => ({ free: budgetNow(), cost: stepCost(), waitMs: Math.max(0, budgetWaitUntil - performance.now()) }),
    zoom: () => zoomBars.map((z) => ({ title: z.title, key: z.key, applied: z.applied, touched: z.touched, status: z.status, info: z.info, left: leftEt.get(z.key) })),
    bridge: (op, args) => bridge(op, args),
    sd: () => ({ following: !!followRaf, auto: sdAuto, error: sdErrorShown }),
    link: () => [...linkGroups.values()].map((g) => ({ id: g.id, label: g.label, range: linkRange.get(g.id) || null,
      charts: g.all.map((z) => ({ title: z.title, key: z.key, linked: linked(z), sv: z.info && z.info.sv, set: linkSet.get(z.key) || null })) })),
  };
})();
