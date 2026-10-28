// ==UserScript==
// @name         QD Toolkit
// @description  An unofficial all-round toolkit for QuantData: one global time slider to replay a session on all charts, σ lines and more.
// @version      1.1.0
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
    // The left end then stays there until the right end passes the left time again (2026-10-09).
    if (l < 0 || l > r) l = 0;
    let how = 'none';
    if (apply && typeof f.props.onChangeEnd === 'function') {
      // The Interval Map shows the range of onChange; its onChangeEnd only stores it (2026-10-11: with
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
  // t: a time (ms) from the own price chart (1.1) instead of a mouse place in a chart of the page.
  function xhair({ k, lx, ly, t, strikePeers, timePeers }) {
    let kind = 'time';
    let v = t;
    if (!Number.isFinite(t)) {
      const src = chartOf(k);
      const ref = src && layoutRef(src);
      if (!ref) return { ok: false };
      const L = ref.current;
      kind = kindOf(L);
      if (!kind || L.plotRight <= L.plotLeft || L.xMax <= L.xMin || lx < L.plotLeft || lx > L.plotRight || ly < L.plotTop || ly > L.plotBottom) return { ok: false };
      v = L.xMin + ((lx - L.plotLeft) / (L.plotRight - L.plotLeft)) * (L.xMax - L.xMin);
      const vals = valuesOf(src);
      if (vals) v = nearest(vals, v, L.xMin, L.xMax);
    }
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
  // A fixed y scale on the strike charts (1.1; 2026-10-21: "eine fixierte Skala, die ich selber dragen kann").
  // QuantData's exposure bar chart (QDNativeExposureBarChart) computes its y range at each draw from the visible bars
  // (symmetric about zero, computeNiceValueTicks with 7 ticks, then 15 % per frame toward it) and has no prop for a fixed
  // range; its bars also grow from the left after a load (an entrance wave) and move to new values (interpolators).
  // So the bridge draws the chart itself on its own canvas (before QuantData's canvas, which gets opacity 0 and keeps
  // its events: tooltip, wheel, drag), in the same places and styles (its plot area, its axis formatters, the theme
  // colors, its bar colors), with the fixed range and without the animations. QuantData writes its layout ref
  // (plotLeft ... yDomain) at the end of each draw: a setter on that ref draws ours in the same frame and puts the fixed
  // range into the layout, so QuantData's crosshair label (it reads the layout) shows the values of our scale. Only the
  // display in this browser changes.
  const SY_MARK = '__qdtsStrikeY';
  const syCharts = new Map(); // chart key -> { c, box, dom: { min, max } | null, auto, own }
  const syProps = (c) => rendererProps(c, (q) => q.callValuesRef && q.putValuesRef && q.xValuesRef && q.zoomRef && typeof q.leftAxisFormatter === 'function');
  // Like QuantData's computeNiceValueTicks: steps 1, 2, 2.5, 5, 10 x 10^n (the geometric middle between them).
  function syNice(a, b, n) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return { min: 0, max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
    if (a === b) {
      const t = Math.abs(a) > 0 ? 0.05 * Math.abs(a) : 1;
      return syNice(a - t, b + t, n);
    }
    const raw = (b - a) / Math.max(1, n);
    const p = 10 ** Math.floor(Math.log10(raw));
    const r = raw / p;
    const S = [1, 2, 2.5, 5, 10];
    let f = S[S.length - 1];
    for (let i = 0; i < S.length - 1; i++) if (r <= Math.sqrt(S[i] * S[i + 1])) { f = S[i]; break; }
    const step = f * p;
    const lo = Math.floor(a / step) * step;
    const hi = Math.ceil(b / step) * step;
    const ticks = [];
    for (let i = 0, k = Math.round((hi - lo) / step) + 1; i < k; i++) ticks.push(lo + i * step);
    return { min: lo, max: hi, ticks, step };
  }
  function syDraw(st, L) {
    const c = st.c;
    const P = syProps(c);
    if (!P || !L || L.isVertical || P.xScaleMode !== 'value' || !c.isConnected) return false;
    // A data snapshot of another minute (the cache, virtual steps): its strikes, values and price line instead of
    // QuantData's current ones, drawn in the current zoom and scale.
    const V = st.virt;
    const XS = V ? V.xs : P.xValuesRef.current || [];
    const CA = V ? V.calls : P.callValuesRef.current || [];
    const PU = V ? V.puts : P.putValuesRef.current || [];
    const MARK = V ? V.mark : P.markLineValue;
    let cv = st.own;
    if (!cv || !cv.isConnected || cv.nextElementSibling !== c) {
      if (cv) cv.remove();
      cv = document.createElement('canvas');
      cv.className = 'qdts-sy';
      cv.setAttribute('aria-hidden', 'true');
      cv.style.cssText = 'position:absolute;pointer-events:none;margin:0;padding:0;border:0;';
      c.before(cv);
      st.own = cv;
    }
    c.style.opacity = '0'; // QuantData's canvas keeps its events (tooltip, wheel, drag)
    // A load (its placeholder, no zoom bar): QuantData's canvas moves up and grows, and it draws nothing or the old data at
    // the size of the load. Ours keeps its old picture at its old place and size, hidden (2026-10-21: the slow
    // loads jumped). The load ends: the canvas has the old size again, and ours shows its old picture at once (like the
    // copy of the old chart) until QuantData draws the new data, so no frame is empty ("ein Flimmern"). Any other change
    // of the size: ours goes until QuantData draws at the new size (a ResizeObserver: in that frame, before the paint).
    const loadingNow = () => {
      const tool = c.closest('[class*="QDToolLayout-module__"][class*="__container"]');
      const bar = !!tool && !!tool.querySelector('[class*="QDChartZoomSlider-module__"][class*="__root"]');
      if (bar) st.hadBar = true; // no bar counts only when it had one (the zoom bars can be off in QuantData's settings)
      return !!tool && (!!tool.querySelector('[class*="QDChartLoadingPlaceholder-module__"]') || (st.hadBar && !bar));
    };
    const fits = (o) => Math.abs(parseFloat(o.style.width) - c.clientWidth) <= 1 && Math.abs(parseFloat(o.style.height) - c.clientHeight) <= 1
      && Math.abs(parseFloat(o.style.top) - c.offsetTop) <= 1 && Math.abs(parseFloat(o.style.left) - c.offsetLeft) <= 1;
    if (!st.ro || st.roFor !== c) {
      if (st.ro) st.ro.disconnect();
      st.roFor = c;
      st.ro = new ResizeObserver(() => {
        const o = st.own;
        if (!o) return;
        const loading = loadingNow();
        // Not loading and another size: QuantData's draw at once (its own ResizeObserver came first and has the new
        // size; it would draw only in the next frame or later), so ours is drawn at the new size before this paint
        // (probe s7: up to 430 ms without a chart after a load that another session started, no copy over it).
        if (!loading && !fits(o) && st.hooks && st.hooks.D && st.on) {
          try {
            st.hooks.D.current();
          } catch (err) { /* QuantData draws in its next frame */ }
        }
        o.style.visibility = fits(o) && !loading ? '' : 'hidden';
      });
      st.ro.observe(c);
    }
    if (loadingNow()) {
      cv.style.visibility = 'hidden';
      return true; // the old picture stays
    }
    // QuantData's layout of another size than its canvas now (it draws the new size in the next frame): keep ours as it
    // is, shown only when it fits.
    // Only for a moment (max 500 ms): a layout that stays another size (a fraction, a scaled plane) kept the old
    // picture with the old price until the next step (2026-10-23).
    const stale = (L.height && Math.abs(L.height - c.clientHeight) > 1) || (L.width && Math.abs(L.width - c.clientWidth) > 1);
    if (!stale) st.staleSince = 0;
    else if (!st.staleSince) st.staleSince = performance.now();
    if (stale && performance.now() - st.staleSince < 500) {
      cv.style.visibility = fits(cv) ? '' : 'hidden';
      if (!st.staleTimer) st.staleTimer = setTimeout(() => { st.staleTimer = 0; if (st.on && st.hooks && st.hooks.D) st.hooks.D.current(); }, 520);
      return true;
    }
    cv.style.visibility = '';
    const l = L.width || c.clientWidth;
    const s = L.height || c.clientHeight;
    const K = window.devicePixelRatio || 1;
    const X = Math.round(l * K);
    const J = Math.round(s * K);
    if (cv.width !== X) cv.width = X;
    if (cv.height !== J) cv.height = J;
    Object.assign(cv.style, { left: `${c.offsetLeft}px`, top: `${c.offsetTop}px`, width: `${l}px`, height: `${s}px` });
    const o = cv.getContext('2d');
    o.setTransform(K, 0, 0, K, 0, 0);
    o.clearRect(0, 0, l, s);
    const ee = XS;
    cv.dataset.vals = JSON.stringify(PU.slice(0, 6)); // for the tests: the first put values that are drawn
    if (!ee.length) return true;
    // The visible bars: QuantData's visibleStart / visibleEnd are rows of ITS strikes. A snapshot of another minute can
    // have other strikes (the list moves with the price): its visible rows by the strike range xMin..xMax (2026-10-28,
    // a video of a user: the ends of the strike charts were missing until QuantData loaded the minute).
    let vs = L.visibleStart ?? 0;
    let ve = L.visibleEnd ?? ee.length - 1;
    if (V && Number.isFinite(L.xMin) && Number.isFinite(L.xMax)) {
      vs = ee.findIndex((x) => x >= L.xMin);
      if (vs < 0) vs = ee.length;
      ve = -1;
      for (let i = ee.length - 1; i >= 0; i--) if (ee[i] <= L.xMax) { ve = i; break; }
    }
    // QuantData's own target range, computed like it does (the largest visible bar, symmetric about zero or from zero,
    // 7 nice ticks; 'full': all bars x 1.1), but without its glide of 15 % per frame: the automatic mode (a double click
    // on the axis) takes it at once, and its ticks are the ones that QuantData measures its left padding with (
    // 2026-10-21: in the automatic mode the chart jumped at a step, its labels were cut for a moment).
    {
      const T0 = CA;
      const L0 = PU;
      const full = P.yDomainScope === 'full';
      const a0 = full ? 0 : Math.max(0, vs);
      const a1 = full ? ee.length - 1 : Math.min(ee.length - 1, ve);
      let em = 0;
      for (let i = a0; i <= a1; i++) {
        let call = P.callVisible ? T0[i] ?? 0 : undefined;
        let put = P.putVisible ? L0[i] ?? 0 : undefined;
        if (P.isNet) {
          const net = (T0[i] ?? 0) + (L0[i] ?? 0);
          call = P.callVisible ? Math.max(net, 0) : undefined;
          put = P.putVisible ? Math.min(net, 0) : undefined;
        }
        if (call !== undefined) em = Math.max(em, Math.abs(call));
        if (put !== undefined) em = Math.max(em, Math.abs(put));
      }
      if (full) em = Math.round(1.1 * em);
      const ep = syNice(P.yDomainMode === 'fromZero' ? 0 : -em, em, 7);
      st.auto = { min: ep.min, max: ep.max };
    }
    const dom = st.dom || st.auto || L.yDomain;
    const css = (n, d) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || d;
    const tert = css('--qd-themeColor-tertiary', 'rgba(255, 255, 255, 0.2)');
    const bg = css('--qd-themeColor-background', '#000000');
    const prim = css('--qd-themeColor-primary', '#3498db');
    const text = '#ffffff';
    const font = css('--mantine-font-family', 'Inter, sans-serif');
    const q = L.axisFontSize || 13;
    const shadowText = (t, x, y) => {
      o.shadowBlur = 2 * K;
      o.shadowColor = bg;
      o.shadowOffsetY = K;
      o.fillText(t, x, y);
      o.shadowBlur = 0;
      o.shadowColor = 'transparent';
      o.shadowOffsetY = 0;
    };
    const { plotLeft: eE, plotRight: ey, plotTop: pt, plotBottom: eb, xMin: e0, xMax: e1 } = L;
    const en = Math.max(0, vs);
    const eo = Math.min(ee.length - 1, ve);
    const eP = ey - eE;
    const eO = eb - pt;
    if (eP <= 0 || eO <= 0) return true;
    const eL = (v) => (v - e0) / Math.max(e1 - e0, 1e-9);
    const eM = (v) => eE + eL(v) * eP;
    const eR = (v) => eb - ((v - dom.min) / Math.max(dom.max - dom.min, 1e-9)) * eO;
    o.font = `bold ${q}px ${font}`;
    o.textBaseline = 'middle';
    // The widest label of our ticks: QuantData measures its left padding with it during its draw (syHooks), so the plot
    // keeps its place while its own automatic range changes.
    let pad = null;
    let pw = -1;
    for (const v of syNice(dom.min, dom.max, 7).ticks) {
      const s = P.leftAxisFormatter(v);
      const w = o.measureText(s).width;
      if (w > pw) {
        pw = w;
        pad = s;
      }
    }
    const nextPad = st.dom ? pad : null;
    if (nextPad !== st.pad) {
      st.pad = nextPad;
      if (st.hooks && st.hooks.D) requestAnimationFrame(() => { if (st.on) st.hooks.D.current(); }); // its padding again
    }
    // the value grid and its labels at the left (the ticks of the fixed range)
    let last = Infinity;
    for (const v of syNice(dom.min, dom.max, 7).ticks) {
      const t = eR(v);
      if (t < pt - 1 || t > eb + 1) continue;
      o.strokeStyle = tert;
      o.lineWidth = 1;
      o.beginPath();
      o.moveTo(eE, t);
      o.lineTo(ey, t);
      o.stroke();
      const h = q / 2;
      if (t + h > last - 6) continue;
      last = t - h;
      o.fillStyle = text;
      o.textAlign = 'right';
      shadowText(P.leftAxisFormatter(v), eE - 8, t);
    }
    if (!P.hideAxisTitles && P.leftAxisName) {
      o.fillStyle = text;
      o.textAlign = 'center';
      o.save();
      o.translate(12, pt + eO / 2);
      o.rotate(-Math.PI / 2);
      shadowText(P.leftAxisName, 0, 0);
      o.restore();
    }
    o.strokeStyle = prim;
    o.lineWidth = 2;
    o.beginPath();
    o.moveTo(eE, eb);
    o.lineTo(ey, eb);
    o.stroke();
    // the strike labels below (like QuantData: nice values, no overlap)
    const R = typeof P.xAxisFormatter === 'function' ? P.xAxisFormatter : (v) => String(v);
    const iw = Math.max(24, o.measureText(R(ee[en])).width, o.measureText(R(ee[eo])).width);
    const nTicks = Math.max(2, Math.min(12, Math.floor(eP / (iw + 16))));
    let right = -Infinity;
    for (const v of syNice(e0, e1, nTicks).ticks) {
      const t = eM(v);
      if (t < eE - 1 || t > ey + 1) continue;
      const lab = R(v);
      const w = o.measureText(lab).width;
      if (t - w / 2 < right + 8) continue;
      right = t + w / 2;
      o.strokeStyle = prim;
      o.beginPath();
      o.moveTo(t, eb);
      o.lineTo(t, eb + 4);
      o.stroke();
      o.fillStyle = text;
      o.textAlign = 'center';
      o.textBaseline = 'top';
      shadowText(lab, t, eb + 6);
      o.textBaseline = 'middle';
    }
    // the bars: the values as they are (no entrance wave, no interpolation)
    o.save();
    o.beginPath();
    o.rect(eE, pt, eP, eO);
    o.clip();
    let gap = Infinity;
    for (let t = en + 1; t <= eo; t++) gap = Math.min(gap, Math.abs(eM(ee[t]) - eM(ee[t - 1])));
    const bw = Math.max(1, Math.min(64, Number.isFinite(gap) ? 0.6 * gap : 0.6 * eP));
    const ej = eR(0);
    const calls = new Path2D();
    const puts = new Path2D();
    const grouped = P.barPlacement === 'grouped' && P.callVisible && P.putVisible;
    const half = grouped ? bw / 2 : bw;
    const rect = (path, a, b, y) => {
      const x = Math.min(a, b);
      const w = Math.max(Math.abs(b - a), 1);
      const top = Math.min(y, ej);
      const h = Math.max(Math.abs(y - ej), 1);
      path.rect(x, top, w, h);
    };
    const T = CA;
    const Lp = PU;
    for (let i = en; i <= eo; i++) {
      let call = P.callVisible ? T[i] ?? 0 : undefined;
      let put = P.putVisible ? Lp[i] ?? 0 : undefined;
      if (P.isNet) {
        const net = (T[i] ?? 0) + (Lp[i] ?? 0);
        call = P.callVisible ? Math.max(net, 0) : undefined;
        put = P.putVisible ? Math.min(net, 0) : undefined;
      }
      const a = eM(ee[i]);
      if (call !== undefined && call !== 0) rect(calls, grouped ? a - half : a - bw / 2, grouped ? a : a + bw / 2, eR(call));
      if (put !== undefined && put !== 0) rect(puts, grouped ? a : a - bw / 2, grouped ? a + half : a + bw / 2, eR(put));
    }
    o.fillStyle = '#00FF00';
    o.fill(calls);
    o.fillStyle = '#FF0000';
    o.fill(puts);
    const vline = (x) => {
      o.beginPath();
      o.moveTo(x, pt);
      o.lineTo(x, eb);
      o.stroke();
    };
    const O = MARK;
    if (O !== undefined && O >= e0 && O <= e1) {
      o.strokeStyle = prim;
      o.lineWidth = 2;
      o.setLineDash([4, 4]);
      vline(eM(O));
      o.setLineDash([]);
    }
    for (const m of P.markLines || []) {
      if (!Number.isFinite(m.value) || m.value < e0 || m.value > e1) continue;
      const x = eM(m.value);
      const col = m.color ?? prim;
      o.strokeStyle = col;
      o.lineWidth = m.width ?? 2;
      o.setLineDash([4, 4]);
      vline(x);
      o.setLineDash([]);
      if (m.label) {
        o.fillStyle = col;
        o.textBaseline = 'middle';
        if (m.labelPosition === 'middle') {
          o.textAlign = 'center';
          shadowText(m.label, x, pt + eO / 2 - 10);
        } else {
          o.textAlign = 'right';
          shadowText(m.label, x - 6, 20);
        }
      }
    }
    o.restore();
    cv.dataset.dom = JSON.stringify([dom.min, dom.max]);
    cv.dataset.auto = st.auto ? JSON.stringify([st.auto.min, st.auto.max]) : '';
    return true;
  }
  // The layout ref of a strike chart with a setter: each draw of QuantData draws ours and gets the fixed range.
  function syBox(st) {
    const box = layoutRef(st.c);
    if (!box) return null;
    if (!box[SY_MARK]) {
      let cur = box.current;
      box[SY_MARK] = { st };
      Object.defineProperty(box, 'current', {
        configurable: true,
        get: () => cur,
        set: (v) => {
          const s = box[SY_MARK].st;
          if (v && typeof v === 'object' && v.yDomain && s.on) {
            if (s.dom) v = { ...v, yDomain: { ...s.dom } };
            cur = v;
            try {
              s.drawn = syDraw(s, v);
            } catch (err) {
              s.drawn = false;
            }
            if (!s.dom && s.auto) cur = { ...cur, yDomain: { ...s.auto } }; // the automatic mode: the range we drew
            return;
          }
          cur = v;
        },
      });
    }
    box[SY_MARK].st = st;
    return box;
  }
  // The width of the value axis (2026-10-21: "das linke Ende vom Chart wandert nach rechts"): QuantData measures
  // its left padding with its leftAxisFormatter on the ticks of ITS automatic range, so the plot moved when that range
  // changed. During its draw (its draw ref: the function with yDomainMode), its props ref gives a formatter that
  // returns the widest label of our range; outside the draw (its crosshair label, its tooltip) the real one.
  const SY_HOOK = '__qdtsStrikeYHooks';
  function syHooks(st) {
    if (st.hooks && (st.hooks.D || performance.now() - st.hooks.at < 5000)) return st.hooks;
    st.hooks = { at: performance.now(), D: null };
    let f = fiberOf(st.c);
    if (f) f = current(f);
    for (let i = 0; f && i < 6; f = f.return, i++) {
      if (typeof f.type === 'string') continue;
      let I = null;
      let D = null;
      for (let h = f.memoizedState, j = 0; h && typeof h === 'object' && 'next' in h && j < 150; h = h.next, j++) {
        const b = h.memoizedState;
        if (!b || typeof b !== 'object' || !('current' in b)) continue;
        const v = b.current;
        if (!I && v && typeof v === 'object' && v.callValuesRef && v.xValuesRef && typeof v.leftAxisFormatter === 'function') I = b;
        else if (!D && typeof v === 'function' && /yDomainMode/.test(Function.prototype.toString.call(v))) D = b;
      }
      if (!I || !D) continue;
      const H = I[SY_HOOK] || D[SY_HOOK] || { st };
      H.st = st;
      if (!I[SY_HOOK]) {
        I[SY_HOOK] = H;
        let cur = I.current;
        let last = null;
        let copy = null;
        Object.defineProperty(I, 'current', {
          configurable: true,
          get: () => {
            const s = H.st;
            if (!s.on || !s.pad || !cur || typeof cur.leftAxisFormatter !== 'function') return cur;
            if (copy && last === cur && copy[SY_HOOK] === s.pad) return copy;
            const real = cur.leftAxisFormatter;
            const pad = s.pad;
            copy = { ...cur, leftAxisFormatter: (v) => (H.st.inMain ? pad : real(v)), [SY_HOOK]: pad };
            last = cur;
            return copy;
          },
          set: (v) => { cur = v; },
        });
      }
      if (!D[SY_HOOK]) {
        D[SY_HOOK] = H;
        const wrap = (g) => function syMainDraw(...args) {
          H.st.inMain = true;
          try {
            return g.apply(this, args);
          } finally {
            H.st.inMain = false;
          }
        };
        let fn = wrap(D.current);
        Object.defineProperty(D, 'current', { configurable: true, get: () => fn, set: (v) => { fn = wrap(v); } });
      }
      st.hooks = { at: performance.now(), D };
      return st.hooks;
    }
    return st.hooks;
  }
  function syOff(st) {
    st.on = false;
    if (st.ro) st.ro.disconnect();
    st.ro = null;
    st.pad = null;
    if (st.hooks && st.hooks.D) requestAnimationFrame(() => st.hooks.D.current()); // its own padding again
    if (st.own) st.own.remove();
    st.own = null;
    if (st.c) st.c.style.opacity = '';
    const box = layoutRef(st.c);
    if (box && box.current && st.auto) box.current = { ...box.current, yDomain: { ...st.auto } }; // st.on is false: no draw
  }
  // args: k (chart key), on, dom [min, max] or null (QuantData's automatic range until content.js fixes one).
  // Gives the automatic range of QuantData (its last draw) and whether ours is drawn.
  // hide: the chart loads (QuantData removes its header, its canvas moves and grows, it draws nothing): ours goes until
  // QuantData draws the new data (2026-10-21: the charts that load long jumped up and down).
  function strikeY({ k, on, dom, hide }) {
    const c = chartOf(k);
    let st = syCharts.get(k);
    if (!on) {
      if (st) syOff(st);
      syCharts.delete(k);
      return { ok: true };
    }
    if (!c || !syProps(c)) return { ok: false };
    if (!st || st.c !== c) {
      if (st) syOff(st);
      st = { c, on: true, dom: null, auto: null, own: null, drawn: false };
      syCharts.set(k, st);
    }
    st.on = true;
    const box = syBox(st);
    if (!box) return { ok: false };
    syHooks(st);
    if (hide) {
      if (st.own) st.own.style.visibility = 'hidden';
      st.dom = Array.isArray(dom) && dom[1] > dom[0] ? { min: dom[0], max: dom[1] } : null;
      return { ok: true, auto: st.auto && [st.auto.min, st.auto.max], drawn: false };
    }
    const next = Array.isArray(dom) && dom[1] > dom[0] ? { min: dom[0], max: dom[1] } : null;
    const changed = JSON.stringify(next) !== JSON.stringify(st.dom);
    st.dom = next;
    if (!st.auto && box.current && box.current.yDomain) st.auto = { ...box.current.yDomain };
    if (changed || !st.drawn || !st.own || !st.own.isConnected) {
      const L = box.current;
      if (L && L.yDomain) {
        // automatic: QuantData's own range of its last draw (the layout can hold the fixed range of before)
        const v = { ...L, yDomain: st.dom ? { ...st.dom } : st.auto ? { ...st.auto } : L.yDomain };
        st.internal = true;
        try {
          box.current = v; // through the setter: the fixed range into the layout, and ours drawn
        } finally {
          st.internal = false;
        }
      }
    }
    return { ok: true, auto: st.auto && [st.auto.min, st.auto.max], drawn: !!st.drawn };
  }
  // Data snapshots of the strike charts (the cache, 2026-10-27): the inputs of QuantData's renderer for 1 minute
  // (strikes, call and put values, the price line), a few KB, kept in the page world. content.js names the key (tool,
  // day, minute, the settings of the tool).
  const syCache = new Map(); // key -> { xs, calls, puts, mark, n }
  const SY_CACHE_MAX = 12000; // a safety limit; content.js drops the snapshots of the minutes it gives up (syDrop)
  function syKeep({ k, key }) {
    const c = chartOf(k);
    const P = c && syProps(c);
    const xs = P && P.xValuesRef.current;
    if (!P || !key || !xs || !xs.length) return { ok: false };
    const e = { xs: Array.from(xs), calls: Array.from(P.callValuesRef.current || []), puts: Array.from(P.putValuesRef.current || []), mark: P.markLineValue };
    e.n = (e.xs.length + e.calls.length + e.puts.length) * 8;
    syCache.delete(key);
    syCache.set(key, e);
    while (syCache.size > SY_CACHE_MAX) syCache.delete(syCache.keys().next().value);
    return { ok: true, n: e.n };
  }
  // Draws a snapshot (key) in a strike chart with our drawing now; key null: QuantData's own data again.
  function syShow({ k, key }) {
    const st = syCharts.get(k);
    if (!st || !st.on) return { ok: false };
    const e = key ? syCache.get(key) : null;
    if (key && !e) return { ok: false };
    st.virt = e;
    const box = syBox(st);
    const L = box && box.current;
    if (L && L.yDomain) {
      st.internal = true;
      try {
        box.current = { ...L, yDomain: st.dom ? { ...st.dom } : st.auto ? { ...st.auto } : L.yDomain };
      } finally {
        st.internal = false;
      }
    }
    return { ok: true };
  }
  // The price of each strike chart (its dashed price line, markLineValue, cents): the own price chart compares it with
  // its candles to find the minute of the strike charts (1.1).
  function spots({ ks }) {
    const out = [];
    for (const k of ks || []) {
      const c = chartOf(k);
      const P = c && syProps(c);
      if (P && Number.isFinite(P.markLineValue)) out.push({ k, spot: P.markLineValue });
    }
    return out;
  }
  // The y scale of a Stock Price / Time chart (1.1). Its renderer reads its props from a ref at each draw
  // (I.current = props) and knows 2 things that QuantData does not use there: verticalZoomRef with
  // verticalAxisValuesRef (the y range from values[zoom[0]] to values[zoom[1]], instead of the candles), and
  // horizontalMarkLines ({ value, color, width, label, includeInDomain }: values with includeInDomain widen the
  // automatic y range). The bridge puts its values into each new props object: the "current" of the props ref gets
  // a setter. Only the display in this browser changes; QuantData stores nothing of it.
  const pyBoxes = new WeakMap(); // chart canvas -> { box, extra }
  const PY_MARK = '__qdtsPriceY';
  function pyBox(canvas) {
    const known = pyBoxes.get(canvas);
    if (known && known.box.current && known.box.current.candleSeries) return known;
    let f = fiberOf(canvas);
    if (f) f = current(f);
    for (let i = 0; f && i < 6; f = f.return, i++) {
      if (typeof f.type === 'string') continue;
      for (const ff of [f, f.alternate]) {
        for (let h = ff && ff.memoizedState, j = 0; h && typeof h === 'object' && 'next' in h && j < 120; h = h.next, j++) {
          const b = h.memoizedState;
          if (!b || typeof b !== 'object' || !('current' in b) || !b.current || typeof b.current !== 'object' || !b.current.candleSeries || !b.current.zoomRef) continue;
          const r = { box: b, extra: {} };
          if (!b[PY_MARK]) {
            let cur = b.current;
            // The props object can be frozen (React keeps props read-only): the renderer gets a copy with our values.
            const add = (v) => {
              if (!v || typeof v !== 'object') return v;
              const ex = b[PY_MARK].extra;
              const own = Array.isArray(v.horizontalMarkLines) ? v.horizontalMarkLines.filter((x) => !x || !x[PY_MARK]) : [];
              if (!ex.range && !(ex.marks && ex.marks.length) && own.length === (v.horizontalMarkLines || []).length) return v;
              const out = { ...v, horizontalMarkLines: own.concat(ex.marks || []) };
              if (ex.range) {
                out.verticalAxisValuesRef = { current: ex.range };
                out.verticalZoomRef = { current: [0, 1] };
              } else {
                delete out.verticalAxisValuesRef;
                delete out.verticalZoomRef;
              }
              return out;
            };
            b[PY_MARK] = r;
            Object.defineProperty(b, 'current', { configurable: true, get: () => cur, set: (v) => { cur = add(v); } });
            r.add = add;
          }
          pyBoxes.set(canvas, b[PY_MARK]);
          return b[PY_MARK];
        }
      }
    }
    return null;
  }
  // Draw the chart again: its zoom bar's onChange with its own value (the chart's zoom frame listener draws). Only
  // where the bar has an onChange; the value stays the same.
  function pyRedraw(canvas) {
    const tool = canvas.closest('[class*="QDToolLayout-module__"][class*="__container"]');
    const root = tool && [...tool.querySelectorAll('[class*="QDChartZoomSlider-module__"]')].find((n) => [...n.classList].some((c) => /__root$/.test(c)));
    const f = root && find(root);
    if (!f || typeof f.props.onChange !== 'function') return false;
    const v = valueOf(f.props, f.props.dataLength);
    if (!v) return false;
    f.props.onChange([v[0], v[1]]);
    return true;
  }
  // args: k (chart key), range [lo, hi] (cents) or null (automatic), marks [cents] (into the automatic range).
  function priceY({ k, range, marks }) {
    const c = chartOf(k);
    const r = c && pyBox(c);
    if (!r) return { ok: false };
    r.extra = {
      range: Array.isArray(range) && range[1] > range[0] ? [range[0], range[1]] : null,
      marks: (marks || []).filter(Number.isFinite).map((value) => ({ value, includeInDomain: true, color: 'rgba(0, 0, 0, 0)', width: 0.001, [PY_MARK]: 1 })),
    };
    r.box.current = r.box.current; // the setter makes the copy with the new values
    return { ok: true, redraw: pyRedraw(c) };
  }
  // The legend values of a time chart (1.1): QuantData's legend shows the LAST value of each series (in a replay the
  // end of the day: you see where the price goes). Per chart canvas: its series (renderer props: series[].values,
  // candleSeries.closes), the last finite value, and the value at the right end of the visible range (zoomRef: rows).
  // at: per chart key the row of the replay minute (the own chart: its zoom bar shows the visible candles).
  function legendVals({ ks, at }) {
    const out = [];
    for (const k of ks || []) {
      const c = chartOf(k);
      let f = c && fiberOf(c);
      if (f) f = current(f);
      let p = null;
      for (let i = 0; f && i < 4 && !p; f = f.return, i++) {
        const q = f.memoizedProps;
        if (q && typeof q === 'object' && Array.isArray(q.timestamps) && q.zoomRef && (Array.isArray(q.series) || q.candleSeries)) p = q;
      }
      if (!p || !p.timestamps.length) continue;
      const n = p.timestamps.length;
      const z = p.zoomRef.current;
      const own = at && Number.isFinite(at[k]) ? at[k] : null;
      const r = own != null ? Math.max(0, Math.min(n - 1, own)) : Array.isArray(z) ? Math.max(0, Math.min(n - 1, z[1] ?? n - 1)) : n - 1;
      const lastAt = (vals, upTo) => {
        for (let i = Math.min(upTo, vals.length - 1); i >= 0; i--) if (Number.isFinite(vals[i])) return vals[i];
        return null;
      };
      const series = (p.series || []).filter((x) => x && Array.isArray(x.values)).map((x) => x.values);
      if (p.candleSeries && Array.isArray(p.candleSeries.closes)) series.push(p.candleSeries.closes);
      out.push({ k, r, n, end: r >= n - 1, vals: series.map((v) => [lastAt(v, v.length - 1), lastAt(v, r)]) });
    }
    return out;
  }
  // The candles of a price chart for the backtest trade (1.1): the row at the right end of the visible range (the
  // replay minute), its time and close, and the rows [time, high, low, close] from the first row at or after `from`
  // (epoch ms) up to it. Prices in cents.
  function tradeRows({ k, from }) {
    const c = chartOf(k);
    let f = c && fiberOf(c);
    if (f) f = current(f);
    let p = null;
    for (let i = 0; f && i < 4 && !p; f = f.return, i++) {
      const q = f.memoizedProps;
      if (q && typeof q === 'object' && q.candleSeries && Array.isArray(q.candleSeries.closes) && Array.isArray(q.timestamps) && q.zoomRef) p = q;
    }
    if (!p || !p.timestamps.length) return { ok: false };
    const s = p.candleSeries;
    const ts = p.timestamps;
    const n = Math.min(ts.length, s.closes.length);
    const z = p.zoomRef.current;
    const r = Array.isArray(z) ? Math.max(0, Math.min(n - 1, z[1] ?? n - 1)) : n - 1;
    const rows = [];
    if (Number.isFinite(from)) {
      for (let i = 0; i <= r; i++) if (ts[i] >= from) rows.push([ts[i], s.highs[i], s.lows[i], s.closes[i]]);
    }
    return { ok: true, n, r, t: ts[r], c: s.closes[r], first: ts[0], rows };
  }
  // The data of the own chart window (1.1): the 1-minute candles of the Stock Price / Time chart of a ticker (the one
  // with the newest data) and the Net Drift series of the ticker (call, put, net premium; cents). Sent only when they
  // changed (have: the versions that content.js has); live, QuantData changes the last values in the same arrays.
  function toolTitle(el) {
    const tool = el.closest('[class*="QDToolLayout-module__"][class*="__container"]');
    const t = tool && tool.querySelector('[class*="QDChartHeader-module__"][class*="__title"]');
    return t ? t.textContent.trim() : '';
  }
  function rendererProps(c, ok) {
    let f = fiberOf(c);
    if (f) f = current(f);
    for (let i = 0; f && i < 4; f = f.return, i++) {
      const q = f.memoizedProps;
      if (q && typeof q === 'object' && ok(q)) return q;
    }
    return null;
  }
  function chartData({ k, tk, have }) {
    const T = String(tk || '').toUpperCase();
    const ends = (title) => title.toUpperCase().replace(/\s+/g, ' ').endsWith(`- ${T}`);
    let price = null;
    let drift = null;
    for (const c of k != null ? [chartOf(k)].filter(Boolean) : document.querySelectorAll('[data-qdts-chart]')) {
      if (c.closest('#qd-time-sync-freeze')) continue;
      const title = toolTitle(c);
      if (k != null) {
        price = rendererProps(c, (q) => q.candleSeries && Array.isArray(q.candleSeries.closes) && Array.isArray(q.timestamps));
        if (price && !price.timestamps.length) price = null;
        break;
      }
      if (!ends(title)) continue;
      if (/stock price/i.test(title)) {
        const p = rendererProps(c, (q) => q.candleSeries && Array.isArray(q.candleSeries.closes) && Array.isArray(q.timestamps));
        if (p && p.timestamps.length && (!price || p.timestamps[p.timestamps.length - 1] > price.timestamps[price.timestamps.length - 1])) price = p;
      } else if (/net drift/i.test(title)) {
        const p = rendererProps(c, (q) => Array.isArray(q.series) && Array.isArray(q.timestamps));
        if (p && p.timestamps.length) drift = p;
      }
    }
    const out = { ok: !!price };
    if (price) {
      const s = price.candleSeries;
      const ts = price.timestamps;
      const n = Math.min(ts.length, s.closes.length);
      const v = `${n}|${ts[0]}|${ts[n - 1]}|${s.opens[n - 1]}|${s.highs[n - 1]}|${s.lows[n - 1]}|${s.closes[n - 1]}`;
      out.p = have && have.p === v ? { v } : { v, t: ts.slice(0, n), o: s.opens.slice(0, n), h: s.highs.slice(0, n), l: s.lows.slice(0, n), c: s.closes.slice(0, n),
        up: s.bullishColor || null, down: s.bearishColor || null };
    }
    if (drift) {
      const find = (re) => drift.series.find((q) => q && re.test(String(q.id || '')));
      const ser = (re) => {
        const x = find(re);
        return x && Array.isArray(x.values) ? x.values : null;
      };
      const colors = { call: (find(/call/i) || {}).color || null, put: (find(/put/i) || {}).color || null, net: (find(/net/i) || {}).color || null };
      const call = ser(/call/i);
      const put = ser(/put/i);
      const net = ser(/net/i);
      const ts = drift.timestamps;
      const n = ts.length;
      const last = (a) => (a ? a[a.length - 1] : '');
      const v = `${n}|${ts[0]}|${ts[n - 1]}|${last(call)}|${last(put)}|${last(net)}`;
      out.n = have && have.n === v ? { v } : { v, t: ts.slice(), call: call && call.slice(), put: put && put.slice(), net: net && net.slice(), colors };
    }
    return out;
  }
  // The own price chart (1.1) sets its zoom bar to the visible candles: rows l..r with onChange (at once), and with
  // onChangeEnd too when end (QuantData stores the zoom only then).
  function setRows({ k, l, r, end }) {
    const root = document.querySelector(`[data-qdts-bar="${k}"]`);
    const f = root && find(root);
    if (!f) return { ok: false };
    const n = f.props.dataLength;
    const v = [Math.max(0, Math.min(n - 1, l)), Math.max(0, Math.min(n - 1, r))];
    if (typeof f.props.onChange === 'function') f.props.onChange(v);
    if (end && typeof f.props.onChangeEnd === 'function') f.props.onChangeEnd(v);
    return { ok: true, v };
  }
  // The rows of a zoom bar now (during your drag: its live value).
  function barRows({ k }) {
    const root = document.querySelector(`[data-qdts-bar="${k}"]`);
    const f = root && find(root);
    if (!f) return { ok: false };
    const p = f.props;
    const n = p.dataLength;
    const lv = p.liveValueRef && Array.isArray(p.liveValueRef.current) ? p.liveValueRef.current : null;
    const v = lv ? [lv[0] ?? 0, lv[1] ?? n - 1] : valueOf(p, n);
    return v ? { ok: true, v } : { ok: false };
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
      // The price scale of a Stock Price / Time chart (cents; REALSITE-1.md section 14): for the price lines.
      if (L.leftDomain && typeof L.leftDomain.min === 'number' && typeof L.leftDomain.max === 'number') Object.assign(out, { pMin: L.leftDomain.min, pMax: L.leftDomain.max });
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
  // Snapshot cache, stage A (2026-10-24; REALSITE-1.md section 20). A step sends per tool with a time slider
  // PUT /api/tool (the settings with metadata.numberOfMinutesIntoMarketOpen), then GET /api/options/.../<toolId> (the
  // data; the minute is not in the URL). The data of a minute that was loaded before comes from memory: the GET is not
  // sent. The PUT always goes to the server (QuantData stores the time, the other sessions follow).
  // The key: the tool, its settings of the last PUT that the server answered with 2xx, the day of its date chip, the
  // value of its time slider when the GET starts and the URL. Not cached: a tool without a time slider on the page, a
  // live tool (numberOfMinutesIntoMarketOpen null) and a slider near the live end (content.js sets data-qdts-live).
  const SNAP_MAX = 256 * 1024 * 1024; // characters (about the bytes of the JSON): a safety limit; the list sets the minutes per tool
  const snap = new Map(); // key -> { text, headers, url } (Map order: the oldest first)
  const snapStat = { bytes: 0, hits: 0, misses: 0, fast: 0, on: false, fastOn: false, maxPer: 400 }; // off until content.js says on (cfg.snap; off by default since 2026-10-26: some steps did not load)
  const snapWhy = {}; // why a request was not cached (for the report and the real-site checks)
  const why = (k) => { snapWhy[k] = (snapWhy[k] || 0) + 1; return null; };
  // The last events with their times (for the report: where the time of a step goes).
  const snapLog = [];
  const slog = (ev, id) => {
    snapLog.push([Math.round(performance.now()), ev, String(id || '').slice(0, 8)]);
    document.dispatchEvent(new CustomEvent('qdts:blog', { detail: `${ev}|${String(id || '').slice(0, 8)}` })); // the debug log (content.js)
    if (snapLog.length > 60) snapLog.shift();
  };
  // toolId -> the last PUT: { key (null: live), done, ok (2xx), waiters }. Since QuantData's release of 2026-10-26 the
  // page sends the GET about 100 ms after the PUT, before the PUT answer: a GET answer is kept when its PUT ends with 2xx.
  const putState = new Map();
  const putBase = new Map(); // toolId -> { meta, filter, off }: its last saved settings (off: PUT minute - slider value)
  const SNAP_AFTER_PUT = 150;
  const putEnd = (id, key, ok) => {
    const st = putState.get(id);
    if (!st || st.key !== key || st.done) return;
    st.done = true;
    st.ok = ok;
    st.at = performance.now();
    for (const f of st.waiters.splice(0)) f(ok);
  };
  const putCount = new Map(); // toolId -> PUTs sent (content.js: the next move waits until QuantData has saved the last)
  const lastResp = new Map(); // toolId -> the text of its last data answer (an equal answer for a new minute is stale)
  const lastPut = new Map(); // toolId -> { text, headers } of the last 2xx answer to its PUT (the form of a quick answer)
  const lastGet = new Map(); // toolId -> URL of its last data GET
  const SNAP_GET = /\/api\/options\/[^?#]*\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[?#]|$)/i;
  const SNAP_DAY = /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/;
  const stable = (v) => (v && typeof v === 'object'
    ? Array.isArray(v) ? `[${v.map(stable).join(',')}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
    : JSON.stringify(v));
  // The time slider of a tool, its day and its live mark; null: the tool has no time slider on the page.
  function snapSlider(toolId) {
    for (const el of document.querySelectorAll('[data-qdts-slider]')) {
      if (el.closest('#qd-time-sync-freeze')) continue;
      let f = fiberOf(el);
      let id = null;
      for (let i = 0; f && i < 80; f = f.return, i++) {
        const p = f.memoizedProps;
        if (p && typeof p === 'object' && typeof p.toolId === 'string' && p.toolId) { id = p.toolId; break; }
      }
      if (id !== toolId) continue;
      const tool = el.closest('[class*="QDToolLayout-module__"][class*="__container"]');
      let day = '';
      for (const c of tool ? tool.querySelectorAll('*') : []) {
        if (c.children.length) continue;
        const t = (c.textContent || '').trim();
        if (SNAP_DAY.test(t)) { day = t; break; }
      }
      const value = el.getAttribute('aria-valuenow') ?? el.value;
      const cut = el.getAttribute('data-qdts-livecut');
      return { value, day, live: !!cut && Number(value) >= Number(cut) };
    }
    return null;
  }
  function snapKey(toolId, url) {
    const st = putState.get(toolId);
    if (!st) return why('noPut');
    if (!st.key) return why('putLive');
    if (st.done && !st.ok) return why('putFail');
    const k = st.key;
    const sl = snapSlider(toolId);
    if (!sl) return why('noSlider');
    if (sl.live) return why('live');
    if (!sl.day || sl.value == null) return why('noDay');
    // No slider value in the key: the minute of the data is the one of the PUT (numberOfMinutesIntoMarketOpen in k).
    // With the slider value, a step in a jump (PUT of one minute, the slider already at the next) kept the data
    // under a key that no later visit had (debug log, 2026-10-27: 30 misses "other numberOfMinutesIntoMarketOpen").
    return `${k}|${sl.day}|-|${url}`;
  }
  function snapStore(key, text, headers, url) {
    if (snap.has(key)) snapStat.bytes -= snap.get(key).text.length;
    snap.delete(key);
    snap.set(key, { text, headers, url });
    snapStat.bytes += text.length;
    // Max snapStat.maxPer minutes per tool (the list: Size), the oldest go first.
    const id = key.slice(0, key.indexOf('|'));
    let n = 0;
    for (const k of snap.keys()) if (k.startsWith(id + '|')) n++;
    for (const [k, v] of snap) {
      if (n <= snapStat.maxPer) break;
      if (!k.startsWith(id + '|')) continue;
      snap.delete(k);
      snapStat.bytes -= v.text.length;
      n--;
    }
    for (const [k, v] of snap) {
      if (snapStat.bytes <= SNAP_MAX) break;
      snap.delete(k);
      snapStat.bytes -= v.text.length;
    }
  }
  // Answer an XHR from memory, like the browser does: readyState 4, status 200, then readystatechange, load, loadend.
  function snapServe(xhr, e, toolId, delay) {
    const hdr = {};
    for (const line of e.headers.split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) hdr[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    const type = xhr.responseType;
    const def = (k, v) => Object.defineProperty(xhr, k, { configurable: true, get: () => v });
    xhr.__qdSnapT = setTimeout(() => {
      xhr.__qdSnapT = 0;
      def('readyState', 4);
      def('status', 200);
      def('statusText', 'OK');
      def('responseURL', e.url);
      def('responseText', e.text);
      def('response', type === 'json' ? JSON.parse(e.text) : e.text);
      xhr.getResponseHeader = (n) => hdr[String(n).toLowerCase()] ?? null;
      xhr.getAllResponseHeaders = () => e.headers;
      xhr.dispatchEvent(new Event('readystatechange'));
      const n = e.text.length;
      for (const t of ['load', 'loadend']) xhr.dispatchEvent(new ProgressEvent(t, { lengthComputable: true, loaded: n, total: n }));
      // The data of this tool came from memory (content.js: its freeze copy can go at once).
      if (toolId) document.dispatchEvent(new CustomEvent('qdts:snapserved', { detail: toolId }));
    }, Math.max(0, delay || 0));
  }
  try {
    const XP = XMLHttpRequest.prototype;
    const oOpen = XP.open;
    const oSend = XP.send;
    const oAbort = XP.abort;
    const oSet = XP.setRequestHeader;
    XP.setRequestHeader = function (n, v) {
      (this.__qdHdr || (this.__qdHdr = [])).push([n, v]);
      return oSet.call(this, n, v);
    };
    // A quick answer (2026-10-24: the charts did not load at once, because the page waits for the PUT before
    // it sends the GET): when the data of the new minute is in memory, the page gets the answer to its PUT at once (the
    // last real answer of the server for this tool, with the new settings in it), so its GET comes at once and is answered
    // from memory too. The real PUT still goes to the server, in the background with the same headers, so the server
    // stores the time (a reload and the other sessions follow). If it fails, this key does not count as stored.
    function snapFast(xhr, q, b, key, body) {
      const lp = lastPut.get(b.id);
      const url = lastGet.get(b.id);
      if (!lp || !url) return false;
      const sl = snapSlider(b.id);
      if (!sl || sl.live || !sl.day || sl.value == null || !snap.has(`${key}|${sl.day}|-|${url}`)) return false;
      let text;
      try {
        const now = Date.now();
        const put = (o) => {
          if (Array.isArray(o)) o.forEach(put);
          else if (o && typeof o === 'object') {
            if (o.id === b.id && 'metadata' in o) {
              o.metadata = b.metadata;
              if ('filterGroupIds' in o && b.filterGroupIds) o.filterGroupIds = b.filterGroupIds;
              if ('lastUpdatedTime' in o) o.lastUpdatedTime = now;
            }
            for (const v of Object.values(o)) put(v);
          }
        };
        const o = JSON.parse(lp.text);
        put(o);
        text = JSON.stringify(o);
      } catch {
        return false;
      }
      const r = new XMLHttpRequest();
      oOpen.call(r, 'PUT', q.url, true);
      r.withCredentials = xhr.withCredentials;
      for (const [n, v] of xhr.__qdHdr || []) oSet.call(r, n, v);
      r.addEventListener('readystatechange', () => {
        if (r.readyState !== 4) return;
        slog(`bgPutEnd${r.status}`, b.id);
        if (r.status >= 200 && r.status < 300) {
          try { lastPut.set(b.id, { text: r.responseText, headers: r.getAllResponseHeaders() }); } catch {}
        } else {
          why(`bgPut:${r.status}`);
          const st = putState.get(b.id);
          if (st && st.key === key) st.ok = false;
          // The page did not see this answer: a rate limit still pauses Play (content.js, like QuantData's message).
          if (r.status === 429) document.dispatchEvent(new CustomEvent('qdts:ratelimit'));
        }
      });
      oSend.call(r, body);
      putEnd(b.id, key, true); // the page has its answer; a failed background save sets ok false
      xhr.__qdPut = null;
      snapStat.fast++;
      snapServe(xhr, { text, headers: lp.headers, url: q.url });
      return true;
    }
    // A save of the tool settings (PUT /api/tool) that fails with status 0 ("Network Error") is sent once more after
    // 250 ms. Seen in Safari (debug log, 2026-10-27): 3 of 4 PUTs of a step failed in the same ms, then QuantData kept
    // these charts loading for 15 s. The page sees only the answer of the 2nd try.
    function putRetry(xhr, pt) {
      if (xhr.status !== 0 || xhr.__qdRetry || xhr.__qdPageAbort || !/\/api\/tool(?:[?#]|$)/.test(xhr.__qdSnap?.url || '')) return false;
      xhr.__qdRetry = 1;
      slog('putRetry', pt.id);
      setTimeout(() => {
        const r = new XMLHttpRequest();
        oOpen.call(r, 'PUT', xhr.__qdSnap.url, true);
        r.withCredentials = xhr.withCredentials;
        for (const [n, v] of xhr.__qdHdr || []) oSet.call(r, n, v);
        const done = () => {
          const def = (k, v) => Object.defineProperty(xhr, k, { configurable: true, get: () => v });
          let text = '';
          try { text = r.responseText; } catch {}
          def('readyState', 4);
          def('status', r.status);
          def('statusText', r.statusText);
          def('responseURL', r.responseURL);
          def('responseText', text);
          def('response', xhr.responseType === 'json' ? (() => { try { return JSON.parse(text); } catch { return null; } })() : text);
          xhr.getResponseHeader = (n) => r.getResponseHeader(n);
          xhr.getAllResponseHeaders = () => r.getAllResponseHeaders();
          xhr.__qdRetry = 2;
          xhr.dispatchEvent(new Event('readystatechange'));
          const ok = r.status >= 200 && r.status < 300;
          const n = text.length;
          for (const t of ok || r.status ? ['load', 'loadend'] : ['error', 'loadend']) xhr.dispatchEvent(new ProgressEvent(t, { lengthComputable: true, loaded: n, total: n }));
        };
        r.addEventListener('loadend', done);
        oSend.call(r, xhr.__qdBody);
      }, 250);
      return true;
    }
    XP.open = function (method, url, ...rest) {
      try {
        this.__qdSnap = { m: String(method).toUpperCase(), url: new URL(String(url), location.href).href };
        // The answer of a PUT /api/tool: before the page's own handlers (they are set after open; the page starts the
        // GET of the data in them, so the key must be ready then).
        if (this.__qdSnap.m === 'PUT' && !this.__qdSnapL) {
          this.__qdSnapL = true;
          // While a failed save is sent again, the page does not see the events of the failure.
          for (const t of ['error', 'load', 'loadend', 'abort', 'timeout']) {
            this.addEventListener(t, (ev) => {
              if (this.__qdRetry === 1) ev.stopImmediatePropagation();
            });
          }
          this.addEventListener('readystatechange', (ev) => {
            if (this.__qdRetry === 1) {
              ev.stopImmediatePropagation();
              return;
            }
            const pt = this.__qdPut;
            if (this.readyState !== 4 || !pt) return;
            if (putRetry(this, pt)) {
              ev.stopImmediatePropagation();
              return;
            }
            this.__qdPut = null;
            if (this.status >= 200 && this.status < 300) {
              try {
                lastPut.set(pt.id, { text: this.responseType === 'json' ? JSON.stringify(this.response) : this.responseText, headers: this.getAllResponseHeaders() });
              } catch {}
            }
            slog(`putEnd${this.status}`, pt.id);
            putEnd(pt.id, pt.key, this.status >= 200 && this.status < 300);
            if (this.status < 200 || this.status >= 300) why(`putEnd:${this.status}`);
          });
        }
      } catch {
        this.__qdSnap = null;
      }
      return oOpen.call(this, method, url, ...rest);
    };
    XP.send = function (body) {
      const q = this.__qdSnap;
      this.__qdBody = body;
      try {
        if (q && q.m === 'PUT' && /\/api\/tool(?:[?#]|$)/.test(q.url)) why(`put:${typeof body}`);
        if (q && q.m === 'PUT' && /\/api\/tool(?:[?#]|$)/.test(q.url) && typeof body === 'string') {
          const b = JSON.parse(body);
          if (b && typeof b.id === 'string' && b.metadata && typeof b.metadata === 'object') {
            const live = b.metadata.numberOfMinutesIntoMarketOpen == null;
            const key = live ? null : `${b.id}|${stable(b.metadata)}|${stable(b.filterGroupIds || [])}`;
            putCount.set(b.id, (putCount.get(b.id) || 0) + 1);
            const prev = putState.get(b.id);
            if (prev && !prev.done) putEnd(b.id, prev.key, false); // a newer PUT: the older one does not count any more
            putState.set(b.id, { key, done: false, ok: false, waiters: [] });
            // The form of the next keys of this tool (op snapHas: is the data of a minute in the cache?)
            if (!live) {
              const sl = snapSlider(b.id);
              if (sl && sl.value != null) putBase.set(b.id, { meta: b.metadata, filter: b.filterGroupIds || [], off: b.metadata.numberOfMinutesIntoMarketOpen - sl.value });
            }
            this.__qdPut = { id: b.id, key };
            if (key && snapStat.on && snapStat.fastOn && snapFast(this, q, b, key, body)) {
              slog('putFast', b.id);
              return undefined;
            }
            slog(key ? 'put' : 'putLive', b.id);
          }
        } else if (q && q.m === 'GET' && snapStat.on) {
          const m = SNAP_GET.exec(q.url);
          if (m) lastGet.set(m[1], q.url);
          if (m && !(this.responseType === '' || this.responseType === 'text' || this.responseType === 'json')) why(`type:${this.responseType}`);
          const key = m && (this.responseType === '' || this.responseType === 'text' || this.responseType === 'json') ? snapKey(m[1], q.url) : null;
          if (m && !key) slog('getNoKey', m[1]);
          if (key) {
            const e = snap.get(key);
            if (e) {
              snap.delete(key); // the newest at the end: it goes last
              snap.set(key, e);
              snapStat.hits++;
              slog('getMem', m[1]);
              lastResp.set(m[1], e.text);
              // Answer only SNAP_AFTER_PUT ms after the answer to the tool's PUT. A data answer before it (or just
              // after it) left the chart in QuantData's loading state for 15 s (debug log of 2026-10-27).
              const st = putState.get(m[1]);
              if (st && !st.done) {
                const xhr = this;
                let gone = false;
                const go = (ok) => {
                  if (gone || xhr.__qdSnapGone) return;
                  gone = true;
                  clearTimeout(xhr.__qdSnapT);
                  xhr.__qdSnapT = 0;
                  if (ok) snapServe(xhr, e, m[1], SNAP_AFTER_PUT);
                  else {
                    slog('getNetLate', m[1]);
                    oSend.call(xhr, body);
                  }
                };
                st.waiters.push(go);
                this.__qdSnapT = setTimeout(() => go(false), 2000);
                return undefined;
              }
              snapServe(this, e, m[1], st && st.at ? st.at + SNAP_AFTER_PUT - performance.now() : 0);
              return undefined;
            }
            snapStat.misses++;
            // Why not from memory (the debug log): an entry of this tool, day, URL and minute with other settings
            // ('getNetSet:<names>'), or none of this minute ('getNet:<minute>').
            const tail = key.slice(key.indexOf('|', key.lastIndexOf('}') + 1));
            const meta = (k) => { try { return JSON.parse(k.slice(k.indexOf('|') + 1, k.lastIndexOf('}') + 1)); } catch { return {}; } };
            const mine = meta(key);
            const mm = mine.numberOfMinutesIntoMarketOpen;
            let diff = null;
            for (const k of snap.keys()) {
              if (!k.startsWith(m[1] + '|') || !k.endsWith(tail)) continue;
              const o = meta(k);
              if (o.numberOfMinutesIntoMarketOpen !== mm) continue;
              diff = [...new Set([...Object.keys(o), ...Object.keys(mine)])].filter((n) => stable(o[n]) !== stable(mine[n])).join(',') || 'filter';
            }
            slog(diff ? `getNetSet:${diff.slice(0, 120)}` : `getNet:${mm}`, m[1]);
            const st = putState.get(m[1]);
            this.addEventListener('load', () => {
              slog(`getEnd${this.status}`, m[1]);
              try {
                const text = this.responseType === 'json' ? JSON.stringify(this.response) : this.responseText;
                const prev = lastResp.get(m[1]);
                if (typeof text === 'string') lastResp.set(m[1], text);
                if (this.status !== 200 || typeof text !== 'string' || text.length >= 4e6) return;
                if (text === prev) { why('same'); return; } // the answer of the minute before: maybe stale, not kept
                const headers = this.getAllResponseHeaders();
                const keep = (ok) => (ok ? snapStore(key, text, headers, q.url) : why('putFail'));
                if (st && st.done) keep(st.ok);
                else if (st) st.waiters.push(keep);
              } catch {}
            });
          }
        }
      } catch {}
      return oSend.call(this, body);
    };
    XP.abort = function () {
      this.__qdPageAbort = true;
      if (this.__qdSnapT) {
        this.__qdSnapGone = true;
        clearTimeout(this.__qdSnapT);
        this.__qdSnapT = 0;
        return undefined;
      }
      return oAbort.call(this);
    };
  } catch {}
  function snapOp(a) {
    if (a && typeof a.on === 'boolean') snapStat.on = a.on;
    if (a && typeof a.fast === 'boolean') snapStat.fastOn = a.fast;
    if (a && Number.isFinite(a.maxPer) && a.maxPer > 0) snapStat.maxPer = a.maxPer;
    if (a && a.clear) {
      syCache.clear();
      snap.clear();
      snapStat.bytes = 0;
    }
    return { ok: true, on: snapStat.on, n: snap.size, bytes: snapStat.bytes, hits: snapStat.hits, misses: snapStat.misses, fast: snapStat.fast, fastOn: snapStat.fastOn, why: snapWhy, log: a && a.log ? snapLog.slice() : undefined };
  }
  // The chips of a price chart (the custom chart, 2026-10-28): its chart type and its candle period from the tool settings.
  function toolMeta({ k }) {
    const c = chartOf(k);
    let f = c && fiberOf(c);
    if (f) f = current(f); // the fiber on the screen (the other one can hold the settings of before)
    for (let i = 0; f && i < 40; f = f.return, i++) {
      const t = f.memoizedProps && f.memoizedProps.tool;
      if (t && t.metadata && typeof t.metadata === 'object') return { ok: true, id: t.id, chartType: t.metadata.chartType || null, agg: t.metadata.aggregationPeriodType || null };
    }
    return { ok: false };
  }
  // Is the data of these minutes in the cache? q: [[toolId, slider value], ...] (the budget: a step to a minute in the
  // cache sends no data request).
  function snapHas(a) {
    const has = [];
    for (const [id, v] of (a && a.q) || []) {
      const base = putBase.get(id);
      const url = lastGet.get(id);
      const sl = snapSlider(id);
      if (!snapStat.on || !base || !url || !sl || !sl.day || sl.live) { has.push(false); continue; }
      const meta = { ...base.meta, numberOfMinutesIntoMarketOpen: v + base.off };
      has.push(snap.has(`${id}|${stable(meta)}|${stable(base.filter)}|${sl.day}|-|${url}`));
    }
    return { ok: true, has };
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
      else if (req.op === 'priceY') result = priceY(req.args);
      else if (req.op === 'legendVals') result = legendVals(req.args);
      else if (req.op === 'tradeRows') result = tradeRows(req.args);
      else if (req.op === 'chartData') result = chartData(req.args);
      else if (req.op === 'setRows') result = setRows(req.args);
      else if (req.op === 'strikeY') result = strikeY(req.args);
      else if (req.op === 'spots') result = spots(req.args);
      else if (req.op === 'barRows') result = barRows(req.args);
      else if (req.op === 'snap') result = snapOp(req.args);
      else if (req.op === 'snapHas') result = snapHas(req.args);
      else if (req.op === 'toolMeta') result = toolMeta(req.args);
      else if (req.op === 'putSeq') result = Object.fromEntries(putCount);
      else if (req.op === 'syKeep') result = syKeep(req.args);
      else if (req.op === 'syDrop') { for (const k of [...syCache.keys()]) if (k.startsWith(`${req.args.key}|`)) syCache.delete(k); result = { ok: true }; }
      else if (req.op === 'syShow') result = syShow(req.args);
      else if (req.op === 'syHas') result = (req.args.keys || []).map((x) => syCache.has(x));
      else if (req.op === 'syDump') result = [...syCache].map(([k, e]) => [k, e.xs.length, e.puts.slice(0, 6)]);
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
  // QuantData's class names
  // ---------------------------------------------------------------------------
  // A QuantData release (2026-10-26) changed its CSS module class names from "QDToolLayout-module__FTycCG__container"
  // to "FTycCG_container" (the module name is gone, the hash stays). This code finds the page parts by the old form, so
  // each element with a class of a known module also gets the old name as an extra class. QuantData's styles do not use
  // these names, so the page looks the same. A hash that is not in the list is learned from a class name that only
  // that module has (for example "toolContentContainer"), because a hash can change with a release.
  const QD_HASH = {
    FTycCG: 'QDToolLayout', '95NJjG': 'QDChartHeader', gFACoq: 'QDChartLegendItem', '8jmYzG': 'QDToolHistoricalStatus',
    gUgvFa: 'QDInfinitePlane', jKT0Ya: 'QDInfinitePlacement', Va5dxa: 'QDChartZoomSlider', u0T5hW: 'nativeChartSurface',
    'Y-zvlG': 'QDBaseChart', R77Y8G: 'QDChartLoadingPlaceholder', gacg7a: 'QDHeader', qBmrPW: 'QDTimeSlider',
  };
  const QD_LEARN = {
    toolContentContainer: 'QDToolLayout', chartHeader: 'QDChartHeader', chartLegendItem: 'QDChartLegendItem',
    previewHighlight: 'QDChartZoomSlider', rootVertical: 'QDChartZoomSlider', desktopRow: 'QDHeader', plane: 'QDInfinitePlane',
  };
  // A hash that starts with a digit gets a "_" in front ("_95NJjG_title"), because a class name cannot start with a digit.
  const QD_CLASS = /^_?([A-Za-z0-9_-]{6})_([A-Za-z][A-Za-z0-9]*)$/;
  function qdAlias(el) {
    const cl = el.classList;
    if (!cl || !cl.length) return;
    let add = null;
    for (const c of cl) {
      if (c.length < 8 || c.indexOf('-module__') >= 0) continue;
      const m = QD_CLASS.exec(c);
      if (!m) continue;
      let mod = QD_HASH[m[1]];
      if (!mod && QD_LEARN[m[2]]) {
        mod = QD_LEARN[m[2]];
        QD_HASH[m[1]] = mod;
        queueMicrotask(() => qdAliasTree(document.documentElement)); // its parts that came before this element
      }
      if (!mod) continue;
      const old = `${mod}-module__${m[1]}__${m[2]}`;
      if (!cl.contains(old)) (add || (add = [])).push(old);
    }
    if (add) cl.add(...add);
  }
  function qdAliasTree(root) {
    if (root.nodeType !== 1) return;
    qdAlias(root);
    for (const el of root.querySelectorAll('[class]')) qdAlias(el);
  }
  const qdAliasList = (list) => {
    for (const r of list) {
      if (r.type === 'attributes') qdAlias(r.target);
      else for (const n of r.addedNodes) qdAliasTree(n);
    }
  };
  let qdAliasObs = null;
  // The page can render again in the same task as our code (a key press): take the changes now, before a search.
  const qdAliasFlush = () => { if (qdAliasObs) qdAliasList(qdAliasObs.takeRecords()); };
  try {
    qdAliasTree(document.documentElement);
    qdAliasObs = new MutationObserver(qdAliasList);
    qdAliasObs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  } catch (err) {
    console.warn('[QD Toolkit] class names', err);
  }


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
    sd: { on: true, vix: null, close: {}, levels: [1, 2], info: false, charts: {} }, localTime: false, h24: true,
    trade: null, tradeOn: false, ownChart: true, syOn: true, sy: {}, ocGrid: { show: 'off', style: 'solid', op: 10 }, pl: { w: 1, step: 5, fit: true }, plines: {} };
  const hadCfg = (() => { try { return !!localStorage.getItem(STORE_KEY); } catch { return false; } })(); // a user of before (onboarding)
  let cfg = loadCfg();
  delete cfg.zoomRange; // Own zoom ranges (version 1.10) are not used any more.
  delete cfg.moveBudget; // The rate-limit budget (versions 1.8–1.11) is not used any more.
  delete cfg.budget;
  delete cfg.arrows; // Since 1.14 the arrow keys always move all sliders (no option).
  delete cfg.zoomSafe; // Since 1.13 the right end of a zoom bar is at the synced minute (no option).
  delete cfg.ocMinW; // The candle width of the custom price chart (removed on 2026-10-28).
  delete cfg.cw; // The chart window of the 1.1 draft is gone: the own chart replaces the price charts in their place.
  delete cfg.chartOn;
  if (typeof cfg.tradeOn === 'string') cfg.tradeOn = true; // up to the 1.1 draft of 2026-10-21: the ticker of the pill
  delete cfg.ghost; // The exposure ghost of the 1.1 draft is gone (2026-10-21).
  delete cfg.ghostMarks;
  delete cfg.ghostOn;
  delete cfg.gf; // The gamma flip of the 1.1 draft is gone (2026-10-21: the Exposure Forecast has it).
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

  // A slider that you switch off stays off by its tool, also when other tools come or go (2026-10-11; before,
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
  // Back to live (2026-10-23: at the end of a live day the tools stayed "historical" with QuantData's yellow
  // Resume button; a slider set to its end by keys does not resume, and a new minute then left it behind; Resume on 1
  // tool resumed only that tool). wantLive: the last action ended at the live end, or you clicked a Resume button. Then
  // each synced tool that shows its Resume button gets a click on it (QuantData's own live mode: 1 load per tool, like a
  // step). Your own move of a slider (keys or mouse on it) or an action before the end clears it.
  let wantLive = false;
  const resumeAt = new WeakMap(); // tool -> time of our last click on its Resume button
  // QuantData's Resume button of a tool: by its status class, else by its text (2026-10-26: after QuantData's new class
  // names the status class was not confirmed, and the tools did not go back to live).
  const isResumeBtn = (b) => !!b && (!!b.querySelector('[class*="QDToolHistoricalStatus-module__"]') || /^\s*resume\b/i.test(b.textContent || ''));
  const resumeBtnOf = (tool) => {
    const s = tool && [...tool.querySelectorAll('[class*="QDToolHistoricalStatus-module__"]')].find((x) => x.closest('button') && x.getClientRects().length);
    if (s) return s.closest('button');
    return tool ? [...tool.querySelectorAll('button')].find((b) => b.getClientRects().length && /^\s*resume\b/i.test(b.textContent || '')) || null : null;
  };
  // A step to the live end of a live day: QuantData's Resume instead of the slider (2026-10-26: at the live end with
  // the request limit used up, the slider load failed and the values were wrong; Resume gives the live data stream).
  function resumeInstead(el, et) {
    const le = liveEnd();
    if (le === null || !(et >= le)) return false;
    const tool = toolOf(el);
    const b = resumeBtnOf(tool);
    if (!b) return false;
    wantLive = true;
    resumeAt.set(tool, performance.now());
    b.click();
    return true;
  }
  function atLiveEnd(el) {
    const r = read(el);
    const le = liveEnd();
    return isTime(r) && le !== null && timeBase(r) + r.value >= le;
  }
  function resumeAll(except) {
    if (!wantLive) return;
    for (const el of activeSliders()) {
      const tool = toolOf(el);
      if (!tool || tool === except) continue;
      const b = resumeBtnOf(tool);
      if (!b || performance.now() - (resumeAt.get(tool) || 0) < 4000) continue;
      resumeAt.set(tool, performance.now());
      b.click();
    }
  }
  window.addEventListener('click', (e) => {
    if (!e.isTrusted || !(e.target instanceof Element)) return;
    const s = e.target.closest('button');
    const tool = isResumeBtn(s) ? toolOf(s) : null;
    if (!tool || !liveEnd()) return;
    wantLive = true;
    setTimeout(() => resumeAll(tool), 0); // the other tools too
  }, true);
  for (const ty of ['keydown', 'pointerdown']) {
    window.addEventListener(ty, (e) => {
      if (!e.isTrusted || !(e.target instanceof Element)) return;
      if (e.target.closest('[role="slider"], [class*="QDTimeSlider-module__"]')) wantLive = false; // your own move
    }, true);
  }
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m) % 60).padStart(2, '0')}`;
  // The time in the panel: ET, or the time of this computer (option "Show the time in your time zone",
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
  // The local time of a chart time (the custom price chart, the crosshair labels): 24 hours ("20:18") or 12 hours
  // ("8:18 PM", like QuantData's axes); the option "24-hour time" (2026-10-23: on).
  const LOCAL24 = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const LOCAL12 = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
  const localClock = { format: (d) => (cfg.h24 !== false ? LOCAL24 : LOCAL12).format(d) };
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
      if (resumeInstead(el, etOf(r) + (learnedStep.get(el) || 1))) return;
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

  // Max. steps that wait in the queue: a whole day. Waiting steps are 1 move (a jump), so a limit is only needed at
  // the ends of the slider (2026-10-27: 60 blocked quick Shift steps through the day).
  const MAX_WAITING = 1440;
  function queueSteps(n) {
    const was = pendingSteps;
    pendingSteps = Math.max(-MAX_WAITING, Math.min(MAX_WAITING, pendingSteps + n));
    // Not past the ends of slider 1 (else steps back after the start would first undo steps that do nothing).
    const ref = refSlider();
    if (ref) {
      const r = read(ref);
      const v = virt.has(ref) ? virt.get(ref) : r.value;
      const top = stepTarget(ref, MAX_WAITING, v);
      const st = learnedStep.get(ref) || 1;
      const lo = was - Math.ceil((v - r.min) / st);
      const hi = was + Math.ceil((top - v) / st);
      pendingSteps = Math.max(lo, Math.min(hi, pendingSteps));
    }
    // The minute that the sliders go to: its picture shows at once, also while earlier steps still wait or move
    // (2026-10-26: "ich klicke zack, und dreimal refresht das Bild").
    for (const el of activeSliders()) virt.set(el, stepTarget(el, pendingSteps - was, virt.has(el) ? virt.get(el) : read(el).value));
    const rf = refSlider();
    if (rf && virt.has(rf) && isTime(read(rf))) wantAt(etOf({ ...read(rf), value: virt.get(rf) }));
    // Virtual steps (2026-10-26: quick switching used up the request limit, each click moved QuantData's sliders):
    // when each tool that moves has a picture of the target minute, only the pictures change; QuantData's sliders move
    // once, VIRT_IDLE ms after the last click (to the minute where you are; nothing when you are back where you were).
    if (!working && !pendingJob && picPreview(true)) {
      clearTimeout(virtTimer);
      // Play over minutes in the cache stays virtual (2026-10-28: each Play step moved QuantData after VIRT_IDLE, so it
      // showed its loading circle in each minute): QuantData moves when Play stops or a minute is not in the cache.
      virtTimer = setTimeout(virtCommit, playing ? PLAY_VIRT_IDLE : VIRT_IDLE);
      virtCache = true;
      dlog('virtual', { pending: pendingSteps, data: dataShown.size, pictures: freezes.size });
      virtThumbs();
      refresh(); // the time field, the zoom bars of the time charts and the custom price chart at the virtual minute
      return;
    }
    // Quick steps over minutes without data (2026-10-27, the debug log: 19 steps in 5 s sent 36 PUT and 32 GET, then
    // the rate limit): the first step moves at once; the next ones within STEP_BURST ms wait and move together, once,
    // STEP_IDLE ms after the last press. The sliders and the time field show the target meanwhile.
    const now = performance.now();
    const burst = working || virtTimer || now - lastStepAt < STEP_BURST;
    lastStepAt = now;
    if (burst) {
      clearTimeout(virtTimer);
      virtTimer = setTimeout(virtCommit, STEP_IDLE);
      virtOn = true;
      virtCache = false;
      dlog('wait', { pending: pendingSteps });
      virtThumbs();
      refresh();
      return;
    }
    virtCommit();
  }
  const STEP_BURST = 600; // 2026-10-28 (debug log): clicks 0.3-0.45 s apart moved QuantData at every 2nd click (350 ms before)
  const STEP_IDLE = 350;
  let lastStepAt = -Infinity;
  const VIRT_IDLE = 900;
  const PLAY_VIRT_IDLE = 60000; // a safety time: stop() and the end of Play commit at once
  let virtTimer = 0;
  let virtOn = false; // pictures shown for waiting steps, QuantData not moved yet
  let virtCache = false; // the waiting steps show minutes of the cache (Play does not wait for QuantData then)
  function virtCommit() {
    virtCache = false;
    dlog('commit', { pending: pendingSteps, virtual: virtOn });
    clearTimeout(virtTimer);
    virtTimer = 0;
    const held = virtOn;
    virtOn = false;
    for (const f of freezes.values()) f.hold = false;
    if (held && !pendingSteps) virtThumbsBack();
    else thumbOld.clear(); // the move sets QuantData's own values
    if (held && !pendingSteps) {
      // Back at the minute of before: nothing to load, the pictures go.
      for (const t of [...freezes.keys()]) unfreeze(t);
      for (const t of [...dataShown.keys()]) dataBack(t);
      virt.clear();
      render();
      return;
    }
    // The tools that show a data snapshot: a copy of that view covers QuantData's load of the new minute (a canvas copy,
    // at once), then our drawing goes back to QuantData's data below it.
    for (const tool of [...dataShown.keys()]) {
      const pic = cfg.freeze && makePicture(tool, true);
      const els = activeSliders().filter((x) => toolOf(x) === tool);
      if (pic) {
        if (freezes.has(tool)) unfreeze(tool);
        startFreeze(tool, pic, { els, v0: els.map((el) => read(el).value), movedAt: 0, servedAt: 0 });
        const f = freezes.get(tool);
        if (f) f.known = true;
      }
      dataBack(tool);
    }
    kick();
  }
  // QuantData's slider thumbs at the virtual minute (2026-10-26: "die Slider sollen sich mitbewegen"): the CSS values of
  // the Mantine thumb, its bar and its label text; React sets them again at its next render. Kept: the values before.
  const thumbOld = new Map(); // slider -> { offset, width, label }
  const hhmm12 = (m) => { const h = Math.floor(m / 60) % 24; return `${h % 12 || 12}:${String(Math.round(m) % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  function virtThumbs() {
    for (const el of activeSliders()) {
      if (!virtOn || !virt.has(el)) continue;
      const r = read(el);
      const v = virt.get(el);
      if (!(r.max > r.min)) continue;
      const pct = ((v - r.min) / (r.max - r.min)) * 100;
      const bar = el.parentElement && el.parentElement.querySelector('.mantine-Slider-bar');
      const label = el.querySelector('.mantine-Slider-label');
      if (!thumbOld.has(el)) thumbOld.set(el, { offset: el.style.getPropertyValue('--slider-thumb-offset'), width: bar ? bar.style.getPropertyValue('--slider-bar-width') : null, label: label ? label.textContent : null, bar, labelEl: label });
      el.style.setProperty('--slider-thumb-offset', `${pct}%`);
      if (bar) bar.style.setProperty('--slider-bar-width', `calc(${pct}% + 2 * var(--slider-size))`);
      if (label && label.textContent && isTime(r)) label.textContent = hhmm12(wrap(timeBase(r) + v + localShift()));
    }
  }
  // Back to QuantData's own values (no move: React does not render them again).
  function virtThumbsBack() {
    for (const [el, o] of thumbOld) {
      if (o.offset !== null) el.style.setProperty('--slider-thumb-offset', o.offset);
      if (o.bar && o.width !== null) o.bar.style.setProperty('--slider-bar-width', o.width);
      if (o.labelEl && o.label !== null) o.labelEl.textContent = o.label;
    }
    thumbOld.clear();
  }
  // A slider as the panel shows it: its virtual value while steps are virtual (the time field, the zoom bars of the
  // time charts and the custom price chart follow it; they send no requests).
  // The minute the sliders go to (a drag of the master slider, quick steps): the custom price chart shows it at once (it
  // has the candles of the whole day), while QuantData's sliders follow in jumps (2026-10-28: the chart seemed to lag).
  let wantEt = null;
  let wantTime = 0;
  const wantAt = (et) => { const was = wantEt; wantEt = et; wantTime = performance.now(); if (was !== et) cwSoon(); };
  const wantNow = () => (wantEt != null && (working || pendingSteps || performance.now() - wantTime < 1500) ? wantEt : null);
  const readV = (el) => (virtOn && virt.has(el) ? { ...read(el), value: virt.get(el) } : read(el));
  function queueJob(job) {
    clearTimeout(virtTimer);
    virtTimer = 0;
    if (virtOn) virtThumbsBack();
    for (const t of [...dataShown.keys()]) dataBack(t);
    virtOn = false;
    for (const f of freezes.values()) f.hold = false;
    pendingSteps = 0;
    pendingJob = job;
    virt.clear();
    kick();
  }
  const virt = new Map(); // slider -> the value after all waiting steps (cleared when the queue is idle)
  // The value of a slider n steps after v: in its range and not after the live end.
  function stepTarget(el, n, v) {
    const r = read(el);
    let t = Math.max(r.min, Math.min(r.max, v + n * (learnedStep.get(el) || 1)));
    const le = liveEnd();
    if (le !== null && isTime(r)) t = Math.min(t, le - timeBase(r));
    return t;
  }
  // Shows the pictures of the virtual minute. all: only when each tool that moves has one (then they are held until
  // virtCommit); returns true then.
  function picPreview(all) {
    if (cfg.snap !== true) return false;
    const moving = (el) => virt.has(el) && virt.get(el) !== read(el).value;
    const tools = new Map();
    for (const el of activeSliders()) if (moving(el)) tools.set(toolOf(el), [...(tools.get(toolOf(el)) || []), el]);
    // A strike chart with a data snapshot of the target minute: our drawing shows it (no picture); else its picture.
    const byData = new Set([...tools].filter(([tool, els]) => tool && dataHas(tool, els.map((el) => virt.get(el)))).map(([tool]) => tool));
    if (all) {
      if (![...tools].every(([tool, els]) => tool && (byData.has(tool) || (cfg.freeze && picHas(tool, els.map((el) => virt.get(el))))))) return false;
      // Tools that are back at their minute (no move) keep their real chart.
      for (const [tool, f] of [...freezes]) if (!tools.has(tool) && f.hold) unfreeze(tool);
      for (const tool of [...dataShown.keys()]) if (!tools.has(tool)) dataBack(tool);
    }
    for (const tool of byData) dataShow(tool, tools.get(tool).map((el) => virt.get(el)));
    if (cfg.freeze) freezeTools((el) => moving(el) && !byData.has(toolOf(el)), (el) => virt.get(el), true);
    if (all) {
      virtOn = true;
      for (const f of freezes.values()) f.hold = true;
    }
    return !!all;
  }

  // ---------------------------------------------------------------------------
  // Data snapshots (2026-10-27): per strike chart and minute the inputs of QuantData's renderer (strikes, call and put
  // values, the price line; bridge syKeep) and the texts of its legend. A virtual step draws them with our drawing (the
  // fixed scale) in the current zoom, so zoom and pan do not need new pictures, and a picture is only the fallback for
  // other tools. Key: the tool, its day, the slider value and its settings (the chart title, the date chips).
  // ---------------------------------------------------------------------------
  const dataIdx = new Map(); // key -> { tk, day, et, legend: [texts], charts: [chart keys] }
  const dataShown = new Map(); // tool -> { legendEls: [[el, old text]], charts: [chart keys] }
  function strikeCharts(tool) {
    return [...tool.querySelectorAll('canvas[data-qdts-chart]')].map((c) => c.getAttribute('data-qdts-chart')).filter((k) => syAt.has(k));
  }
  function dataKey(tool, vals) {
    const sl = activeSliders().find((x) => toolOf(x) === tool);
    const tk = sl && sliderKeys.get(sl);
    if (!tk || vals.some((v) => isNaN(v))) return null;
    const chips = [...tool.querySelectorAll('*')].filter((n) => !n.children.length && DATE_CHIP.test((n.textContent || '').trim())).map((n) => n.textContent.trim()).join(',');
    return `${tk}|${toolDay(tool)}|${vals.join(',')}|${headTitle(tool)}|${chips}`;
  }
  const legendEls = (tool) => [...tool.querySelectorAll('[class*="QDChartLegendItem-module__"][class*="__name"]')].filter((n) => !n.closest('[data-qdts-sd], [data-qdts-sdrow]'));
  function dataHas(tool, vals) {
    if (!syOn()) return false;
    const key = dataKey(tool, vals);
    const e = key && dataIdx.get(key);
    return !!(e && e.charts.length && e.charts.every((k) => syAt.has(k)));
  }
  function dataKeep(tool) {
    const own = activeSliders().filter((x) => toolOf(x) === tool);
    const key = dataKey(tool, own.map((x) => read(x).value));
    const charts = strikeCharts(tool);
    if (!key || !charts.length) return;
    const ok = charts.filter((k) => { const r = bridge('syKeep', { k, key: `${key}|${k}` }); return r && r.ok; });
    if (!ok.length) return;
    const r0 = own[0] && read(own[0]);
    dataIdx.delete(key);
    dataIdx.set(key, { tk: own[0] && sliderKeys.get(own[0]), day: toolDay(tool), et: r0 && isTime(r0) ? etOf(r0) : null, legend: legendEls(tool).map((n) => n.textContent), charts: ok });
    // Max picMax() minutes per tool (the list: Size), the oldest go first.
    const tk = own[0] && sliderKeys.get(own[0]);
    let n = 0;
    for (const e of dataIdx.values()) if (e.tk === tk) n++;
    for (const [k, e] of [...dataIdx]) {
      if (n <= picMax()) break;
      if (e.tk !== tk) continue;
      dataIdx.delete(k);
      bridge('syDrop', { key: k });
      n--;
    }
  }
  function dataShow(tool, vals) {
    const key = dataKey(tool, vals);
    const e = key && dataIdx.get(key);
    if (!e) return;
    let sh = dataShown.get(tool);
    if (!sh) {
      sh = { legendEls: legendEls(tool).map((n) => [n, n.textContent]), charts: e.charts };
      dataShown.set(tool, sh);
      // An old copy (freeze) of this tool goes: our drawing shows the new minute.
      if (freezes.has(tool)) unfreeze(tool);
    }
    for (const k of e.charts) bridge('syShow', { k, key: `${key}|${k}` });
    sh.legendEls.forEach(([n], i) => { if (e.legend[i] != null && n.isConnected) n.textContent = e.legend[i]; });
  }
  // Back to QuantData's own data (and legend texts) in a tool.
  function dataBack(tool) {
    const sh = dataShown.get(tool);
    if (!sh) return;
    dataShown.delete(tool);
    for (const k of sh.charts) bridge('syShow', { k, key: null });
    for (const [n, t] of sh.legendEls) if (n.isConnected) n.textContent = t;
  }
  function whenIdle() {
    return working || pendingSteps || pendingJob ? new Promise((r) => idleWaiters.push(r)) : Promise.resolve();
  }

  // ---------------------------------------------------------------------------
  // Debug log (2026-10-27, the option "Debug log"): events with a time go in batches (1 s) to QD Toolkit Data, which
  // sends them to a receiver on this computer only (tests/realsite/logsink.py). No request content, no credentials.
  // ---------------------------------------------------------------------------
  let dlogBuf = [];
  const dlog = (ev, data) => {
    if (!cfg.dlog) return;
    dlogBuf.push({ t: Date.now(), ms: Math.round(performance.now()), ev, ...(data || {}) });
    if (dlogBuf.length > 2000) dlogBuf = dlogBuf.slice(-2000);
  };
  setInterval(() => {
    if (!dlogBuf.length) return;
    const b = dlogBuf;
    dlogBuf = [];
    document.dispatchEvent(new CustomEvent('qdts:log', { detail: JSON.stringify(b) }));
  }, 1000);
  try {
    new PerformanceObserver((list) => {
      if (!cfg.dlog) return;
      for (const e of list.getEntries()) {
        if (!/quantdata\.us\/api\//.test(e.name)) continue;
        dlog('req', { path: e.name.replace(/^https?:\/\/[^/]+/, '').split('?')[0].slice(0, 120), type: e.initiatorType, dur: Math.round(e.duration), start: Math.round(e.startTime), size: e.transferSize, status: e.responseStatus });
      }
    }).observe({ type: 'resource', buffered: false });
  } catch {}
  // Where the main thread goes (2026-10-28: the custom chart seemed to lag on quick steps): the time of our own work per
  // kind and the gaps between frames, each second with work or a gap of 50 ms and more (the debug log only).
  const perfMs = {};
  const perfN = {};
  const perfAdd = (k, t0) => { if (!cfg.dlog) return; perfMs[k] = (perfMs[k] || 0) + performance.now() - t0; perfN[k] = (perfN[k] || 0) + 1; };
  let perfLast = 0;
  let perfGap = 0;
  let perfSlow = 0;
  let perfFrom = 0;
  function perfFrame(t) {
    if (!cfg.dlog) { perfLast = 0; return; }
    if (perfLast) {
      const g = t - perfLast;
      perfGap = Math.max(perfGap, g);
      if (g >= 50) perfSlow++;
    }
    perfLast = t;
    if (!perfFrom) perfFrom = t;
    if (t - perfFrom >= 1000) {
      const work = Object.values(perfMs).reduce((a, b) => a + b, 0);
      if (perfGap >= 50 || work >= 50) {
        const ms = {};
        for (const k of Object.keys(perfMs)) ms[k] = `${Math.round(perfMs[k])}/${perfN[k]}`;
        dlog('perf', { gap: Math.round(perfGap), slow: perfSlow, ms });
      }
      for (const k of Object.keys(perfMs)) { delete perfMs[k]; delete perfN[k]; }
      perfGap = 0;
      perfSlow = 0;
      perfFrom = t;
    }
    requestAnimationFrame(perfFrame);
  }
  const perfStart = () => { if (cfg.dlog && !perfLast) { perfLast = 0; perfFrom = 0; requestAnimationFrame(perfFrame); } };
  setInterval(perfStart, 2000);
  document.addEventListener('qdts:blog', (e) => { const [x, id] = String(e.detail).split('|'); dlog('cache', { x, id }); });
  window.addEventListener('error', (e) => dlog('error', { msg: String(e.message).slice(0, 200), src: String(e.filename || '').slice(-60), line: e.lineno }));
  window.addEventListener('unhandledrejection', (e) => dlog('error', { msg: String((e.reason && e.reason.message) || e.reason).slice(0, 200) }));
  let dlogState = '';
  // In refresh(): the slider values and which tools load (QuantData's placeholder), when they change.
  function dlogTick() {
    if (!cfg.dlog) return;
    const sl = activeSliders();
    const st = `${sl.map((el) => read(el).value).join(',')}|${sl.map((el) => { const t = toolOf(el); return t && toolLoading(t) ? 'L' : '.'; }).join('')}|${freezes.size}|${virtOn ? 'V' : ''}`;
    if (st === dlogState) return;
    dlogState = st;
    const [vals, load, frz, v] = st.split('|');
    dlog('state', { vals, load, freezes: +frz, virtual: !!v });
  }
  // QuantData waits about 300 ms after a slider change before it saves the time and loads (2026-10-26, measured on the
  // real page). A 2nd change in that time is merged with the 1st; when the slider is then back at the minute of before,
  // QuantData shows its loading placeholder but loads nothing (10 s and more). So a move starts at the earliest
  // QD_SETTLE ms after the last one; quick key presses wait in the queue (net steps).
  const QD_SETTLE = 400; // without page data (no bridge): a fixed time
  const QD_SETTLE_MAX = 1500;
  let lastMoveAt = -Infinity;
  // Since the fixed time was too short when Safari was busy (QuantData's timer came later), the next move waits until
  // QuantData has sent the PUT of each tool that the last move changed (bridge op putSeq), max QD_SETTLE_MAX ms.
  let lastMove = null; // { at, ids: [[toolId, PUT count before the move]] }
  const toolIdOf = (el) => { const m = /^tool:([^|]+)\|/.exec(sliderKeys.get(el) || ''); return m ? m[1] : null; };
  async function waitSettle() {
    const lm = lastMove;
    lastMove = null;
    if (!lm) return;
    while (performance.now() - lm.at < QD_SETTLE_MAX) {
      const seq = bridge('putSeq');
      const fixed = performance.now() - lm.at >= QD_SETTLE;
      // A tool without a seen PUT (no page data, or not saved by an XHR): the fixed time.
      if (lm.ids.every(([id, s0]) => (seq && (seq[id] || 0) > s0) || (fixed && !(seq && id in seq)))) return;
      if (!lm.ids.length && fixed) return;
      await sleep(25);
    }
  }
  // Before a move: the PUT counts of the tools; after it: keep the tools whose slider changed.
  function moveStart() {
    const seq = bridge('putSeq') || {};
    return activeSliders().map((el) => [el, read(el).value, toolIdOf(el), seq[toolIdOf(el)] || 0]);
  }
  function moveEnd(st) {
    const ids = st.filter(([el, v, id]) => id && read(el).value !== v).map(([, , id, s0]) => [id, s0]);
    const moved = st.some(([el, v]) => read(el).value !== v);
    lastMove = moved ? { at: performance.now(), ids } : lastMove;
    if (moved) lastMoveAt = performance.now();
  }
  async function kick() {
    if (working) return;
    working = true;
    const prevFocus = document.activeElement;
    try {
      while (pendingJob || pendingSteps) {
        await waitSettle();
        if (!pendingJob && !pendingSteps) break; // the waiting steps cancelled each other out
        const st = moveStart();
        try {
          if (pendingJob) {
            const job = pendingJob;
            pendingJob = null;
            const els = activeSliders();
            const cap = liveEnd();
            freezeTools((el) => willMove(el, job, cap), (el) => { const r = read(el); return job.t === 'edge' ? (job.which === 'start' ? r.min : r.max) : Math.round(targetFor(el, job, cap)); }); // Keep the old charts visible until the new data is drawn.
            await Promise.all(els.map((el) => (job.t === 'set' ? driveTo(el, targetFor(el, job, cap)) : edgeSlider(el, job.which))));
          } else {
            // All waiting steps in 1 move (QuantData saves only the end of it): fewer requests, and steps that cancel
            // each other out move nothing.
            const n = pendingSteps;
            pendingSteps = 0;
            const dir = Math.sign(n);
            freezeTools((el) => willStep(el, dir), (el) => stepTarget(el, n, read(el).value));
            await Promise.all(activeSliders().map(async (el) => {
              // Many steps (virtual steps over pictures): 1 jump to the target, not 1 key press per step.
              if (Math.abs(n) > 3 && isTime(read(el))) {
                const t = stepTarget(el, n, read(el).value);
                if (!resumeInstead(el, timeBase(read(el)) + t)) await driveTo(el, t);
                return;
              }
              for (let i = 0; i < Math.abs(n); i++) {
                const v = read(el).value;
                await stepSlider(el, dir);
                if (read(el).value === v) break; // at its end, the live end, or Resume instead
              }
            }));
            await sleep(0);
          }
        } catch (err) {
          console.warn('[QD Toolkit]', err);
        }
        moveEnd(st);
        refresh();
      }
      virt.clear();
      // The action ended at the live end of a live day: back to live (QuantData's Resume of each tool).
      // The live sliders count (their end is the newest minute; a full-range slider of a live day does not show it).
      const els = activeSliders().filter((el) => isLive(read(el)));
      wantLive = els.length > 0 && els.every(atLiveEnd);
      resumeAll(null);
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
    step(n) { dlog('step', { n }); queueSteps(n); send({ t: 'step', n }); },
    set(target) { if (target.et != null) wantAt(target.et); queueJob({ t: 'set', ...target }); send({ t: 'set', ...target }); },
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
  // A rate limit on a PUT that the snapshot cache sent in the background (bridge.js): the page shows no message then.
  document.addEventListener('qdts:ratelimit', () => onRateLimit());
  function onRateLimit() {
    dlog('ratelimit', {});
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
  // Request budget for Play: QuantData allows about 60 data requests at once, then 1 per second (a token bucket
  // per account). Only the data requests count, not the saves of the tool settings (PUT /api/tool): this model
  // met all 4 rate limits of the debug log of 2026-10-27 within 1-3 requests (before: 120 requests and 2 per second
  // with the saves; it was up to 134 off). A step costs 1 request for each tool with a time slider whose new
  // minute is not in the cache. Before each step, Play waits until the step fits and
  // BUDGET_RESERVE requests stay free for your own clicks. Your own steps never wait: they use the budget,
  // and Play waits longer after them.
  // All QuantData tabs of this browser share 1 estimate in localStorage: the requests of every tab count
  // (also the page load after a reload, and the steps that the tab sync sends to other tabs).
  // Other devices are not seen: the reserve and the pause after the QuantData message cover them.
  // ---------------------------------------------------------------------------
  const BUDGET_CAP = 60;
  const BUDGET_RATE = 1; // requests per second
  const BUDGET_RESERVE = 10;
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
      // Not the saves of the tool settings: they do not count toward QuantData's limit.
      return /(^|\.)quantdata\.us$/.test(u.hostname) && u.pathname.startsWith('/api/') && !/^\/api\/tool\/?$/.test(u.pathname);
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
  // Cost of 1 step forward: 1 data request for each tool with an active time slider, 0 when the bridge has the data
  // of its next minute in the cache (stepInfo: the tools and the cached ones, for the list).
  function stepInfo(dir = 1) {
    const tools = new Map(); // tool -> its first time slider
    for (const el of activeSliders()) if (isTime(read(el)) && !tools.has(toolOf(el) || el)) tools.set(toolOf(el) || el, el);
    let cached = 0;
    if (cfg.snap === true && tools.size) {
      const q = [];
      for (const el of tools.values()) {
        const m = /^tool:([^|]+)\|/.exec(sliderKeys.get(el) || '');
        q.push(m ? [m[1], stepTarget(el, dir, read(el).value)] : null);
      }
      const r = bridge('snapHas', { q: q.filter(Boolean) });
      if (r && r.ok && Array.isArray(r.has)) cached = r.has.filter(Boolean).length;
    }
    return { tools: tools.size, cached, cost: tools.size - cached };
  }
  const stepCost = () => stepInfo().cost;
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
    const r = readV(ref); // also the minute of virtual steps
    const { hi } = playRange(r);
    return !isNaN(hi) && r.value >= hi;
  };
  let playLoadMs = 900; // Auto: the average time of a real Play step (load and settle)
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
      const cached = virtCache;
      if (!cached) await whenIdle(); // a minute of the cache: no load to wait for
      if (token !== playToken) {
        if (watch) watch.stop();
        return;
      }
      // Auto and a minute of the cache: no requests come, so the wait for them took its maximum (4.3 s; 2026-10-28:
      // "länger als der eigentliche Ladevorgang"). It waits as long as the real loads took (their average) instead.
      if (watch && cached) {
        watch.stop();
        await sleep(playLoadMs);
      } else if (watch) {
        await watch.wait();
        playLoadMs = Math.max(300, Math.min(2000, playLoadMs * 0.7 + (performance.now() - t0) * 0.3));
      } else await sleep(cfg.speed);
      // Half speed (or slower) after a rate-limit message: wait the step time again.
      if (slowFactor > 1 && playing && token === playToken) await sleep((performance.now() - t0) * (slowFactor - 1));
    }
    if (token === playToken) {
      playing = false;
      playCommit();
      render();
    }
  }
  function stop() {
    playing = false;
    playToken++;
    playCommit();
    render();
  }
  // After Play: the virtual minute goes to QuantData's sliders (VIRT_IDLE later, like after your own clicks).
  function playCommit() {
    if (!virtTimer) return;
    clearTimeout(virtTimer);
    virtTimer = setTimeout(virtCommit, VIRT_IDLE);
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
  // The choices of the price chart settings in the list (the price lines, the grid of the custom chart).
  const PL_STEPS = [1, 2.5, 5, 10];
  const PIC_SIZES = [200, 400, 800, 1440]; // the size of the cache: minutes per chart (1440: a whole day)
  const GAP_OP = [10, 20, 35, 50]; // the opacity of the gap box in % (Indicators)
  // The look of the gap box (2026-10-23): the label (off, the size, the size and the fill), the line, the opacity.
  const gapCfg = () => ({ label: 'full', line: true, op: 20, ...(cfg.gapLook || {}) });
  const PL_WIDTHS = [0.5, 1, 2.5, 5];
  const OC_GRID_OP = [5, 10, 20, 40];
  const OC_NS = [1, 2, 3, 5, 10, 15, 30, 60]; // minutes of a candle of the custom chart
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
  .xline { position: fixed; display: none; pointer-events: none; z-index: 160; --s: 1; visibility: hidden; /* drawn on a canvas (xCanvas) */
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
    padding: 4px 10px 10px; color: var(--l-text); font-size: 14px;
  }
  /* The list opens in the middle of the window over a dark backdrop, like the QuantData settings (2026-10-11:
     before, it opened at the left below its button and looked crammed). The bar of the panel stays above the backdrop,
     so its buttons work while the list is open; docked, the backdrop starts below the header. A click on the backdrop
     closes the list. */
  /* Dark and blurred like the backdrop of QuantData's own menus (2026-10-11: the first one was too light). */
  .backdrop { position: fixed; left: 0; top: 0; z-index: 2147483644; background: rgba(0, 0, 0, 0.62);
    -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); animation: qdts-fade 0.15s ease-out; }
  .list:not([hidden]) { animation: qdts-fade 0.15s ease-out; } /* no scale: fixAt() measures the box at the opening */
  @keyframes qdts-fade { from { opacity: 0; } }
  .bar { position: relative; z-index: 2147483645; }
  /* 2 columns (0.17): the list grows in width, not in height. A narrow window gets 1 column. */
  .cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); column-gap: 32px; }
  .col { min-width: 0; }
  @media (max-width: 620px) { .cols { grid-template-columns: minmax(0, 1fr); } }
  /* Categories at the left, like QuantData's settings (2026-10-21: the list was too full with the new options;
     wider, in categories): Replay, Charts, σ lines, Keys. 1 category at a time; the list keeps its height. */
  .list:not(.gmenu):not(.tctx) { width: min(980px, calc(100vw - 16px)); padding: 0; }
  /* 1 size for all categories (2026-10-28: the list changed its height with each category): the height of the longest
     category, measured at the opening (listHeight()); the content scrolls inside when the window is lower. */
  .list:not(.gmenu):not(.tctx):not([hidden]) { height: min(680px, calc(100vh - 32px)); display: flex; flex-direction: column; overflow: hidden; }
  .list:not(.gmenu):not(.tctx) > .lwrap { flex: 1; min-height: 0; }
  .list:not(.gmenu):not(.tctx) .lbody { overflow: auto; }
  .list .more { margin: 8px 12px 0; }
  .lwrap { display: flex; }
  /* The keys at the bottom of the category column (2026-10-22: always in view, no own category). */
  .lnav .nkeys { margin-top: auto; padding: 8px 2px 0; border-top: 1px solid var(--l-line); border-bottom: 0; }
  .lnav .nkeys .key { flex-direction: column; align-items: flex-start; gap: 3px; min-height: 0; padding: 4px 4px 6px; font-size: 12.5px; color: var(--l-muted); }
  .lnav .nkeys kbd { font-size: 11.5px; }
  .lnav { flex: none; width: 180px; display: flex; flex-direction: column; gap: 2px; padding: 10px 8px; border-right: 1px solid var(--l-line); }
  .lnav .tab { all: unset; cursor: pointer; padding: 9px 12px; border-radius: 6px; color: var(--l-muted); font-weight: 600; font-size: 14.5px; }
  .lnav .tab:hover { background: var(--l-hover); color: var(--l-text); }
  .lnav .tab.on { background: color-mix(in srgb, var(--l-accent), transparent 82%); color: var(--l-text); }
  .lbody { flex: 1; min-width: 0; padding: 10px 22px 14px; }
  .lbody .pane > .sec:last-child, .lbody .col > .sec:last-child { border-bottom: 0; }
  .list > .msg, .list > .report { margin-left: 12px; margin-right: 12px; }
  .list > .report { margin-bottom: 10px; }
  @media (max-width: 620px) { .lnav .nkeys { width: 100%; } .lwrap { flex-direction: column; } .lnav { width: auto; flex-direction: row; flex-wrap: wrap; border-right: 0; border-bottom: 1px solid var(--l-line); } }
  .sd-in { display: grid; grid-template-columns: 1fr 96px; gap: 4px 8px; align-items: center; margin: 0 6px 6px; }
  .sd-in span { font-weight: 600; }
  .sd-in input { width: 96px; box-sizing: border-box; height: 26px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--l-line);
    background: rgba(0, 0, 0, 0.25); color: var(--l-text); font: inherit; font-variant-numeric: tabular-nums; text-align: right; }
  .sd-in input:focus { outline: 2px solid var(--l-accent); outline-offset: -1px; }
  .sd-hint { margin: 0 6px 8px; color: var(--l-muted); font-size: 13px; }
  .sd-ch-h { margin: 6px 6px 2px; color: var(--l-muted); font-size: 13px; }
  .sd-lv { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 2px 6px 6px; }
  .sd-lv button { height: 27px; min-width: 44px; padding: 0 9px; border-radius: 6px; background: var(--l-chip); color: var(--l-text);
    box-shadow: inset 0 0 0 1px var(--l-line); font-weight: 600; font-variant-numeric: tabular-nums; }
  .sd-lv button.on { background: var(--l-accent); color: var(--l-on-accent); box-shadow: none; }
  /* "i": a round button at the right end of the levels; it shows the values of ±1σ, ±2σ, ±3σ below. */
  .sd-lv .sd-info { margin-left: auto; min-width: 24px; width: 24px; padding: 0; border-radius: 50%; font: italic 700 13px/24px Georgia, "Times New Roman", serif; }
  .sd-out { display: grid; grid-template-columns: auto auto 1fr; column-gap: 14px; margin: 2px 6px 4px; color: var(--l-muted); font-variant-numeric: tabular-nums; line-height: 1.6; }
  .sd-out .sd-t { grid-column: 1 / -1; display: flex; justify-content: space-between; gap: 8px; margin-top: 2px; color: var(--l-text); font-weight: 600; }
  .sd-out .sd-p { color: var(--l-muted); font-weight: 500; }
  .sd-out .sd-r { display: contents; }
  .sd-out .sd-r span:nth-child(n+2) { text-align: right; }
  .sec { padding: 12px 0 10px; border-bottom: 1px solid var(--l-line); }
  .sec-h { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 0 2px 6px; color: var(--l-muted); font-size: 13px; font-weight: 600; }
  .sec-v { color: var(--l-muted); font-weight: 500; font-variant-numeric: tabular-nums; }
  .sec-v b { color: var(--l-text); font-weight: 700; }
  .meter { position: relative; height: 6px; margin: 0 2px; border-radius: 3px; background: var(--l-off); overflow: hidden; }
  .meter .b-bar { position: absolute; left: 0; top: 0; bottom: 0; width: 100%; background: var(--l-accent); border-radius: 3px; transition: width 0.3s; }
  .meter .b-res { position: absolute; left: calc(100% / 6); top: 0; bottom: 0; width: 2px; background: var(--l-bg); }
  .budget-info.low .b-bar { background: var(--warn); }
  .sub { display: flex; justify-content: space-between; gap: 8px; margin: 6px 2px 0; color: var(--l-muted); font-size: 12.5px; }
  .sub b { color: var(--l-text); font-weight: 600; font-variant-numeric: tabular-nums; }
  .rows { max-height: 220px; overflow: auto; }
  .row { display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 0 6px; border-radius: 8px; cursor: pointer; font-weight: 600; }
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
    width: 34px; height: 18px; border-radius: 9px; border: 0;
    background: radial-gradient(circle, #fff 0 6.2px, transparent 7.2px) 0 0 / 18px 18px no-repeat, var(--l-off);
    transition: background-position 0.2s, background-color 0.2s;
  }
  .list input.sw:checked { background: radial-gradient(circle, #fff 0 6.2px, transparent 7.2px) 16px 0 / 18px 18px no-repeat, var(--l-accent); border: 0; }
  .opt { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 34px; padding: 0 6px; border-radius: 8px; cursor: pointer; font-weight: 600; }
  .opt:hover { background: var(--l-hover); }
  .key { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 28px; padding: 0 6px; color: var(--l-text); }
  .key > span:last-child { display: inline-flex; align-items: center; gap: 4px; }
  .key i { font-style: normal; color: var(--l-muted); font-size: 11px; margin: 0 2px; }
  kbd { display: inline-block; min-width: 20px; text-align: center; font: 600 11px/1 ui-monospace, Menlo, monospace; padding: 4px 5px; border-radius: 4px; background: var(--l-chip); border: 1px solid var(--l-line); color: var(--l-text); }
  .empty { padding: 6px; color: var(--l-muted); }
  .msg { margin: 8px 2px 0; color: var(--l-accent); }
  .report { margin-top: 8px; }
  .list .gen-onb, .list .gen-news { margin-top: 8px; } /* the Help buttons stay blocks (2026-10-28: rows were tried, the blocks look better) */
  .list a.opt { color: inherit; text-decoration: none; }
  .list .gen-ver { color: var(--l-muted); }
  .beta { margin-left: 8px; padding: 1px 7px; border-radius: 99px; font-size: 10.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; vertical-align: 1px;
    color: var(--l-accent); background: color-mix(in srgb, var(--l-accent), transparent 82%); border: 1px solid color-mix(in srgb, var(--l-accent), transparent 55%); }
  /* Ko-fi (2026-10-28): subtle, a grey line just above the keys, no color, no pop-up */
  .lnav .kofi { display: block; margin: auto 6px 8px; padding-top: 16px; color: var(--l-muted); font-size: 12.5px; text-decoration: none; opacity: 0.8; }
  .lnav .kofi:hover { opacity: 1; color: var(--l-text); }
  /* The setup (onboarding, 2026-10-28): a window in the middle, a picture or a video at the left, the text and the
     switches of the step at the right; the switches are the ones of the list. */
  .onb-back { position: fixed; inset: 0; z-index: 2147483646; background: rgba(0, 0, 0, 0.66); -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); }
  .onb { --l-bg: var(--qfg, #11141a); --l-line: var(--qsec, rgba(255,255,255,.12)); --l-accent: var(--qd, #3b82f6); --l-muted: var(--qmuted, #9aa3b2); --l-text: var(--qtext, #e8eaef);
    --l-chip: var(--qter, rgba(255,255,255,.08)); --l-off: color-mix(in srgb, var(--l-accent), transparent 70%); --l-on-accent: var(--qtext, #fff); --l-hover: color-mix(in srgb, var(--l-accent), transparent 80%);
    position: fixed; z-index: 2147483647; left: 50%; top: 50%; transform: translate(-50%, -50%) scale(var(--onb-z, 1)); width: min(1060px, calc(100vw - 24px)); max-height: calc(100vh - 24px);
    display: flex; flex-direction: column; background: var(--l-bg); color: var(--l-text); border: 1px solid var(--l-accent); border-radius: 12px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6); font: 14px interVariableFont, Inter, -apple-system, system-ui, sans-serif; overflow: hidden; }
  .onb-skip { all: unset; position: absolute; right: 14px; top: 12px; cursor: pointer; color: var(--l-muted); font-weight: 600; padding: 4px 8px; border-radius: 6px; z-index: 1; }
  .onb-skip:hover { color: var(--l-text); background: var(--l-hover); }
  .onb-main { display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(0, 1fr); min-height: 380px; } /* the media about 4:3 */
  @media (max-width: 760px) { .onb-main { grid-template-columns: minmax(0, 1fr); } }
  .onb-media { position: relative; display: flex; align-items: center; justify-content: center; background: #05070a; border-right: 1px solid var(--l-line); overflow: hidden; }
  .onb-media img { position: absolute; inset: 0; display: block; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity .15s; } /* no bars: the media have the shape of this area */
  .onb-media img.ok { opacity: 1; } /* shown when loaded (before: a black frame with a white border for a moment) */
  .onb-media .ph { display: flex; flex-direction: column; align-items: center; gap: 10px; color: var(--l-muted); font-size: 13px; }
  .onb-media .ph b { font-size: 46px; line-height: 1; color: var(--l-accent); opacity: 0.85; }
  .onb-side { padding: 34px 28px 18px; display: flex; flex-direction: column; gap: 10px; min-width: 0; overflow: auto; }
  .onb-tag { color: var(--l-accent); font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
  .onb-tag .rec { margin-left: 8px; padding: 2px 8px; border-radius: 99px; background: color-mix(in srgb, #26c281, transparent 75%); color: #4ee0a0; letter-spacing: 0; text-transform: none; }
  .onb-title { margin: 0; font-size: 22px; line-height: 1.25; }
  .onb-text { color: var(--l-muted); line-height: 1.5; }
  .onb-text p { margin: 0 0 8px; }
  .onb-text kbd { display: inline-block; min-width: 18px; padding: 0 5px; border-radius: 4px; background: var(--l-chip); color: var(--l-text); font: 600 12px/20px inherit; text-align: center; }
  .onb-ctl { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; }
  .onb-ctl .opt { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 38px; padding: 0 8px; border-radius: 8px; font-weight: 600; cursor: pointer; }
  .onb-ctl .opt:hover { background: var(--l-hover); }
  .onb-ctl .sd-lv { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
  .onb-ctl .opt > span:first-child { flex: none; }
  .onb-i { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px; margin-left: 7px; border-radius: 50%;
    border: 1px solid var(--l-muted); color: var(--l-muted); font: 700 10px/1 Georgia, serif; font-style: italic; cursor: help; vertical-align: 1px; }
  .onb-i:hover { color: var(--l-text); border-color: var(--l-text); }
  .onb-tip { position: absolute; z-index: 5; width: 250px; padding: 9px 12px; border-radius: 8px;
    background: color-mix(in srgb, var(--l-accent), var(--l-bg) 82%); border: 1px solid color-mix(in srgb, var(--l-accent), transparent 45%); color: var(--l-text); font: 500 12.5px/1.45 interVariableFont, Inter, -apple-system, system-ui, sans-serif;
    box-shadow: 0 8px 24px rgba(0,0,0,.5); pointer-events: none; }
  .onb-keys { display: grid; grid-template-columns: 1fr auto; gap: 6px 16px; margin: 6px 0 2px; color: var(--l-text); font-weight: 600; }
  .onb-keys > span:nth-child(2n) { text-align: right; }
  .onb-ctl .sd-lv button { height: 28px; min-width: 40px; padding: 0 9px; border-radius: 6px; background: var(--l-chip); color: var(--l-text); font-weight: 600; border: 0; cursor: pointer; }
  .onb-ctl .sd-lv button.on { background: var(--l-accent); color: var(--l-on-accent); }
  .onb input.sw { -webkit-appearance: none; appearance: none; flex: none; margin: 0; width: 34px; height: 18px; border-radius: 9px; border: 0; cursor: pointer;
    background: radial-gradient(circle, #fff 0 6.2px, transparent 7.2px) 0 0 / 18px 18px no-repeat, var(--l-off); transition: background-position .2s, background-color .2s; }
  .onb input.sw:checked { background: radial-gradient(circle, #fff 0 6.2px, transparent 7.2px) 16px 0 / 18px 18px no-repeat, var(--l-accent); }
  .onb-foot { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-top: 1px solid var(--l-line); }
  .onb-gap { flex: 1; }
  .onb-dots { display: flex; gap: 6px; }
  .onb-dots i { width: 8px; height: 8px; border-radius: 50%; background: var(--l-chip); cursor: pointer; }
  .onb-dots i.on { background: var(--l-accent); }
  .onb-prev, .onb-next { all: unset; cursor: pointer; height: 34px; line-height: 34px; padding: 0 18px; border-radius: 8px; font-weight: 600; }
  .onb-prev { color: var(--l-muted); }
  .onb-prev:hover { color: var(--l-text); background: var(--l-hover); }
  .onb-next { background: var(--l-accent); color: var(--l-on-accent); box-shadow: 0 2px 10px color-mix(in srgb, var(--l-accent), transparent 55%); }
  .onb-next:hover { filter: brightness(1.1); }
  .onb .gen-cards { margin-top: 8px; padding-top: 0; border-top: 0; grid-template-columns: minmax(0, 1fr); gap: 10px; }
  .onb .news { margin: 4px 0 0; padding-left: 18px; color: var(--l-text); line-height: 1.6; }
  .lnav .kofi + .nkeys { margin-top: 0; }
  /* General: Discord and Ko-fi as 2 cards at the bottom (2026-10-28) */
  .lbody .pane[data-pane=gen]:not([hidden]) { display: flex; flex-direction: column; min-height: 100%; }
  .gen-cards { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; margin-top: auto; padding-top: 18px; border-top: 1px solid var(--l-line); }
  .gen-cards::before { content: none; }
  .lbody .pane[data-pane=gen] > .cols { margin-bottom: 18px; }
  @media (max-width: 620px) { .gen-cards { grid-template-columns: minmax(0, 1fr); } }
  .gcard { --c: #5865f2; display: flex; flex-direction: column; gap: 10px; padding: 16px; border-radius: 10px;
    background: color-mix(in srgb, var(--l-bg, #16181d), white 5%); border: 1px solid var(--l-line); } /* opaque and neutral: only the icon and the button have the color (2026-10-28: the tinted cards looked dull) */
  .gcard.kf { --c: #c95c54; } /* the red of the Ko-fi page */
  .gc-h { display: flex; align-items: center; gap: 8px; font-size: 15px; }
  .gc-h svg { width: 22px; height: 22px; fill: var(--c); }
  .gc-t { margin: 0; color: var(--l-muted); line-height: 1.45; flex: 1; }
  .gc-b { all: unset; box-sizing: border-box; align-self: flex-start; cursor: pointer; height: 32px; line-height: 32px; padding: 0 14px; border-radius: 8px;
    background: var(--c); color: #fff; font-weight: 600; text-shadow: none; }
  /* The same hover for both (2026-10-28: the one of the Discord button, a <button>, was good; the Ko-fi link only
     got brighter) */
  .gcard .gc-b:hover { background: var(--hover); color: #fff; filter: none; }
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
  /* The speed and RTH in the menu (a narrow header): in the look of the menu chips (.sd-lv button). */
  .list .more { padding: 10px 16px; margin: 0; border-bottom: 1px solid var(--l-line); }
  .list .more .lbl { color: var(--l-muted); font-size: 13px; }
  .list .more select, .list .more .rth { all: unset; box-sizing: border-box; height: 27px; padding: 0 10px; border-radius: 6px; cursor: pointer;
    background: var(--l-chip); color: var(--l-text); box-shadow: inset 0 0 0 1px var(--l-line); font: inherit; font-size: 13px; font-weight: 600;
    display: inline-flex; align-items: center; }
  .list .more select { padding-right: 24px; -webkit-appearance: none; appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23999' stroke-width='1.5'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 9px center; }
  .list .more select:hover, .list .more .rth:hover { box-shadow: inset 0 0 0 1px var(--l-muted); }
  .list .more .rth.on { background: var(--l-accent); color: var(--l-on-accent); box-shadow: none; }
  .list .more .rth.on:hover { filter: brightness(1.1); }
  .list .more .rth[hidden] { display: none; }

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
  /* The request budget: a ring around the list button (2026-10-21: not as a line at the master slider), like the
     ring around Play; it empties as the budget goes, amber below 40 %, red when a step does not fit before the reserve. */
  .count svg.bring { display: none; }
  .panel.docked .bar .count svg.bring {
    display: block; position: absolute; left: -4px; top: -4px; width: calc(100% + 8px); height: calc(100% + 8px); overflow: visible; pointer-events: none; filter: none;
  }
  .panel.docked .bar .count svg.bring rect { fill: none; stroke-width: 1.6; stroke-linecap: round; }
  .panel.docked .bar .count svg.bring .bring-bg { stroke: color-mix(in srgb, var(--qd), transparent 75%); }
  /* Mirrored (2026-10-28): the ring starts at the top right under the count badge and goes the other way, so the part
     under the badge stays filled and the end of the ring goes back to the badge as the budget empties. */
  .panel.docked .bar .count svg.bring .bring-fg { stroke: var(--bud-c, var(--qd)); transition: stroke-dasharray 0.3s; }
  .panel.docked .bar .count .n { z-index: 1; }
  /* The divider after the panel, like the QuantData dividers in the header: 1 x 28 px, the primary color, 24 px on each side. */
  .panel.docked .bar .end-sep { display: block; width: 1px; height: 28px; margin-left: 16px; background: var(--qd); }
  .panel.docked .bar .play { margin: 0; position: relative; overflow: visible; }
  /* The ring: an SVG with an even stroke (a CSS mask on 30.6 px rounded unevenly). It empties with stroke-dasharray. */
  .panel.docked .bar .play svg.ring {
    position: absolute; left: -4px; top: -4px; width: calc(100% + 8px); height: calc(100% + 8px); overflow: visible;
    pointer-events: none; opacity: 0; filter: none;
  }
  .panel.docked .bar .play svg.ring rect { fill: none; stroke: var(--ring, #ff1f1f); stroke-width: var(--ring-w, 2); stroke-linecap: round; }
  /* Rate limit: a strong red. The budget wait: thinner and light. They must never look alike. */
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
     the state stays clear also during the hover (2026-10-11: on a large screen you could not see if a click
     switched it on; before, the hover of "off" looked like "on"). */
  /* The outline is a border, not an inset shadow: the browser puts a border on whole device pixels, so both ends
     are equal at each zoom (2026-10-11: with the shadow one end was thicker at some zoom levels). */
  .panel.docked .bar .rth { background: transparent; border: 1.5px solid color-mix(in srgb, var(--qd), transparent 25%);
    color: color-mix(in srgb, var(--qtext), transparent 35%); }
  .panel.docked .bar .rth:hover { background: color-mix(in srgb, var(--qd), transparent 82%); color: var(--qtext); }
  .panel.docked .bar .rth.on { background: var(--qd); border-color: var(--qd); color: var(--qtext); }
  .panel.docked .bar .rth.on:hover { background: color-mix(in srgb, var(--qd), white 15%); }
  .panel.docked .bar .align { background: transparent; box-shadow: none; color: var(--accent); padding: 0 10px; }
  .panel.docked .bar .slow { background: transparent; box-shadow: inset 0 0 0 1px #ff8a7a; color: var(--qtext); }
  .panel.docked .bar .rate { color: #ff8a7a; }
  .panel.docked .bar .pace { color: color-mix(in srgb, var(--qtext), transparent 25%); }
  /* Narrow: the master slider stays as long as possible (also on a MacBook). First the start and end
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
  /* The menus on the charts (Lines, the order menu): the look of the panel list (its colors and border; 2026-10-15),
     in the middle of its chart, over the same dark backdrop. */
  .list.gmenu { z-index: 2147483646; width: min(380px, calc(100vw - 16px)); padding: 2px 10px 6px; }
  .backdrop.gback { z-index: 2147483645; }
  .gmenu .sec:last-child { border-bottom: 0; }
  .gmenu .sec-h span:first-child { color: var(--l-text); font-size: 13px; }
  .gmenu .sec-h .sec-v { max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gmenu .opt span { display: flex; align-items: center; gap: 6px; }
  .gmenu .g-num { width: 52px; height: 24px; box-sizing: border-box; padding: 0 6px; border-radius: 6px; border: 1px solid var(--l-line);
    background: rgba(0, 0, 0, 0.25); color: var(--l-text); font: inherit; font-variant-numeric: tabular-nums; text-align: right; }
  .gmenu .g-num:focus { outline: 2px solid var(--l-accent); outline-offset: -1px; }
  .list .pl-own { display: inline-flex; align-items: center; gap: 6px; margin-left: 4px; color: var(--l-muted); font-weight: 600; }
  .list .sec-h.sub-h { margin-top: 8px; font-weight: 500; }
  .list .sd-lv.off, .list .gap-set.off { opacity: 0.4; pointer-events: none; }
  .list .pic-clear:hover { background: var(--l-hover); }
  .list .pic-clear:active { transform: translateY(1px); }
  .list .sdsec.sdoff > :not(.sec-h) { opacity: 0.4; pointer-events: none; }
  .list .pic-line { margin: 6px 6px 2px; }
  .list .pic-tl { display: block; width: 100%; height: 14px; border-radius: 4px; }
  .list .pic-tl-ax { display: flex; justify-content: space-between; color: var(--l-muted); font-size: 11px; margin-top: 2px; font-variant-numeric: tabular-nums; }
  .list .gap-row { display: grid; grid-template-columns: 60px 1fr auto; gap: 10px; font-variant-numeric: tabular-nums; }
  .list .gap-row span:last-child { color: var(--l-muted); }
  /* Linking: name, ticker · group, then the switches in 3 columns (Strikes, Scale, Crosshair). */
  .list .lhead { justify-content: space-between; }
  .list .lcols, .list .lctl { display: inline-grid; grid-template-columns: 58px 46px 66px; justify-items: center; align-items: center; }
  .list .lcols span { font-size: 11px; color: var(--l-muted); }
  .list .lrow { display: flex; align-items: center; gap: 8px; }
  .list .lrow .name { flex: 1; min-width: 0; }
  .list .lrow .lctl input { margin: 0; }
  /* Strikes and Crosshair: check boxes as in the other lists; Scale: a small letter chip (–, A, B, C) of the same height. */
  .list .lrow .sgrp { all: unset; cursor: pointer; min-width: 22px; height: 18px; padding: 0 5px; box-sizing: border-box; border-radius: 4px; text-align: center;
    line-height: 18px; font-weight: 700; font-size: 11px; color: var(--l-muted); box-shadow: inset 0 0 0 1px var(--l-line); }
  .list .lrow .sgrp:hover { box-shadow: inset 0 0 0 1px var(--l-muted); }
  .list .lrow .sgrp.on { background: var(--l-accent); color: var(--l-on-accent); box-shadow: none; } /* the custom chart off: its options do nothing */
  .list .g-num { width: 52px; height: 24px; box-sizing: border-box; padding: 0 6px; border-radius: 6px; border: 1px solid var(--l-line);
    background: rgba(0, 0, 0, 0.25); color: var(--l-text); font: inherit; font-variant-numeric: tabular-nums; text-align: right; }
  /* The floating trade panel (like TradingView's buy / sell panel) and the right click menu. */
  .tpanel { position: fixed; z-index: 2147483646; width: 280px; padding: 6px 8px 8px; border-radius: 8px; color: #e8eaef;
    background: rgba(17, 19, 24, 0.96); border: 1px solid rgba(255, 255, 255, 0.14); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    font: 500 12px/16px interVariableFont, Inter, -apple-system, system-ui, sans-serif; }
  .tpanel .tp-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; cursor: move; color: rgba(255, 255, 255, 0.6); font-size: 11px; user-select: none; }
  .tpanel .tp-tk { flex: 1; }
  .tpanel .tp-x { cursor: pointer; font-size: 15px; padding: 0 4px; }
  .tpanel .tp-row { display: flex; gap: 6px; align-items: stretch; margin-bottom: 6px; }
  .tpanel button { all: unset; cursor: pointer; box-sizing: border-box; border-radius: 6px; text-align: center; }
  .tpanel .tp-sell, .tpanel .tp-buy { flex: 1; display: flex; flex-direction: column; padding: 4px 6px; color: #fff; font-variant-numeric: tabular-nums; }
  .tpanel .tp-sell { background: rgb(239, 83, 80); }
  .tpanel .tp-buy { background: rgb(41, 98, 255); }
  .tpanel .tp-sell:hover, .tpanel .tp-buy:hover { filter: brightness(1.12); }
  .tpanel .tp-qty { width: 46px; box-sizing: border-box; border-radius: 6px; border: 1px solid rgba(255, 255, 255, 0.2); background: rgba(0, 0, 0, 0.3);
    color: #fff; font: inherit; font-weight: 700; text-align: center; }
  .tpanel .tp-inst button, .tpanel .tp-qs button { flex: 1; padding: 3px 6px; background: rgba(255, 255, 255, 0.08); font-weight: 600; }
  .tpanel .tp-inst button.on, .tpanel .tp-qs button.on { background: rgba(255, 255, 255, 0.22); }
  .tpanel .tp-qs button:hover, .tpanel .tp-step:hover { background: rgba(255, 255, 255, 0.16); }
  .tpanel .tp-qbox { display: flex; align-items: stretch; gap: 2px; }
  .tpanel .tp-step { width: 20px; background: rgba(255, 255, 255, 0.08); font-weight: 700; display: flex; align-items: center; justify-content: center; }
  .tpanel .tp-pos { display: flex; align-items: center; gap: 8px; min-height: 24px; font-variant-numeric: tabular-nums; }
  .tpanel .tp-st { flex: 1; }
  .tpanel .tp-close { padding: 3px 10px; background: rgba(255, 255, 255, 0.12); font-weight: 600; }
  /* The order menu (a right click on a price chart): opaque, so a bright chart behind it does not hide its text
     (2026-10-23); light blue and red for the text, a colored mark at the left. */
  .list.tctx { z-index: 2147483647; width: auto; min-width: 220px; padding: 4px; background: rgb(17, 19, 24);
    -webkit-backdrop-filter: none; backdrop-filter: none; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6); }
  /* A straight mark at the left of each row (a border on the round row was bent). */
  .list.tctx .row { position: relative; padding-left: 14px; }
  .list.tctx .row::before { content: ''; position: absolute; left: 5px; top: 50%; width: 3px; height: 14px; margin-top: -7px; border-radius: 2px; }
  .list.tctx .row:has(.t-buy)::before { background: rgb(41, 98, 255); }
  .list.tctx .row:has(.t-sell)::before { background: rgb(239, 83, 80); }
  .list.tctx .t-buy { color: rgb(130, 170, 255); font-weight: 600; }
  .list.tctx .t-sell { color: rgb(255, 138, 128); font-weight: 600; }
  .gmenu .g-clear { all: unset; cursor: pointer; color: var(--l-accent); font-weight: 600; margin-left: 6px; }
</style>
<div class="panel">
  <div class="backdrop" hidden></div>
  <div class="onb-back" hidden></div>
  <div class="onb" role="dialog" aria-label="QD Toolkit setup" hidden>
    <button type="button" class="onb-skip">Skip</button>
    <div class="onb-main"><div class="onb-media"></div><div class="onb-side"><div class="onb-tag"></div><h2 class="onb-title"></h2><div class="onb-text"></div><div class="onb-ctl"></div></div></div>
    <div class="onb-tip" hidden></div>
    <div class="onb-foot"><div class="onb-dots"></div><span class="onb-gap"></span><button type="button" class="onb-prev">Back</button><button type="button" class="onb-next">Next</button></div>
  </div>
  <div class="hl" hidden></div>
  <div class="tip" hidden></div>
  <div class="list" hidden>
    <div class="more"><span class="lbl">Play speed</span><select class="speed speed2" title="Time between two steps during play">${SPEEDS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select><button data-act="rth" class="rth rth2" title="RTH 09:30–16:00 ET">RTH</button></div>
    <div class="lwrap">
    <nav class="lnav">
      <button type="button" class="tab" data-tab="replay">Replay</button>
      <button type="button" class="tab" data-tab="charts">Price chart</button>
      <button type="button" class="tab" data-tab="link">Linking</button>
      <button type="button" class="tab" data-tab="sd">Indicators</button>
      <button type="button" class="tab" data-tab="gen">General</button>
      <a class="kofi" href="https://ko-fi.com/julianhtg" target="_blank" rel="noopener" title="QD Toolkit is free. If it helps you, you can support it on Ko-fi.">♥ Support on Ko-fi</a>
      <section class="sec keys nkeys">
        <div class="sec-h"><span>Keys</span></div>
        <div class="key"><span>1 step</span><span><kbd>←</kbd><kbd>→</kbd><i>or</i><kbd>,</kbd><kbd>.</kbd></span></div>
        <div class="key"><span>${SHIFT_STEPS} steps</span><span><kbd>⇧</kbd><i>+</i><kbd>←</kbd><kbd>→</kbd></span></div>
        <div class="key"><span>Start / end</span><span><kbd>${/Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl'}</kbd><i>+</i><kbd>←</kbd><kbd>→</kbd></span></div>
        <div class="key"><span>Play / pause</span><span><kbd>-</kbd></span></div>
      </section>
    </nav>
    <div class="lbody">
    <div class="pane" data-pane="replay"><div class="cols"><div class="col">
    <section class="sec budget-info" title="QuantData allows about 60 data requests, then 1 per second (saves of the chart settings do not count, minutes from the cache cost nothing). Play waits until a step fits and 10 requests stay free for your own clicks. The requests of all QuantData tabs in this browser count.">
      <div class="sec-h"><span>Play budget</span><span class="sec-v"><b class="b-free">–</b> of 60 free</span></div>
      <div class="meter"><i class="b-bar"></i><i class="b-res"></i></div>
      <div class="sub"><span>1 step: <b class="b-cost">–</b></span><span>10 kept for your clicks</span></div>
      <div class="sub b-snap" hidden><span>Cache: <b class="b-snapn">0</b> loads</span><span><b class="b-snaph">0</b> from memory</span></div>
      <div class="b-status"><span class="rate2" hidden></span><span class="pace2" hidden></span><button class="slow2" data-act="full-speed" hidden title="Play runs slower after a QuantData rate-limit message. Click for full speed again."></button></div>
    </section>
    <section class="sec">
      <div class="sec-h"><span>Display</span></div>
      <label class="opt zopts" hidden title="Covers the mini chart in the zoom bar after the right end (the mini chart shows the full day, also the future)."><span>Hide the future</span><input type="checkbox" class="sw opt-mask"></label>
      <label class="opt" title="After a step, each chart shows its old picture until QuantData has drawn the new data. You do not see the loading text."><span>Hold chart while loading</span><input type="checkbox" class="sw opt-freeze"></label>
    </section>
    <section class="sec">
      <div class="sec-h"><span>Cache<span class="beta" title="A new feature: tell me on Discord when something does not work">Beta</span></span><span class="sec-v pic-fill"></span></div>
      <label class="opt" title="A minute that was shown before shows at once after a step, and its data comes from memory: no data request. The memory empties at a reload."><span>Enable cache</span><input type="checkbox" class="sw opt-snap"></label>
      <label class="opt" title="Also the minutes before 09:30 and after 16:00 ET."><span>Outside RTH</span><input type="checkbox" class="sw opt-picx"></label>
      <div class="sec-h sub-h" title="The oldest minutes go first. A whole day needs more memory: the line above shows it."><span>Cache size (minutes)</span></div>
      <div class="sd-lv pic-max">${PIC_SIZES.map((v) => `<button type="button" data-v="${v}">${v === 1440 ? 'Day' : v}</button>`).join('')}</div>
      <div class="pic-line" title="The minutes of this day in the cache (bright: all charts, dim: some)."><canvas class="pic-tl" height="14"></canvas><div class="pic-tl-ax"><span class="pic-a"></span><span class="pic-b"></span></div></div>
      <div class="sd-lv"><button type="button" class="pic-clear" title="Removes all pictures and data of the cache.">Clear cache</button></div>
    </section>
    </div><div class="col">
    <section class="sec">
      <div class="sec-h"><span>Time sliders</span></div>
      <div class="rows"></div>
    </section>
    <section class="sec zsec" hidden>
      <div class="sec-h zoom-h"><span>Zoom bars that follow the time</span></div>
      <div class="rows zrows"></div>
    </section>
    </div></div></div>
    <div class="pane" data-pane="charts" hidden><div class="cols"><div class="col">
    <section class="sec">
      <div class="sec-h"><span>Chart</span></div>
      <label class="opt" title="The Stock Price / Time charts show the custom chart: candles up to the replay minute in a fixed width, free pan and zoom, levels, the trade and the σ lines. Off: QuantData's own charts."><span>Custom price chart</span><input type="checkbox" class="sw opt-oc"></label>
      <div class="sd-hint oc-align" hidden></div>
      <label class="opt" title="SELL / BUY at the replay minute, the contracts and ES or MES: at the top left of the custom price chart (QuantData's own chart: a floating panel). A right click on the chart places an order."><span>Trade buttons</span><input type="checkbox" class="sw opt-trade"></label>
      <label class="opt"><span>OHLC values</span><input type="checkbox" class="sw pc-ohlc"></label>
      <label class="opt"><span>Price line</span><input type="checkbox" class="sw pc-pline"></label>
      <div class="sec-h sub-h" title="Built from the 1-minute candles: the last candle ends at the replay minute (no future prices). QuantData's chips Candle / Line and 1 Min ... on the chart also set this; QuantData then loads the 1-minute candles again."><span>Candles</span></div>
      <div class="sd-lv pc-type"><button type="button" data-v="candle">Candle</button><button type="button" data-v="line">Line</button></div>
      <div class="sd-lv pc-n">${OC_NS.map((v) => `<button type="button" data-v="${v}">${v < 60 ? `${v}m` : `${v / 60}h`}</button>`).join('')}</div>
    </section>
    </div><div class="col">
    <section class="sec">
      <div class="sec-h"><span>Grid</span></div>
      <div class="sd-lv pc-grid"><button type="button" data-v="off">Off</button><button type="button" data-v="h">Horizontal</button><button type="button" data-v="v">Vertical</button><button type="button" data-v="both">Both</button></div>
      <div class="sd-lv pc-gs"><button type="button" data-v="solid">Solid</button><button type="button" data-v="dashed">Dashed</button><button type="button" data-v="dotted">Dotted</button></div>
      <div class="sd-lv pc-go">${OC_GRID_OP.map((v) => `<button type="button" data-v="${v}">${v} %</button>`).join('')}<span class="pl-own"><input type="text" inputmode="numeric" class="g-num pc-gop"> %</span></div>
    </section>
    <section class="sec">
      <div class="sec-h"><span>Price lines</span></div>
      <div class="sd-hint">Click the price axis of a price chart to add or remove a line at a strike.</div>
      <div class="sec-h sub-h"><span>Width (points)</span></div>
      <div class="sd-lv pl-w">${PL_WIDTHS.map((v) => `<button type="button" data-v="${v}">${String(v)}</button>`).join('')}<span class="pl-own"><input type="text" inputmode="decimal" class="g-num pl-nw"> pt</span></div>
      <div class="sec-h sub-h"><span>Strike step (points)</span></div>
      <div class="sd-lv pl-s">${PL_STEPS.map((v) => `<button type="button" data-v="${v}">${String(v)}</button>`).join('')}</div>
      <label class="opt"><span>Keep lines in view</span><input type="checkbox" class="sw pl-fit"></label>
      <label class="opt" title="A line shows only on the day of the chart where you added it."><span>Lines per day</span><input type="checkbox" class="sw pl-day"></label>
    </section>
    </div></div></div>
    <div class="pane" data-pane="link" hidden>
    <div class="cols"><div class="col">
    <section class="sec">
      <div class="sec-h"><span>Crosshair</span></div>
      <label class="opt" title="When the mouse is over a chart, a dashed line shows the same strike or time in the other charts of the same kind."><span>Shared crosshair</span><input type="checkbox" class="sw opt-xhair"></label>
    </section>
    </div><div class="col">
    <section class="sec">
      <div class="sec-h"><span>Value scale</span></div>
      <label class="opt" title="The strike charts keep their value scale: the first automatic range stays until you drag the value axis (or use the wheel on it). A double click on it takes the automatic range of now. Off: QuantData scales them again at each change. Needed for quick steps from the cache."><span>Draggable value scale</span><input type="checkbox" class="sw opt-sy"></label>
    </section>
    </div></div>
    <section class="sec lsec" hidden>
      <div class="sec-h lhead"><span>Strike charts</span><span class="lcols"><span title="The same strike range when you zoom or scroll one of them (the charts of 1 ticker)">Strikes</span><span title="Charts with the same letter share their value scale (the fixed scale)">Scale</span><span title="The crosshair line of the other charts in this chart">Crosshair</span></span></div>
      <div class="rows lrows"></div>
    </section>
    <div class="sd-hint pane-empty" hidden>No strike chart on this page.</div>
    </div>
    <div class="pane" data-pane="sd" hidden><div class="cols"><div class="col">
    <section class="sec sdsec" hidden title="1σ = prior close × prior-close VIX ÷ 15.87 % (the 15.87 rule: √252 = 15.87 trading days). The lines show prior close ± each selected σ on the strike charts.">
      <div class="sec-h"><span>Standard deviation (VIX ÷ 15.87)</span><input type="checkbox" class="sw opt-sd" title="Show the σ lines on the strike charts"></div>
      <div class="sd-in"></div>
      <div class="sd-hint">A value that you type is for the day of the charts only. Keep a field empty to use the automatic value.</div>
      <div class="sd-lv"></div>
      <label class="opt" title="The σ lines of the ticker also in the custom price chart (Stock Price / Time)."><span>On the price chart</span><input type="checkbox" class="sw opt-sdprice"></label>
      <div class="sd-ch"></div>
      <div class="sd-out" hidden></div>
    </section>
    </div><div class="col">
    <section class="sec gapsec" title="The overnight gap: the open (09:30) against the prior close (the value of the Standard deviation section). A line at the prior close on the price chart; filled when a candle up to the replay minute reaches it.">
      <div class="sec-h"><span>Gap close (overnight)</span><input type="checkbox" class="sw opt-gap" title="The line at the prior close on the price chart"></div>
      <div class="gap-out"></div>
      <div class="gap-set">
        <div class="sec-h sub-h"><span>Label</span></div>
        <div class="sd-lv gap-lb"><button type="button" data-v="off">Off</button><button type="button" data-v="size">Size</button><button type="button" data-v="full">Size + fill</button></div>
        <label class="opt"><span>Prior close line</span><input type="checkbox" class="sw gap-line"></label>
        <div class="sec-h sub-h"><span>Box opacity</span></div>
        <div class="sd-lv gap-op">${GAP_OP.map((v) => `<button type="button" data-v="${v}">${v} %</button>`).join('')}</div>
      </div>
    </section>
    </div></div></div>
    <div class="pane" data-pane="gen" hidden><div class="cols"><div class="col">
    <section class="sec">
      <div class="sec-h"><span>Settings</span></div>
      <label class="opt" title="The time field and the times in this list show the time of your computer, not New York time (ET). In the time field you can also type a time with ET after it, for example 10:30 ET."><span>Local time</span><input type="checkbox" class="sw opt-local"></label>
      <label class="opt" title="The times of the custom price chart and of the crosshair labels: 20:18 instead of 8:18 PM."><span>24-hour clock</span><input type="checkbox" class="sw opt-h24"></label>
      <div class="opt" title="The size of this menu"><span>Menu size</span><span class="sd-lv lz" style="margin:0"><button type="button" data-v="s">S</button><button type="button" data-v="m">M</button><button type="button" data-v="l">L</button></span></div>
      <label class="opt dev-only" title="Sends a log of the requests (method, path, status, time, size; no content), the steps, the cache and the loads to this computer (needs QD Toolkit Data and tests/realsite/logsink.py)."><span>Debug log</span><input type="checkbox" class="sw opt-dlog"></label>
    </section>
    </div><div class="col">
    <section class="sec">
      <div class="sec-h"><span>Help</span></div>
      <div class="report">
        <button class="link" data-act="report" title="Copies the slider data and the structure of 1 element that you click. Send it to the developer when a chart does not work.">Copy report…</button>
        <textarea class="report-text" readonly hidden></textarea>
      </div>
      <button type="button" class="link gen-onb" title="The guide of the first start: the features and their settings">Setup guide</button>
      <button type="button" class="link gen-news" title="The new features of this version">What's new</button>
      <a class="opt gen-guide" href="https://github.com/julianhtg/qd-toolkit/blob/main/docs/GUIDE.md" target="_blank" rel="noopener"><span>User guide</span><span>↗</span></a>
      <div class="opt"><span>Version</span><span class="gen-ver"></span></div>
    </section>
    </div></div>
    <div class="gen-cards">
      <div class="gcard dc">
        <div class="gc-h"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.6 5.2A17.6 17.6 0 0 0 15.3 4l-.5 1a16.3 16.3 0 0 0-5.6 0L8.7 4a17.5 17.5 0 0 0-4.4 1.3C1.6 9.4.8 13.4 1.2 17.3a17.7 17.7 0 0 0 5.4 2.7l1.1-1.8c-.6-.2-1.2-.5-1.8-.9l.4-.3a12.6 12.6 0 0 0 11.3 0l.4.3c-.6.4-1.2.7-1.8.9l1.1 1.8a17.6 17.6 0 0 0 5.4-2.7c.5-4.5-.7-8.5-3.1-12.1ZM8.5 14.9c-1.1 0-2-1-2-2.2s.9-2.2 2-2.2 2 1 2 2.2-.9 2.2-2 2.2Zm7 0c-1.1 0-2-1-2-2.2s.9-2.2 2-2.2 2 1 2 2.2-.9 2.2-2 2.2Z"/></svg><b>Discord</b></div>
        <p class="gc-t gc-dc-t">Have any questions, problems or ideas? Shoot me a message on Discord!</p>
        <button type="button" class="gc-b gen-copy" data-copy="bsjuli">Copy name: bsjuli</button>
      </div>
      <div class="gcard kf">
        <div class="gc-h"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8h14v5a6 6 0 0 1-6 6H9a6 6 0 0 1-6-6V8Zm14 1h1.5a3 3 0 0 1 0 6H17v-2h1.5a1 1 0 0 0 0-2H17V9ZM6 3.5c.6.7.6 1.6 0 2.3M10 3.5c.6.7.6 1.6 0 2.3M14 3.5c.6.7.6 1.6 0 2.3" stroke="var(--c)" stroke-width="1.4" stroke-linecap="round"/></svg><b>Ko-fi</b></div>
        <p class="gc-t gc-kf-t">Enjoy using QD Toolkit? Buy me a morning coffee to help maintain this project 🙂</p>
        <a class="gc-b" href="https://ko-fi.com/julianhtg" target="_blank" rel="noopener">Support on Ko-fi</a>
      </div>
    </div>
    </div>
    </div></div>
    <div class="msg" hidden></div>
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
    <span class="pace" hidden title="Play waits for the QuantData request budget (about 60 data requests, then 1 per second). Your own steps do not wait."></span>
    <button class="slow" data-act="full-speed" hidden title="Play runs slower after a QuantData rate-limit message. Click for full speed again."></button>
    <label class="spd"><span class="spd-t">Auto</span><select class="speed" title="Time between two steps during play. Auto waits until the data is loaded.">${SPEEDS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
    <button data-act="rth" class="rth" title="RTH 09:30–16:00 ET: start, end, master slider and play use this range" hidden>RTH</button>
    <button data-act="align" class="align" title="The sliders show different times. Click to set all sliders to the time of slider 1." hidden>≠ Align</button>
    <span class="sep"></span>
    <button data-act="list" class="count" title="Sliders that move together">${icon.sliders}<span class="n">0</span><svg class="bring" viewBox="0 0 40 40" preserveAspectRatio="none" aria-hidden="true"><rect class="bring-bg" x="1.2" y="1.2" width="37.6" height="37.6" rx="11" ry="11"/><rect class="bring-fg" x="1.2" y="1.2" width="37.6" height="37.6" rx="11" ry="11" pathLength="100" transform="matrix(-1 0 0 1 40 0)"/></svg></button>
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
  const optSnap = $('.opt-snap');
  const optDlog = $('.opt-dlog');
  const optPicX = $('.opt-picx');
  const picMaxEl = $('.pic-max');
  const picFill = $('.pic-fill');
  const picTl = $('.pic-tl');
  const optMask = $('.opt-mask');
  const msg = $('.msg');
  const hl = $('.hl');
  const tip = $('.tip');
  const masks = $('.masks');
  const xhairBox = $('.xhair');
  const lrows = $('.lrows');
  const linkH = $('.lsec');
  const optXhair = $('.opt-xhair');
  const optOc = $('.opt-oc');
  const optSy = $('.opt-sy');
  const optTrade = $('.opt-trade');
  const optSdPrice = $('.opt-sdprice');
  const optGap = $('.opt-gap');
  const gapOut = $('.gap-out');
  // The gap of each custom price chart of today (its newest drawing): "SPX  +12.50 pt  open" / "filled 10:42".
  let gapSig = '';
  function updateGapOut() {
    optGap.checked = cfg.gap !== false;
    syncGapSet();
    const rows = [...ocs.values()].map((S) => S.gap).filter(Boolean)
      .filter((x, i, a) => a.findIndex((y) => y.tk === x.tk) === i)
      .map((x) => [x.tk, `${x.gap >= 0 ? '+' : '−'}${usd(Math.abs(x.gap) / 100)} pt`, x.filled ? (x.at ? `filled ${clock(etMinOfMs(x.at))}` : 'no gap') : `${x.pct}% filled`]);
    const txt = rows.length ? '' : cfg.gap === false ? '' : 'Needs the prior close (the Standard deviation section) and a custom price chart of the day.';
    const sig = JSON.stringify([rows, txt]);
    if (sig === gapSig) return;
    gapSig = sig;
    gapOut.textContent = '';
    if (txt) {
      const h = document.createElement('div');
      h.className = 'sd-hint';
      h.textContent = txt;
      gapOut.append(h);
    }
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'opt gap-row';
      for (const s of r) {
        const sp = document.createElement('span');
        sp.textContent = s;
        row.append(sp);
      }
      gapOut.append(row);
    }
  }
  optGap.addEventListener('change', () => {
    cfg.gap = optGap.checked;
    saveCfg();
    cwSoon();
    updateGapOut();
  });
  const gapSet = $('.gap-set');
  function syncGapSet() {
    const gc = gapCfg();
    gapSet.classList.toggle('off', cfg.gap === false); // they stay (dimmed) when the gap is off (2026-10-28: they went away)
    for (const b of gapSet.querySelectorAll('.gap-lb button')) b.classList.toggle('on', b.dataset.v === gc.label);
    for (const b of gapSet.querySelectorAll('.gap-op button')) b.classList.toggle('on', Number(b.dataset.v) === gc.op);
    gapSet.querySelector('.gap-line').checked = gc.line;
  }
  function setGapLook(v) {
    cfg.gapLook = { ...gapCfg(), ...v };
    saveCfg();
    syncGapSet();
    cwSoon();
  }
  gapSet.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.closest('.gap-lb')) setGapLook({ label: b.dataset.v });
    else if (b.closest('.gap-op')) setGapLook({ op: Number(b.dataset.v) });
  });
  gapSet.querySelector('.gap-line').addEventListener('change', (e) => setGapLook({ line: e.target.checked }));
  syncGapSet();
  const sdSec = $('.sdsec');
  const sdIn = $('.sdsec .sd-in');
  const sdLv = $('.sdsec .sd-lv');
  const sdOut = $('.sdsec .sd-out');
  const sdCh = $('.sdsec .sd-ch');
  const optSd = $('.opt-sd');
  const optLocal = $('.opt-local');
  const optH24 = $('.opt-h24');
  const rateEl = $('.rate');
  const rateEl2 = $('.rate2');
  const paceEl2 = $('.pace2');
  const paceEl = $('.pace');
  const budgetInfo = $('.budget-info');
  const bFree = $('.b-free');
  const bCost = $('.b-cost');
  const bSnap = $('.b-snap');
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
    if (Math.abs(r.left - left) <= 0.5 && Math.abs(r.top - top) <= 0.5) return;
    // An offset (a size container, a transform) and maybe a scale (the zoom of the list, Menu size): a 2nd try gives both.
    const l2 = 2 * left - r.left;
    const t2 = 2 * top - r.top;
    Object.assign(el.style, { left: `${l2}px`, top: `${t2}px` });
    const q = el.getBoundingClientRect();
    const zx = l2 !== left && Math.abs(q.left - r.left) > 0.01 ? (q.left - r.left) / (l2 - left) : 1;
    const zy = t2 !== top && Math.abs(q.top - r.top) > 0.01 ? (q.top - r.top) / (t2 - top) : 1;
    if (Math.abs(q.left - left) > 0.5 || Math.abs(q.top - top) > 0.5) Object.assign(el.style, { left: `${l2 + (left - q.left) / zx}px`, top: `${t2 + (top - q.top) / zy}px` });
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
  // Menu size (2026-10-28: "die Größe einstellen können"; Medium = the size of 4dbca56)
  const LIST_ZOOMS = { s: 0.88, m: 1, l: 1.14 };
  const QDTS_VERSION = '1.1'; // the report, General › Version and What's new (raise it with manifest.json; 1.1 = the draft)
  const QDTS_DEV = false; // the developer build (the option Debug log); scripts/export-public.sh sets it to false
  const listZoom = () => LIST_ZOOMS[cfg.listZoom] || 1;
  // The height of the longest category (each pane shown once, without the fixed height), at the opening.
  function listHeight() {
    const panes = [...list.querySelectorAll('.lbody .pane')];
    const shown = panes.map((pn) => pn.hidden);
    list.style.height = 'auto';
    const wrap = list.querySelector('.lwrap');
    const rest = list.offsetHeight - wrap.offsetHeight; // the row above (narrow: speed, RTH)
    let h = 0;
    for (const pn of panes) {
      for (const q of panes) q.hidden = q !== pn;
      h = Math.max(h, wrap.offsetHeight);
    }
    panes.forEach((pn, i) => { pn.hidden = shown[i]; });
    list.style.height = `${Math.ceil(h + rest)}px`;
  }
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
    // Menu size (cfg.listZoom): the CSS zoom of the list; the sizes below are in the px of the window.
    const z = listZoom();
    if (list.style.zoom !== String(z)) list.style.zoom = String(z);
    const lr = list.getBoundingClientRect();
    const w = lr.width || Math.min(680, vw - 16);
    const h = Math.min(lr.height, Math.max(120, b - a));
    const top = Math.round(a + Math.max(0, (b - a - h) / 2));
    list.style.maxHeight = `${Math.max(120, b - top) / (lr.width && list.offsetWidth ? lr.width / list.offsetWidth : 1)}px`;
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

  // The state of Play on the Play button, for the header (1.14: no text in the bar, so the buttons do not move):
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

  // The budget in the list, always shown (1.14): the free requests, a meter with the reserve, the cost of 1 step.
  // The cache in the list: the fill ("120 / 400 · 9 MB") and a time line of the minutes of this day with pictures
  // (bright: each chart with a time slider has one, dim: some).
  let picOvSig = '';
  function picOverview() {
    if (list.hidden) return;
    let bytes = 0;
    for (const e of picCache.values()) bytes += e.bytes || 0;
    // The memory: the pictures and the loaded data of the bridge (characters of the JSON, about its bytes).
    const sn = bridge('snap');
    if (sn && sn.ok) bytes += sn.bytes || 0;
    const mins = new Set([...picCache.values(), ...dataIdx.values()].map((e) => `${e.day}|${e.et}`)).size;
    picFill.textContent = `${mins} min · ${(bytes / 1048576).toFixed(1)} MB`;
    const ref = refSlider();
    const r = ref && read(ref);
    const W = Math.round(picTl.getBoundingClientRect().width);
    if (!r || !isTime(r) || !W) return;
    const day = toolDay(toolOf(ref));
    const lo = cfg.rth ? RTH_OPEN : timeBase(r) + r.min;
    const hi = cfg.rth ? RTH_CLOSE : timeBase(r) + r.max;
    const tools = new Set(activeSliders().map((el) => sliderKeys.get(el)).filter(Boolean));
    const per = new Map(); // ET minute -> tool keys with a picture or a data snapshot
    for (const e of [...picCache.values(), ...dataIdx.values()]) {
      if (e.day !== day || e.et == null || e.et < lo || e.et > hi) continue;
      if (!per.has(e.et)) per.set(e.et, new Set());
      per.get(e.et).add(e.tk);
    }
    const cur = etOf(readV(ref)); // the minute on the screen (also during virtual steps)
    const sig = `${W}|${lo}|${hi}|${cur}|${tools.size}|${[...per].map(([m, t]) => `${m}:${t.size}`).join(',')}`;
    if (sig === picOvSig) return;
    picOvSig = sig;
    const dpr = devicePixelRatio || 1;
    picTl.width = W * dpr;
    picTl.height = 14 * dpr;
    const g = picTl.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cs = getComputedStyle(picTl);
    const accent = cs.getPropertyValue('--l-accent').trim() || '#3b82f6';
    g.fillStyle = cs.getPropertyValue('--l-chip').trim() || 'rgba(255,255,255,0.08)';
    g.fillRect(0, 0, W, 14);
    const x = (m) => ((m - lo) / Math.max(1, hi - lo)) * W;
    const bw = Math.max(1, W / Math.max(1, hi - lo));
    for (const [m, t] of per) {
      g.globalAlpha = t.size >= tools.size ? 1 : 0.4;
      g.fillStyle = accent;
      g.fillRect(x(m), 0, bw, 14);
    }
    g.globalAlpha = 1;
    // Where you are: a 2 px line in the text color with a dark edge (it shows on a filled and an empty minute).
    if (cur >= lo && cur <= hi) {
      const cx = Math.round(Math.min(W - 2, x(cur) + bw / 2 - 1));
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillRect(cx - 1, 0, 4, 14);
      g.fillStyle = cs.getPropertyValue('--l-text').trim() || '#fff';
      g.fillRect(cx, 0, 2, 14);
    }
    $('.pic-a').textContent = clock(lo);
    $('.pic-b').textContent = clock(hi);
  }
  function showBudget() {
    picOverview();
    // Both directions (2026-10-28: at the left end of the cached minutes a step back costs, a step forward not)
    const cost = stepInfo(1).cost;
    const back = stepInfo(-1).cost;
    const free = Math.max(0, Math.min(BUDGET_CAP, budgetNow()));
    bFree.textContent = String(Math.floor(free));
    bCost.textContent = `${back === cost ? cost : `← ${back} · → ${cost}`} request${back === cost && cost === 1 ? '' : 's'}`;
    bBar.style.width = `${(free / BUDGET_CAP) * 100}%`;
    budgetInfo.classList.toggle('low', free < BUDGET_RESERVE + cost);
    const sn = !list.hidden && cfg.snap === true ? bridge('snap') : null;
    bSnap.hidden = !(sn && sn.ok);
    if (sn && sn.ok) {
      bSnap.querySelector('.b-snapn').textContent = String(sn.n);
      bSnap.querySelector('.b-snaph').textContent = String(sn.hits);
    }
  }
  // The snapshot cache (bridge.js, 2026-10-24) skips a slider near the live end (the newest minutes still change) and
  // follows the option "Enable cache".
  let snapSent = null;
  function snapMarks() {
    const le = liveEnd();
    // The first slider value that is not cached (in the slider's own units): the bridge compares it when the GET starts.
    for (const el of activeSliders()) {
      const r = read(el);
      const cut = le !== null && isTime(r) ? String(le - timeBase(r) - 1) : '';
      if (el.getAttribute('data-qdts-livecut') !== cut) el.setAttribute('data-qdts-livecut', cut);
    }
    const on = cfg.snap === true;
    const fast = false; // the quick save answer (A+): no gain since QuantData's release of 2026-10-26 (it does not wait for it)
    if (snapSent !== `${on}|${fast}|${picMax()}`) {
      const r = bridge('snap', { on, fast, maxPer: picMax() });
      if (r && r.ok) snapSent = `${on}|${fast}|${picMax()}`;
    }
  }

  // The budget outside the list too (2026-10-21: the steps are fast now; a sign that the budget goes empty): the
  // ring around the list button, as long as the free part of the 60 requests; amber below 40 %, red when a step does not
  // fit before the reserve. Its tip has the numbers.
  let budgetBarSig = '';
  function showBudgetBar() {
    const cost = stepCost();
    const free = Math.max(0, Math.min(BUDGET_CAP, budgetNow()));
    const color = free < BUDGET_RESERVE + cost ? 'rgb(239, 83, 80)' : free < BUDGET_CAP * 0.4 ? 'rgb(255, 196, 0)' : 'var(--qd)';
    const sig = `${Math.round(free)}|${color}`;
    if (sig === budgetBarSig) return;
    budgetBarSig = sig;
    for (const b of root.querySelectorAll('button.count')) {
      const fg = b.querySelector('.bring-fg');
      // Full: a closed ring (a dash of 100 had its 2 round ends on top of each other; 2026-10-22).
      if (fg) fg.setAttribute('stroke-dasharray', free >= BUDGET_CAP - 0.5 ? 'none' : `${((free / BUDGET_CAP) * 100).toFixed(2)} 100`);
      b.style.setProperty('--bud-c', color);
      b.title = `Sliders that move together · Request budget: ${Math.floor(free)} of ${BUDGET_CAP} free (1 step: ${cost}; 1 comes back each second)`;
      b.dataset.budget = String(Math.floor(free));
    }
  }
  // The category of the list (cfg.listTab): its pane shows, the others are hidden.
  const LIST_TABS = ['replay', 'charts', 'link', 'sd', 'gen'];
  function showTab(tab) {
    const want = LIST_TABS.includes(tab) ? tab : 'replay';
    for (const b of list.querySelectorAll('.lnav .tab')) b.classList.toggle('on', b.dataset.tab === want);
    for (const pn of list.querySelectorAll('.lbody .pane')) pn.hidden = pn.dataset.pane !== want;
    updatePanes();
  }
  // A category without content (σ lines without a strike chart): a short hint.
  function updatePanes() {
    for (const pn of list.querySelectorAll('.lbody .pane')) {
      const e = pn.querySelector(':scope > .pane-empty');
      if (e) e.hidden = [...pn.querySelectorAll(':scope > .sec')].some((s) => !s.hidden && !s.querySelector('.opt-xhair'));
    }
  }
  list.querySelector('.lnav').addEventListener('click', (e) => {
    const b = e.target.closest('.tab');
    if (!b) return;
    cfg.listTab = b.dataset.tab;
    saveCfg();
    showTab(cfg.listTab);
  });
  function openList(open) {
    list.hidden = !open;
    backdrop.hidden = !open;
    if (open) showTip('');
    if (open) {
      buildList();
      showTab(cfg.listTab);
      showBudget();
      if (!list.classList.contains('gmenu') && !list.classList.contains('tctx')) listHeight();
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
  // (Up to 1.12 it stayed 2 minutes behind, because a drag could not hit the exact minute. 2026-10-10: the exact minute fits.)
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
    const t0 = performance.now();
    qdAliasFlush();
    bridgeAnswer = undefined;
    const id = ++bridgeSeq;
    document.dispatchEvent(new CustomEvent('qdts:req', { detail: JSON.stringify({ id, op, args }) }));
    perfAdd(`b:${op}`, t0);
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
    const r = readV(ref);
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
        if (!zoomOn(z) || !z.root.isConnected || userOn(z) || ocOwnsBar(z)) continue; // the own chart sets its bar
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
        plSoon(700); // the price scale of a price chart changes with the visible candles
        legendsSoon();
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
  // The scale group of a strike chart (Linking: –, A, B, C; by its bar key) and its crosshair (on unless cfg.xhOff).
  const syGroupOf = (key) => ((cfg.syGroup || {})[key] || '');
  const xhOn = (key) => !(cfg.xhOff || {})[key];

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

  // The list keeps the strike charts while QuantData loads them (2026-10-11): a step removes the header and the
  // zoom bar of each strike chart for its load, and the rows of "Linked strike charts" and the σ fields must not go away
  // or move for that time. A chart that is not on the page stays in the list while its tool is on the page (max 60 s;
  // it comes back after the load), else 3 s. The day of its date chip stays too (readSdAuto). A tool in a hidden tab
  // is not in the list (2026-10-11; it stays in its group, so it has the range of the group when it shows).
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
  // Live follow (2026-10-10: "seamless"): while you drag or wheel in a chart of a group, read its range in
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
    // Your zoom or pan on a chart (wheel, or a press on a chart or a zoom bar): the pictures of the minutes show the
    // old view, so they go (the picture cache).
    if (e.type !== 'pointerup' && e.target instanceof Element && e.target.closest('[data-qdts-chart], [data-qdts-bar], [class*="QDChartZoomSlider-module__"]')) {
      picDrop();
      // The copies over charts that do not load any more go at once: your zoom happens on the real chart under them
      // (the copy lets the mouse through), and you would not see it (2026-10-28: "man kann nicht zoomen" under it).
      // Also the other charts: a linked group moves with this chart.
      for (const [tool, f] of [...freezes]) if (!f.hold && !toolLoading(tool)) { f.trace.push([Math.round(performance.now() - f.start), 'your input']); unfreeze(tool); }
    }
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
    optOc.checked = ocOn();
    const oa = $('.oc-align');
    const at = ocAlignInfo;
    // Short (2026-10-21: the long text with the price and the candle made the list too long).
    const txt = ocOn() && (at || ocShift()) ? `Matched to the strike charts: ${ocShift() > 0 ? '+' : ocShift() < 0 ? '−' : '±'}${Math.abs(ocShift())} min` : '';
    if (oa.textContent !== txt) oa.textContent = txt;
    oa.hidden = !txt;
    optSy.checked = syOn();
    optTrade.checked = !!cfg.tradeOn;
    optSdPrice.checked = cfg.sd.price !== false;
    syncChartOpts();
    for (const e of entries) {
      // 2026-10-23: per strike chart its links: Strikes (the group of its ticker), Scale (a group letter), Crosshair.
      const row = document.createElement('div');
      row.className = 'row lrow';
      const cb = document.createElement('input');
      cb.title = 'Strikes: the same strike range as the other charts of its ticker';
      cb.type = 'checkbox';
      cb.className = 'lk';
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
      const sg = document.createElement('button');
      sg.type = 'button';
      sg.className = 'sgrp';
      sg.title = 'Scale group: charts with the same letter share their value scale. Click: –, A, B, C';
      const xh = document.createElement('input');
      xh.type = 'checkbox';
      xh.className = 'xh';
      xh.title = 'Crosshair: the line of the other charts in this chart, and its line in them';
      const paint = () => {
        const g = syGroupOf(e.key);
        sg.textContent = g || '–';
        sg.classList.toggle('on', !!g);
        xh.checked = xhOn(e.key);
      };
      sg.addEventListener('click', (ev) => {
        ev.preventDefault();
        const order = ['', 'A', 'B', 'C'];
        const next = order[(order.indexOf(syGroupOf(e.key)) + 1) % order.length];
        cfg.syGroup = { ...(cfg.syGroup || {}) };
        if (next) cfg.syGroup[e.key] = next;
        else delete cfg.syGroup[e.key];
        saveCfg();
        paint();
        syRefresh();
      });
      xh.addEventListener('change', () => {
        cfg.xhOff = { ...(cfg.xhOff || {}) };
        if (xhOn(e.key)) cfg.xhOff[e.key] = true;
        else delete cfg.xhOff[e.key];
        saveCfg();
        paint();
      });
      paint();
      const ctl = document.createElement('span');
      ctl.className = 'lctl';
      ctl.append(cb, sg, xh);
      row.append(name, val, ctl);
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
  const localFmt = localClock;
  function xText(kind, v) {
    if (kind === 'time') return localFmt.format(new Date(v));
    const d = Math.round(v) / 100;
    const whole = Number.isInteger(d);
    return '$' + d.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 });
  }
  // The crosshair of the chart under the mouse while a copy or a picture covers it (2026-10-28: QuantData's crosshair
  // is under the copy): 2 dashed lines in the primary color at the mouse, over the copy, inside the chart canvas.
  let xSelf = null;
  function selfXhair(src, pt) {
    // Covered: a copy or a picture (the freeze box: the copies of a load and the pictures of virtual steps) at the mouse.
    const covered = src && [...freezeBox.querySelectorAll('img, canvas')].some((n) => {
      if (n.style.visibility === 'hidden' || n.closest('[style*="visibility: hidden"]')) return false;
      const r = n.getBoundingClientRect();
      return r.width > 0 && pt.x >= r.left && pt.x <= r.right && pt.y >= r.top && pt.y <= r.bottom;
    });
    if (!covered) {
      if (xSelf) xSelf.v.style.display = xSelf.h.style.display = 'none';
      return;
    }
    if (!xSelf || !xSelf.v.isConnected) {
      const mk = () => { const d = document.createElement('div'); d.dataset.qdtsSelfxh = '1'; d.style.cssText = 'position:fixed;pointer-events:none;z-index:2;display:none;'; return d; };
      xSelf = { v: mk(), h: mk() };
    }
    if (xSelf.v.parentElement !== freezeBox) freezeBox.append(xSelf.v, xSelf.h);
    const b = src.getBoundingClientRect();
    const col = sdColorsNow().primary;
    const x = Math.round(Math.max(b.left, Math.min(b.right - 1, pt.x)));
    const y = Math.round(Math.max(b.top, Math.min(b.bottom - 1, pt.y)));
    Object.assign(xSelf.v.style, { display: 'block', left: `${x}px`, top: `${b.top}px`, width: '1px', height: `${b.height}px`,
      background: `repeating-linear-gradient(to bottom, ${col} 0 4px, transparent 4px 8px)` });
    Object.assign(xSelf.h.style, { display: 'block', left: `${b.left}px`, top: `${y}px`, width: `${b.width}px`, height: '1px',
      background: `repeating-linear-gradient(to right, ${col} 0 4px, transparent 4px 8px)` });
  }
  function hideXhair(keepSelf = false) {
    if (xSelf && !keepSelf) xSelf.v.style.display = xSelf.h.style.display = 'none';
    for (const e of xEls) e.line.style.display = e.label.style.display = 'none';
    for (const cv of xCanvases) clearXCanvas(cv);
    ocXhair(null, null);
  }
  // The own price charts (1.1) draw the line of another chart themselves (at their own candle of that time); their
  // hidden QuantData charts get no line. src: the own chart under the mouse (it draws its own crosshair).
  function ocXhair(t, src) {
    for (const S of ocs.values()) {
      const v = S === src ? null : t;
      if (S.ext === v) continue;
      S.ext = v;
      ocSoon(S);
    }
  }
  // The line itself is drawn on a canvas in the target chart (after its chart canvas and our other canvases, before
  // QuantData's overlay canvas), in whole device pixels: a 1 px DOM line with a gradient sometimes did not show on a
  // large monitor (2026-10-15), like the first σ lines in Safari. The .xline element stays as an invisible
  // marker of the place (the tests read it).
  const xCanvasOf = new WeakMap(); // chart canvas -> crosshair canvas
  const xCanvases = new Set();
  function xCanvas(c) {
    let cv = xCanvasOf.get(c);
    if (!cv || !cv.isConnected || cv.parentElement !== c.parentElement) {
      if (cv) cv.remove();
      cv = document.createElement('canvas');
      cv.className = 'qdts-xh';
      cv.setAttribute('aria-hidden', 'true');
      cv.style.cssText = 'position:absolute;pointer-events:none;margin:0;padding:0;border:0;display:none;';
      xCanvasOf.set(c, cv);
    }
    // Before QuantData's overlay canvas (its own crosshair and tooltip), after the σ canvas.
    let after = c;
    while (after.nextElementSibling && /\bqdts-sd\b/.test(after.nextElementSibling.className)) after = after.nextElementSibling;
    if (after.nextElementSibling !== cv) after.after(cv);
    xCanvases.add(cv);
    return cv;
  }
  function clearXCanvas(cv) {
    if (!cv._drawn) return;
    cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
    cv._drawn = false;
    cv.style.display = 'none';
    if (!cv.isConnected) xCanvases.delete(cv);
  }
  // The other charts that can get a line: for a strike chart the charts of its group, for a time chart all others.
  // A strike chart with its crosshair off (Linking): no line in it, and its mouse gives no line in the others.
  const xhOff = (c) => {
    const z = zoomBars.find((b) => !b.vertical && b.tool && b.tool.contains(c));
    return !!z && !xhOn(z.key);
  };
  function xPeers(src) {
    const tool = toolOf(src);
    const gidOf = (c) => (zoomBars.find((z) => z.gid && !z.vertical && z.tool && z.tool.contains(c)) || {}).gid || '';
    const gid = gidOf(src);
    const all = [...document.querySelectorAll('canvas[data-qdts-chart]')].filter((c) => c !== src && isChart(c) && !(tool && tool.contains(c)) && !ocs.has(c.getAttribute('data-qdts-chart')) && !xhOff(c));
    const keys = (a) => a.map((c) => c.getAttribute('data-qdts-chart'));
    return { strikePeers: gid ? keys(all.filter((c) => gidOf(c) === gid)) : [], timePeers: keys(all) };
  }
  // The scale of a canvas on the screen (the Infinite Page scales its plane): the plot numbers are CSS px of the canvas.
  const scaleOf = (c, b) => b.width / (c.offsetWidth || b.width) || 1;
  // The layout of the charts (bridge op charts), shared for 30 ms: the σ lines, the own charts and the fixed scale read it in the same refresh or frame (fewer bridge calls).
  let chartsMemo = { at: -Infinity, v: null };
  // fresh: read now (the σ lines after a load: the layout changes in that frame), and keep it for the others.
  function chartsNow(fresh) {
    if (fresh || performance.now() - chartsMemo.at > 30) chartsMemo = { at: performance.now(), v: bridge('charts') };
    return chartsMemo.v;
  }
  function tagCharts() {
    for (const c of document.querySelectorAll('canvas[class*="nativeChartSurface-module__"]')) {
      if (isChart(c) && !c.hasAttribute('data-qdts-chart')) c.setAttribute('data-qdts-chart', String(++chartSeq));
    }
  }
  function drawXhair() {
    xRaf = 0;
    const pt = xPt;
    // The own price chart under the mouse: the time of its candle there.
    const own = pt && cfg.xhair && pt.el instanceof Element && pt.el.hasAttribute('data-qdts-oc') ? ocs.get(pt.el.getAttribute('data-qdts-oc')) : null;
    const ownT = own ? ocHoverT(own) : null;
    const src = own ? (ownT != null && own.c.isConnected ? own.c : null) : pt && cfg.xhair && isChart(pt.el) && pt.el.isConnected && !xhOff(pt.el) ? pt.el : null;
    if (!src) return hideXhair();
    if (!own) selfXhair(src, pt);
    tagCharts();
    const sb = src.getBoundingClientRect();
    const ssc = scaleOf(src, sb);
    // The page bridge snaps the value under the mouse like QuantData (to a strike or a row time of this chart)
    // and gives the place in each other chart.
    const res = own ? bridge('xhair', { t: ownT, ...xPeers(src) })
      : bridge('xhair', { k: src.getAttribute('data-qdts-chart'), lx: (pt.x - sb.left) / ssc, ly: (pt.y - sb.top) / ssc, ...xPeers(src) });
    if (!res || !res.ok) return hideXhair(true); // no lines in the other charts; ours over a copy stays
    ocXhair(res.kind === 'time' ? res.v : null, own);
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
      // The drawn line: 4 px on / 4 px off from the plot top, the primary color, 1 CSS px wide at a whole device column.
      const cv = xCanvas(c);
      const u = (devicePixelRatio || 1) * sc;
      const cw = Math.round(c.offsetWidth * u);
      const ch = Math.round(c.offsetHeight * u);
      if (cv.width !== cw) cv.width = cw;
      if (cv.height !== ch) cv.height = ch;
      Object.assign(cv.style, { left: `${c.offsetLeft}px`, top: `${c.offsetTop}px`, width: `${c.offsetWidth}px`, height: `${c.offsetHeight}px`, display: 'block' });
      const g = cv.getContext('2d');
      g.clearRect(0, 0, cw, ch);
      g.fillStyle = sdColorsNow().primary;
      const X = Math.round((x - b.left) / sc * u);
      const lw = Math.max(1, Math.round(u));
      const y1 = t.bottom * u;
      for (let y = t.top * u, on = 4 * u; y < y1; y += 2 * on) g.fillRect(X, Math.round(y), lw, Math.round(Math.min(on, y1 - y)));
      cv._drawn = true;
      cv.dataset.k = t.k;
      e.line.style.setProperty('--s', String(sc));
      e.label.textContent = xText(res.kind, t.v);
      Object.assign(e.label.style, { left: `${x + sc / 2}px`, top: `${b.top + (t.bottom + 2) * sc}px`, display: 'block' });
      e.label.style.setProperty('--s', String(sc));
      e.line.dataset.k = e.label.dataset.k = t.k;
      n++;
    }
    for (let i = n; i < xEls.length; i++) xEls[i].line.style.display = xEls[i].label.style.display = 'none';
    const used = new Set(res.lines.map((t) => document.querySelector(`canvas[data-qdts-chart="${t.k}"]`)).filter(Boolean).map((c) => xCanvasOf.get(c)));
    for (const cv of xCanvases) if (!used.has(cv)) clearXCanvas(cv);
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
  const SD_LEVELS = [1, 2, 3]; // 2026-10-11: only ±1σ, ±2σ, ±3σ (nobody uses 0.5, 1.2, 1.5)
  cfg.sd = { ...defaults.sd, ...cfg.sd };
  const sdStored = Array.isArray(cfg.sd.levels) ? cfg.sd.levels : defaults.sd.levels;
  cfg.sd.levels = sdStored.filter((k) => SD_LEVELS.includes(k));
  if (!cfg.sd.levels.length && sdStored.length) cfg.sd.levels = [...defaults.sd.levels]; // only old levels were stored
  // A typed value is for 1 day: the day of the strike charts when you typed it (2026-10-11; before, a typed VIX
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
    // Nothing shows the values: no page work. The gap close on a custom price chart needs the prior close too (before, it
    // waited until σ was on or the list was open: the gap came late; 2026-10-23).
    const gapNeeds = cfg.gap !== false && ocs.size > 0;
    if (!(sdTickers().length || gapNeeds) || (!cfg.sd.on && list.hidden && !gapNeeds)) return;
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
    if (changed) cwSoon(); // the σ lines and the gap of the custom price charts at once, not at the next step
    if (changed && !list.hidden) buildSdList();
  }

  // The fields are built again only when the tickers change. A new automatic value changes only the grey placeholder,
  // so the list keeps its size and a field that you type in keeps its focus (2026-10-11).
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
    sdSec.classList.toggle('sdoff', !cfg.sd.on); // its settings dimmed while the σ lines are off (2026-10-28)
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
      // "i": shows the values of ±1σ, ±2σ and ±3σ (2026-10-11: below the levels, only when you want them).
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
  // The charts with σ lines (2026-10-11: not on every strike chart): 1 row per strike chart with a ticker (also
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
    sdSec.classList.toggle('sdoff', !cfg.sd.on);
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
  // "+1σ <price>", "−1σ <price>", "+2σ …". They go into the legend row when they fit (2026-10-11: no 2nd row
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
    // Never cut: QuantData's items shrink and end with "…" when the row is full (2026-10-11: with 3 levels the
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
  // layout; 2026-10-11: no blink, no wrong places, no label jump). Only in the normal refresh (400 ms) and with
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
  const PILL_BLUE = 'hsl(205, 90%, 62%)'; // our pills in the toolbars
  const TRASH_SVG = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5"/></svg>';
  // The title of a tool's chart ("Delta Exposure By Strike - SPX").
  const headTitle = (tool) => {
    const t = tool && [...tool.querySelectorAll('[class*="QDChartHeader-module__"]')].find((n) => hasToken(n, /^QDChartHeader-module__.*__title$/));
    return t ? t.textContent.trim() : '';
  };

  // ---------------------------------------------------------------------------
  // Price lines (1.1): lines at strikes on the Stock Price / Time charts.
  // A click on the price axis (left of the plot) adds a line at the nearest strike (the strike step: 1, 2.5, 5 or 10),
  // a click at a line removes it. A line is a band of its width in points around the strike (1 point, 2.5 points ...),
  // so it keeps its meaning at each zoom. The lines are per ticker (all its price charts). The pill "Lines" in the
  // toolbar of a price chart opens the menu: the width of new lines, the strike step, the lines with their widths.
  // Drawn on 1 canvas per chart (like the σ lines), in the refresh, after your input on the chart and after a zoom
  // sync of the time (the price scale changes with the visible candles).
  // ---------------------------------------------------------------------------
  const plCfg = () => ({ w: 1, step: 5, fit: true, ...(cfg.pl || {}) });
  // Your own y range per price chart (tool element -> [lo, hi] cents): drag or wheel on the price axis; a double click
  // or "Automatic" gives QuantData's automatic range back. Not stored: a reload shows the automatic range.
  const plRange = new WeakMap();
  const plApplied = new WeakMap(); // chart canvas -> the signature of the y values given to the page bridge
  // The drawings of a ticker (cfg.plines); t: their type ('hline': a price line; a line of before has none). Later
  // drawing tools add other types (2026-10-22).
  const plLines = (tk) => ((cfg.plines || {})[tk || ''] || []).filter((x) => x && (!x.t || x.t === 'hline') && x.p > 0 && x.w > 0);
  // The lines shown on a chart: the option "Lines only on their day" (2026-10-22; cfg.pl.dayOnly) shows a line
  // only on the day of the chart where you added it (its date chip; a line of before 1.1 has no day: always).
  const plDayOk = (x, day) => !plCfg().dayOnly || !day || !x.day || x.day === day;
  const plLinesAt = (tk, tool) => {
    const day = tool ? toolDay(tool) : '';
    return plLines(tk).filter((x) => plDayOk(x, day));
  };
  // The width of all lines (and of new ones): 1 width, not 1 per line (2026-10-21).
  function setPlWidth(w) {
    cfg.pl = { ...plCfg(), w };
    cfg.plines = Object.fromEntries(Object.entries(cfg.plines || {}).map(([k, ls]) => [k, (ls || []).map((x) => ({ ...x, w }))]));
    saveCfg();
    plScanAt = -Infinity;
    drawPriceLines();
    cwSoon();
  }
  function setPlLines(tk, lines) {
    cfg.plines = { ...(cfg.plines || {}), [tk || '']: lines.slice(0, 40).sort((a, b) => a.p - b.p) };
    saveCfg();
    drawPriceLines();
    cwSoon();
  }
  const plCanvasOf = new WeakMap(); // chart canvas -> price line canvas
  const plShown = new Set();
  let plInfos = []; // the price charts of the last pass: { c, tool, tk, info }
  let plFollowUntil = 0;
  function plCanvas(c) {
    let cv = plCanvasOf.get(c);
    if (!cv || !cv.isConnected || cv.parentElement !== c.parentElement) {
      if (cv) cv.remove();
      cv = document.createElement('canvas');
      cv.className = 'qdts-pl';
      cv.setAttribute('aria-hidden', 'true');
      cv.style.cssText = 'position:absolute;pointer-events:none;margin:0;padding:0;border:0;';
      c.after(cv); // before QuantData's overlay canvas: its crosshair and tooltip stay on top
      plCanvasOf.set(c, cv);
    }
    cv._chart = c;
    return cv;
  }
  // The pill in the toolbar of a price chart.
  function plPill(tool, n) {
    const bar = [...tool.querySelectorAll('[class*="QDToolLayout-module__"]')].find((e) => hasToken(e, /^QDToolLayout-module__.*__toolbarButtons$/))
      || [...tool.querySelectorAll('[class*="QDToolLayout-module__"]')].find((e) => hasToken(e, /^QDToolLayout-module__.*__toolbar$/));
    if (!bar) return;
    // Our pills in 1 group right after QuantData's first item (the ticker chip): the toolbar spreads its items
    // (space-between), so single pills stood apart (2026-10-18). The group takes the free room.
    let box = bar.querySelector(':scope > [data-qdts-pills]');
    if (!box) {
      box = document.createElement('span');
      box.dataset.qdtsPills = '1';
      box.style.cssText = 'display:flex;align-items:center;flex:1 1 auto;min-width:0;margin:0 0 0 6px;padding:0;';
    }
    const first = [...bar.children].find((e) => e !== box);
    if (first ? first.nextElementSibling !== box : box.parentElement !== bar) {
      if (first) first.after(box);
      else bar.append(box);
    }
    let p = box.querySelector(':scope > [data-qdts-plpill]');
    if (!p) {
      p = document.createElement('span');
      p.dataset.qdtsPlpill = '1';
      p.setAttribute('role', 'button');
      p.title = 'Remove the drawings of this chart (click twice). Add a line: click the price axis.';
      p.style.cssText = 'display:inline-flex;align-items:center;flex:none;height:23px;box-sizing:border-box;padding:2px 9px;margin:0 6px 0 0;'
        + 'border-radius:16px;font:700 12px/19px interVariableFont, Inter, -apple-system, system-ui, sans-serif;cursor:pointer;user-select:none;white-space:nowrap;';
      box.prepend(p);
    }
    // A trash button (2026-10-22: the settings went into the list; later more drawing tools come next to it):
    // the number of drawings, red "Clear N?" after the 1st click.
    const armed = !!(p._armed && performance.now() < p._armed && n);
    const state = `${n}|${armed}`;
    if (p._state === state) return;
    p._state = state;
    p.innerHTML = `${TRASH_SVG}${armed ? `<span>Clear ${n}?</span>` : n ? `<span>${n}</span>` : ''}`;
    p.style.gap = '5px';
    p.style.opacity = n ? '1' : '0.55';
    p.style.cursor = n ? 'pointer' : 'default';
    Object.assign(p.style, armed
      ? { background: 'rgb(239, 83, 80)', color: '#fff', border: '1.5px solid rgb(239, 83, 80)' }
      : { background: 'hsla(205, 90%, 62%, 0.14)', color: PILL_BLUE, border: '1.5px solid hsla(205, 90%, 62%, 0.6)' });
  }
  function drawPriceLines() {
    try {
      drawPriceLinesNow();
    } catch (err) {
      if (!sdErrorShown) console.warn('[QD Toolkit] price lines', err);
      sdErrorShown = true;
    }
  }
  let plScanAt = -Infinity;
  function drawPriceLinesNow() {
    // No line and no preview on the page: look for price charts (their pills) at most every 400 ms, not in each frame.
    if (!plShown.size && !plPrev && !cfg.trade && !cfg.tradeOn && performance.now() - plScanAt < 400) return;
    plScanAt = performance.now();
    tagCharts();
    let infos = bridge('charts');
    // The y values for QuantData's renderer: your range, or the line bands in its automatic range ("Keep the lines in
    // view"). Given to the bridge only when they change; then the layout is read again (the scale changed).
    let changed = false;
    for (const t of Array.isArray(infos) ? infos : []) {
      if (!t.ok || !(t.pMax > t.pMin)) continue;
      const c = document.querySelector(`canvas[data-qdts-chart="${t.k}"]`);
      const tool = c && toolOf(c);
      const tk = tool && tickerOf(tool);
      if (!tk || !/stock price/i.test(headTitle(tool)) || ocOfTool(tool)) continue;
      const range = plRange.get(tool) || null;
      // Only the strike itself (not the edge of its band): QuantData rounds its range out to the next tick, so a band
      // edge just outside widened the chart by a whole tick (2026-10-15).
      const T = cfg.trade && cfg.trade.tk === tk ? cfg.trade : null;
      const marks = plCfg().fit ? [...plLinesAt(tk, tool).map((x) => x.p), ...(T ? [T.entry, T.tp, T.sl].filter((v) => v != null) : [])] : [];
      const sig = JSON.stringify([range, marks]);
      if (plApplied.get(c) === sig) continue;
      const res = bridge('priceY', { k: t.k, range, marks });
      if (res && res.ok) {
        plApplied.set(c, sig);
        changed = true;
      }
    }
    if (changed) infos = bridge('charts');
    const shown = new Set();
    plInfos = [];
    const dpr = devicePixelRatio || 1;
    const colors = sdColorsNow();
    for (const t of Array.isArray(infos) ? infos : []) {
      if (!t.ok || !(t.pMax > t.pMin)) continue;
      const c = document.querySelector(`canvas[data-qdts-chart="${t.k}"]`);
      if (!c || !isChart(c)) continue;
      const tool = toolOf(c);
      const tk = tickerOf(tool);
      // Only Stock Price / Time: Net Drift also has a left scale, but of the premium.
      if (!tool || !tk || !/stock price/i.test(headTitle(tool))) continue;
      const lines = plLinesAt(tk, tool);
      // The own chart draws its levels and the trade itself (the pills stay).
      const own = !!ocOfTool(tool);
      plInfos.push({ c, tool, tk, info: t, own });
      plPill(tool, lines.length);
      if (own) {
        tradePill(tool, tk);
        const old = plCanvasOf.get(c);
        if (old) {
          old._trade = null;
          tradeTags(old, null);
        }
        continue;
      }
      const prev = plPrev && plPrev.c === c ? plPrev : null;
      const tv = tradeView(t, tk);
      tradePill(tool, tk);
      if (!lines.length && !prev && !tv) {
        const old = plCanvasOf.get(c);
        if (old) {
          old._trade = null;
          tradeTags(old, null);
        }
        continue;
      }
      const b = c.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      const sc = scaleOf(c, b);
      const [tl, tr, tt, tb] = t.plot;
      const w = tr - tl;
      const h = tb - tt;
      if (w < 2 || h < 2) continue;
      const cv = plCanvas(c);
      shown.add(cv);
      const u = dpr * sc;
      const W = Math.round(w * u);
      const H = Math.round(h * u);
      const pos = `${c.offsetLeft + tl}|${c.offsetTop + tt}|${w}|${h}`;
      if (cv._pos !== pos || cv.style.display !== 'block') {
        cv._pos = pos;
        Object.assign(cv.style, { left: `${c.offsetLeft + tl}px`, top: `${c.offsetTop + tt}px`, width: `${w}px`, height: `${h}px`, display: 'block' });
      }
      const sig = JSON.stringify([t.pMin, t.pMax, t.xMin, t.xMax, W, H, lines, colors, prev && [prev.p, prev.del], tv, tradeOpt()]);
      if (cv._sig === sig && cv.width === W && cv.height === H) continue;
      cv._sig = sig;
      if (cv.width !== W) cv.width = W;
      if (cv.height !== H) cv.height = H;
      const g = cv.getContext('2d');
      g.clearRect(0, 0, W, H);
      const Y = (cents) => ((t.pMax - cents) / (t.pMax - t.pMin)) * H;
      const drawn = [];
      for (const ln of lines) {
        // A band of ln.w points around the strike, at least 1 CSS px high.
        const y1 = Y(ln.p + (ln.w * 100) / 2);
        const y2 = Y(ln.p - (ln.w * 100) / 2);
        if (y2 < 0 || y1 > H) continue;
        let top = Math.round(y1);
        let hh = Math.round(y2) - top;
        if (hh < u) {
          hh = Math.max(1, Math.round(u));
          top = Math.round((y1 + y2) / 2 - hh / 2);
        }
        g.save();
        g.globalAlpha = 0.55;
        g.fillStyle = colors.primary;
        g.fillRect(0, top, W, hh);
        g.restore();
        sdLabel(g, usd(ln.p / 100).replace(/\.00$/, ''), 4 * u, Math.min(H - u, Math.max(19 * u, top + hh / 2 + 9 * u)), u, colors, true);
        drawn.push({ p: ln.p, w: ln.w, top: b.top + (tt * sc) + top / dpr, h: hh / dpr });
      }
      if (prev) {
        const y = Math.round(Y(prev.p)) + 0.5;
        g.save();
        g.strokeStyle = colors.primary;
        g.lineWidth = Math.max(1, Math.round(u));
        g.setLineDash([4 * u, 4 * u]);
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(W, y);
        g.stroke();
        g.restore();
        sdLabel(g, `${prev.del ? '× ' : ''}${usd(prev.p / 100).replace(/\.00$/, '')}`, 4 * u, Math.min(H - u, Math.max(19 * u, y + 9 * u)), u, colors, true);
      }
      cv._trade = tv ? drawTrade(g, tv, t, W, H, Y, u) : null;
      cv.dataset.trade = cv._trade ? JSON.stringify(cv._trade) : '';
      tradeTags(cv, cv._trade);
      cv.dataset.lines = JSON.stringify(drawn);
      cv.dataset.prev = prev ? JSON.stringify({ p: prev.p, del: prev.del }) : '';
    }
    for (const cv of plShown) {
      if (shown.has(cv)) continue;
      tradeTags(cv, null);
      cv._trade = null;
      if (!cv._chart || !cv._chart.isConnected) cv.remove();
      else {
        cv.style.display = 'none';
        cv.dataset.lines = '[]';
      }
    }
    plShown.clear();
    for (const cv of shown) plShown.add(cv);
    tradePanel();
  }
  // Redraw in each frame for a short time (the price scale changes after a zoom sync or your input on the chart).
  function plSoon(ms) {
    if (!plShown.size) return;
    plFollowUntil = Math.max(plFollowUntil, performance.now() + ms);
    if (!plRaf) plRaf = requestAnimationFrame(plFrame);
  }
  let plRaf = 0;
  function plFrame() {
    plRaf = 0;
    drawPriceLines();
    if (performance.now() < plFollowUntil) plRaf = requestAnimationFrame(plFrame);
  }
  for (const t of ['wheel', 'pointerdown', 'pointerup', 'pointermove']) {
    window.addEventListener(t, (e) => {
      if (!e.isTrusted || (t === 'pointermove' && !e.buttons)) return;
      if (plInfos.some((x) => x.tool.contains(e.target))) plSoon(500);
    }, { capture: true, passive: true });
  }
  // The mouse on the price axis of a price chart (left of the plot): the chart, the strike under it (snapped to the
  // strike step) and a line near it (within its band, or 4 px), or null.
  function plHit(e) {
    const t = e.target instanceof Element ? e.target : null;
    const hit = t && plInfos.find((x) => !x.own && x.tool.contains(t));
    if (!hit || !hit.c.isConnected) return null;
    const b = hit.c.getBoundingClientRect();
    const sc = scaleOf(hit.c, b);
    const lx = (e.clientX - b.left) / sc;
    const ly = (e.clientY - b.top) / sc;
    const [pl, , pt, pb] = hit.info.plot;
    if (lx < 0 || lx >= pl || ly < pt || ly > pb) return null;
    const price = hit.info.pMax - ((ly - pt) / (pb - pt)) * (hit.info.pMax - hit.info.pMin); // cents
    const perPx = (hit.info.pMax - hit.info.pMin) / (pb - pt);
    const step = plCfg().step * 100;
    const snapped = Math.round(price / step) * step;
    // A click that snaps to a line, or one near it, removes it.
    const near = plLinesAt(hit.tk, hit.tool).find((x) => x.p === snapped) || plLinesAt(hit.tk, hit.tool).find((x) => Math.abs(x.p - price) <= Math.max((x.w * 100) / 2, 4 * perPx));
    return { ...hit, p: near ? near.p : snapped, near };
  }
  // Drag on the price axis: move the y range (the price under the mouse follows it); the wheel there: zoom around it;
  // a double click: QuantData's automatic range again. QuantData does not get these events (its own drag pans the time).
  let plDrag = null; // { tool, c, y0, r0, perPx, moved }
  // The tick step of a range with 5 ticks, like the usual nice-ticks rule (1, 2, 5 x 10^n).
  function niceStep(range) {
    const raw = range / 5;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const r = raw / mag;
    return (r >= 7.07 ? 10 : r >= 3.16 ? 5 : r >= 1.41 ? 2 : 1) * mag;
  }
  let plNoClick = 0;
  let plUndo = null; // { tk, lines, at }: the lines before a click, for a double click
  let plRangeRaf = 0;
  function setPlRange(tool, range) {
    if (range) plRange.set(tool, range);
    else plRange.delete(tool);
    if (!plRangeRaf) plRangeRaf = requestAnimationFrame(() => { plRangeRaf = 0; plScanAt = -Infinity; drawPriceLines(); });
  }
  const plNow = (h) => {
    const r = plRange.get(h.tool);
    return r || [h.info.pMin, h.info.pMax];
  };
  window.addEventListener('pointerdown', (e) => {
    if (!e.isTrusted || e.button !== 0 || !plInfos.length) return;
    const h = plHit(e);
    if (!h) return;
    e.preventDefault();
    e.stopPropagation();
    const [, , pt, pb] = h.info.plot;
    const b = h.c.getBoundingClientRect();
    const r0 = plNow(h);
    plDrag = { tool: h.tool, c: h.c, y0: e.clientY, r0, perPx: (r0[1] - r0[0]) / ((pb - pt) * scaleOf(h.c, b)), moved: false };
  }, true);
  window.addEventListener('mousedown', (e) => { if (e.isTrusted && plDrag) e.stopPropagation(); }, true);
  window.addEventListener('pointermove', (e) => {
    if (!plDrag || !e.isTrusted) return;
    const dy = e.clientY - plDrag.y0;
    if (!plDrag.moved && Math.abs(dy) < 3) return;
    plDrag.moved = true;
    e.stopPropagation();
    // QuantData's renderer rounds a range out to its ticks (5 ticks: 10 points at about 50 points). A move by whole
    // ticks keeps the range as it is; another move made it wider first (2026-10-15: "alles resized sich").
    const step = niceStep(plDrag.r0[1] - plDrag.r0[0]);
    const shift = Math.round((dy * plDrag.perPx) / step) * step; // down: higher prices come into view
    setPlRange(plDrag.tool, [plDrag.r0[0] + shift, plDrag.r0[1] + shift]);
  }, true);
  window.addEventListener('pointerup', (e) => {
    if (!plDrag) return;
    if (plDrag.moved) plNoClick = performance.now() + 300;
    plDrag = null;
    if (e.isTrusted) e.stopPropagation();
  }, true);
  window.addEventListener('wheel', (e) => {
    if (!e.isTrusted || !plInfos.length) return;
    const h = plHit(e);
    if (!h) return;
    e.preventDefault();
    e.stopPropagation();
    const [lo, hi] = plNow(h);
    const [, , pt, pb] = h.info.plot;
    const b = h.c.getBoundingClientRect();
    const ly = (e.clientY - b.top) / scaleOf(h.c, b);
    const P = hi - ((ly - pt) / (pb - pt)) * (hi - lo); // the price under the mouse stays
    const f = Math.exp(Math.max(-200, Math.min(200, e.deltaY)) * 0.002);
    if ((hi - lo) * f < 100 && f < 1) return; // not below 1 point
    setPlRange(h.tool, [P - (P - lo) * f, P + (hi - P) * f]);
  }, { capture: true, passive: false });
  window.addEventListener('dblclick', (e) => {
    if (!e.isTrusted || !plInfos.length) return;
    const h = plHit(e);
    if (!h) return;
    e.preventDefault();
    e.stopPropagation();
    // The 2 clicks of the double click changed the lines: back to the lines before them.
    if (plUndo && plUndo.tk === h.tk && performance.now() - plUndo.at < 800) setPlLines(h.tk, plUndo.lines);
    plUndo = null;
    setPlRange(h.tool, null);
  }, true);
  // A click on the price axis: add a line at the strike of the preview, or remove the line there.
  function plAxisClick(e) {
    if (performance.now() < plNoClick) return !!plHit(e); // the end of a drag: no line
    const h = plHit(e);
    if (!h) return false;
    if (e.detail >= 2) return true; // the 2nd click of a double click
    plUndo = { tk: h.tk, lines: plLines(h.tk), at: performance.now() };
    const lines = plLines(h.tk);
    const day = toolDay(h.tool);
    if (h.near) setPlLines(h.tk, lines.filter((x) => x !== h.near));
    else setPlLines(h.tk, [...lines.filter((x) => !(x.p === h.p && plDayOk(x, day))), { t: 'hline', p: h.p, w: plCfg().w, day }]);
    // The preview at once ("× 7,730" after a remove stayed until the mouse moved; 2026-10-15).
    const n = plHit(e);
    plPrev = n ? { c: n.c, p: n.p, del: !!n.near } : null;
    plScanAt = -Infinity;
    drawPriceLines();
    return true;
  }
  // The preview while the mouse is on the price axis: a dashed line at the strike that a click adds (snapped like the
  // lines), with its label; "×" when a click removes a line. QuantData's own crosshair stays as it is.
  let plPrev = null; // { c, p, del }
  let plPrevRaf = 0;
  window.addEventListener('pointermove', (e) => {
    if (!e.isTrusted || !plInfos.length) return;
    const h = plDrag && plDrag.moved ? null : plHit(e);
    const next = h ? { c: h.c, p: h.p, del: !!h.near } : null;
    if (JSON.stringify(next && [next.p, next.del]) === JSON.stringify(plPrev && [plPrev.p, plPrev.del]) && (next && next.c) === (plPrev && plPrev.c)) return;
    plPrev = next;
    if (!plPrevRaf) plPrevRaf = requestAnimationFrame(() => { plPrevRaf = 0; drawPriceLines(); });
  }, { capture: true, passive: true });
  // Clicks: the trash pill removes the drawings of its chart (the 1st click asks, the 2nd within 3 s removes); the price
  // axis adds or removes a line (the page does not get these clicks).
  window.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const t = e.target instanceof Element ? e.target : null;
    const pill = t && t.closest('[data-qdts-plpill]');
    if (pill) {
      e.preventDefault();
      e.stopPropagation();
      const tool = toolOf(pill);
      const tk = tickerOf(tool);
      const n = plLinesAt(tk, tool).length;
      if (!n) return;
      if (pill._armed && performance.now() < pill._armed) {
        pill._armed = 0;
        const day = toolDay(tool);
        setPlLines(tk, plLines(tk).filter((x) => !plDayOk(x, day))); // the drawings shown on this chart
      } else {
        pill._armed = performance.now() + 3000;
        setTimeout(() => plPill(tool, plLinesAt(tk, tool).length), 3050);
      }
      plPill(tool, plLinesAt(tk, tool).length);
      return;
    }
    if (plAxisClick(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  // ---------------------------------------------------------------------------
  // Backtest trade (1.1): one position or order on the Stock Price / Time chart of a ticker, like TradingView
  // (2026-10-15; for ES traders). The pill "Trade" shows a floating panel over the chart: SELL / BUY at the
  // close of the replay minute (the right end of the visible range), the contracts, ES or MES. A right click on the
  // chart places an order at the price under the mouse: below the price a limit, above it a stop order (a sell: the
  // other way). The position or order has a tag on its line: drag the [TP] or [SL] chip out of it to set a take profit
  // or a stop loss; drag a tag to move its line; × closes, cancels or removes. No TP / SL by default. With each step
  // the trade is computed again from the candles after the entry (so also backwards): an order fills at the first
  // candle that reaches its price; the first candle that reaches the stop loss or the take profit closes the position
  // (both in 1 candle, or in the fill candle: the stop loss). PnL in points (SPX points as ES points) and $ (ES $50,
  // MES $5 per point, x contracts). Stored: cfg.trade, cfg.tradeOpt, cfg.tradeOn (the option in the list).
  // ---------------------------------------------------------------------------
  // The future of the index (2026-10-28: NDX with NQ / MNQ): [full, micro] per ticker, $ per point; others: ES.
  const TRADE_MULT = { ES: 50, MES: 5, NQ: 20, MNQ: 2, RTY: 50, M2K: 5 };
  const TRADE_FUT = { SPX: ['ES', 'MES'], NDX: ['NQ', 'MNQ'], RUT: ['RTY', 'M2K'] };
  const futOf = (tk) => TRADE_FUT[String(tk || '').toUpperCase()] || TRADE_FUT.SPX;
  // The contracts with 1 click (2026-10-21: no typing or scrolling in the field): − / + and these.
  const TRADE_QTYS = [1, 2, 3, 5, 10];
  // inst: the future of the ticker (tk; else the one of the trade); stored is only full or micro (an M first: micro).
  const tradeOpt = (tk) => {
    const o = { inst: 'ES', qty: 1, ...(cfg.tradeOpt || {}) };
    const micro = /^M/.test(o.inst);
    return { ...o, micro, inst: futOf(tk ?? (cfg.trade && cfg.trade.tk))[micro ? 1 : 0] };
  };
  const dayOfMs = (ms) => etDay.format(new Date(ms));
  const pts = (cents) => `${cents >= 0 ? '+' : '−'}${(Math.abs(cents) / 100).toFixed(2)} pt`;
  const usdPnl = (cents) => {
    const o = tradeOpt();
    const v = (cents / 100) * (TRADE_MULT[o.inst] || 50) * Math.max(1, o.qty);
    return `${v >= 0 ? '+' : '−'}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };
  const px2 = (cents) => usd(cents / 100);
  const tick25 = (cents) => Math.round(cents / 25) * 25; // ES ticks: 0.25 point
  function setTrade(t) {
    cfg.trade = t;
    saveCfg();
    plScanAt = -Infinity;
    drawPriceLines();
    cwSoon();
  }
  // TP and SL with their times (2026-10-21: "den Stop-Loss in den Profit ziehen"): a change at the replay minute
  // counts for the candles after that minute (a stop loss moved into the profit is not hit by an older candle), and a
  // step back before the change shows the TP and SL of then again. T.legs: [{ t, tp, sl }] (t: the replay minute, ms).
  const legsOf = (T) => (Array.isArray(T.legs) && T.legs.length ? T.legs : [{ t: T.et, tp: T.tp ?? null, sl: T.sl ?? null }]);
  function legAt(T, t, strict) {
    const legs = legsOf(T);
    let L = legs[0];
    for (const x of legs) if (strict ? x.t < t : x.t <= t) L = x;
    return L;
  }
  // next: the trade with its new TP / SL (and entry); the change gets the replay minute of now (later changes go).
  function withLegs(T, next) {
    const res = replayAt(T.tk);
    const now = Math.max(res ? res.t : T.et, T.et);
    const legs = legsOf(T).filter((x) => x.t <= now);
    if (!legs.length) legs.push({ t: T.et, tp: null, sl: null });
    const leg = { t: now, tp: next.tp ?? null, sl: next.sl ?? null };
    if (legs[legs.length - 1].t === now) legs[legs.length - 1] = leg;
    else legs.push(leg);
    return { ...next, legs };
  }
  // The trade with the TP and SL shown at the replay minute of now (the base of a change).
  function shownLegs(T) {
    const res = replayAt(T.tk);
    const L = legAt(T, res ? res.t : T.et, false);
    return { ...T, tp: L.tp, sl: L.sl };
  }
  // TP and SL on their side: of the replay price for an open position (so a stop loss can go into the profit), of the
  // entry for an order.
  function legsOk(next) {
    const geo = currentGeo(next.tk);
    const res = geo && geo.status === 'open' ? replayAt(next.tk) : null;
    const ref = res ? res.c : next.entry;
    if (next.tp != null && (next.dir > 0 ? next.tp <= ref : next.tp >= ref)) return false;
    if (next.sl != null && (next.dir > 0 ? next.sl >= ref : next.sl <= ref)) return false;
    return true;
  }
  // The state of the trade at the replay minute, from its definition and the candles (res: bridge tradeRows).
  function evalTrade(T, res) {
    if (res.t < T.et) return { status: 'before' };
    const order = T.kind === 'limit' || T.kind === 'stop';
    let status = order ? 'pending' : 'open';
    let fillT = order ? null : T.et;
    let exit = null;
    let exitT = null;
    let why = null;
    const fills = (h, l) => (T.kind === 'limit' ? (T.dir > 0 ? l <= T.entry : h >= T.entry) : (T.dir > 0 ? h >= T.entry : l <= T.entry));
    for (const [t, h, l] of res.rows) {
      if (t <= T.et) continue; // the entry (or the order) is at the close of its minute
      if (T.closeT && t > T.closeT) break;
      const L = legAt(T, t, true); // the TP and SL of the minute before this candle
      const hitSl = L.sl != null && (T.dir > 0 ? l <= L.sl : h >= L.sl);
      const hitTp = L.tp != null && (T.dir > 0 ? h >= L.tp : l <= L.tp);
      if (status === 'pending') {
        if (fills(h, l)) {
          status = 'open';
          fillT = t;
          if (hitSl) [status, exit, exitT, why] = ['closed', L.sl, t, 'SL']; // in the fill candle: only the stop counts
        }
        continue;
      }
      if (status !== 'open') break;
      if (hitSl) [status, exit, exitT, why] = ['closed', L.sl, t, 'SL'];
      else if (hitTp) [status, exit, exitT, why] = ['closed', L.tp, t, 'TP'];
    }
    if (status === 'open' && T.closeT && res.t >= T.closeT) [status, exit, exitT, why] = ['closed', T.closeP, T.closeT, 'Close'];
    if (status === 'pending' && T.closeT && res.t >= T.closeT) status = 'cancelled';
    const pnl = status === 'open' ? (res.c - T.entry) * T.dir : status === 'closed' ? (exit - T.entry) * T.dir : 0;
    const now = legAt(T, res.t, false); // the TP and SL shown at the replay minute
    return { status, fillT, exit, exitT, why, cur: res.c, pnl, tp: now.tp, sl: now.sl };
  }
  // The trade on a price chart (t: bridge charts entry), or null.
  function tradeView(t, tk) {
    const T = cfg.trade;
    if (!T || T.tk !== tk) return null;
    const res = bridge('tradeRows', { k: t.k, from: T.et });
    if (!res || !res.ok || dayOfMs(res.t) !== T.day) return null;
    return { T, ...evalTrade(T, res) };
  }
  const T_GREEN = 'rgb(38, 194, 129)';
  const T_RED = 'rgb(239, 83, 80)';
  const T_BLUE = 'rgb(41, 98, 255)';
  // Lines and zones on the price line canvas; the tags are DOM elements (tradeTags).
  function drawTrade(g, v, info, W, H, Y, u) {
    const T = v.T;
    if (v.status === 'before' || v.status === 'cancelled') return null;
    const X = (ms) => (info.xMax > info.xMin ? Math.max(0, Math.min(W, ((ms - info.xMin) / (info.xMax - info.xMin)) * W)) : 0); // 1 visible minute: x 0
    const x0 = Math.round(X(v.fillT ?? T.et));
    const x1 = v.status === 'closed' ? Math.round(X(v.exitT)) : W;
    const ye = Y(T.entry);
    const yt = v.tp != null ? Y(v.tp) : null;
    const ys = v.sl != null ? Y(v.sl) : null;
    const lw = Math.max(1, Math.round(1.5 * u));
    if (v.status !== 'pending') {
      if (yt !== null) {
        g.fillStyle = 'rgba(38, 194, 129, 0.16)';
        g.fillRect(x0, Math.min(ye, yt), Math.max(1, x1 - x0), Math.abs(yt - ye));
      }
      if (ys !== null && (v.sl - T.entry) * T.dir < 0) { // a stop loss in the profit: no loss zone
        g.fillStyle = 'rgba(239, 83, 80, 0.16)';
        g.fillRect(x0, Math.min(ye, ys), Math.max(1, x1 - x0), Math.abs(ys - ye));
      }
    }
    // The lines go over the whole chart, like TradingView's order and position lines (2026-10-15); the
    // zones start at the entry.
    const xs = 0;
    const hline = (y, color, dash) => {
      g.save();
      g.strokeStyle = color;
      g.lineWidth = lw;
      if (dash) g.setLineDash([6 * u, 4 * u]);
      g.beginPath();
      g.moveTo(xs, Math.round(y) + 0.5);
      g.lineTo(W, Math.round(y) + 0.5);
      g.stroke();
      g.restore();
    };
    if (yt !== null) hline(yt, T_GREEN, v.status !== 'open');
    if (ys !== null) hline(ys, T_RED, v.status !== 'open');
    hline(ye, v.status === 'pending' ? T_BLUE : 'rgba(255, 255, 255, 0.9)', v.status !== 'open');
    return { status: v.status, why: v.why, pnl: v.pnl, entry: T.entry, tp: v.tp, sl: v.sl, exit: v.exit, kind: T.kind, dir: T.dir,
      ye: ye / u, yt: yt === null ? null : yt / u, ys: ys === null ? null : ys / u, x0: x0 / u, x1: x1 / u, H: H / u };
  }
  // The tags on the lines (DOM, over the price line canvas; the page does not get their events).
  const TAG_CSS = 'position:absolute;left:4px;display:flex;align-items:center;gap:4px;height:18px;padding:0 3px 0 6px;border-radius:3px;'
    + 'font:600 11px/14px interVariableFont, Inter, -apple-system, system-ui, sans-serif;white-space:nowrap;pointer-events:auto;cursor:ns-resize;'
    + 'box-shadow:1px 1px 2px rgba(0,0,0,.55);transform:translateY(-50%);user-select:none;';
  const CHIP_CSS = 'display:inline-flex;align-items:center;justify-content:center;height:14px;min-width:14px;padding:0 4px;border-radius:2px;'
    + 'background:rgba(0,0,0,.28);font-size:10px;cursor:pointer;';
  function tradeTags(cv, geo) {
    let box = cv.nextElementSibling && cv.nextElementSibling.classList.contains('qdts-ttags') ? cv.nextElementSibling : null;
    if (!geo) {
      if (box) box.remove();
      return;
    }
    if (!box) {
      box = document.createElement('div');
      box.className = 'qdts-ttags';
      box.style.cssText = 'position:absolute;pointer-events:none;margin:0;padding:0;';
      cv.after(box);
    }
    Object.assign(box.style, { left: cv.style.left, top: cv.style.top, width: cv.style.width, height: cv.style.height });
    const o = tradeOpt();
    const side = geo.dir > 0 ? 'LONG' : 'SHORT';
    const ord = geo.dir > 0 ? 'BUY' : 'SELL';
    const tags = [];
    const chips = (...k) => k.map((x) => `<span data-chip="${x}" style="${CHIP_CSS}">${x === 'x' ? '×' : x.toUpperCase()}</span>`).join('');
    const legChips = [geo.tp == null ? 'tp' : null, geo.sl == null ? 'sl' : null].filter(Boolean);
    if (geo.status === 'pending') {
      tags.push(['entry', geo.ye, T_BLUE, '#fff', `${ord} ${geo.kind === 'limit' ? 'LMT' : 'STP'} ${o.qty} ${o.inst} @ ${px2(geo.entry)}`, chips(...legChips, 'x')]);
    } else if (geo.status === 'closed') {
      tags.push(['entry', geo.ye, geo.pnl >= 0 ? T_GREEN : T_RED, '#0b0d10', `${side} closed (${geo.why}) ${pts(geo.pnl)} ${usdPnl(geo.pnl)}`, chips('x')]);
    } else {
      tags.push(['entry', geo.ye, 'rgba(255,255,255,.92)', '#0b0d10', `${side} ${o.qty} ${o.inst} ${pts(geo.pnl)} ${usdPnl(geo.pnl)}`, chips(...legChips, 'x')]);
    }
    if (geo.tp != null && geo.status !== 'closed') tags.push(['tp', geo.yt, T_GREEN, '#04120b', `TP ${px2(geo.tp)} ${pts((geo.tp - geo.entry) * geo.dir)} ${usdPnl((geo.tp - geo.entry) * geo.dir)}`, chips('x')]);
    if (geo.sl != null && geo.status !== 'closed') tags.push(['sl', geo.ys, T_RED, '#1a0505', `SL ${px2(geo.sl)} ${pts((geo.sl - geo.entry) * geo.dir)} ${usdPnl((geo.sl - geo.entry) * geo.dir)}`, chips('x')]);
    const want = tags.map((t) => t[0]).join('|');
    if (box._want !== want) {
      box._want = want;
      box.innerHTML = tags.map((t) => `<div data-qdts-ttag="${t[0]}" style="${TAG_CSS}"><span class="t-txt"></span></div>`).join('');
    }
    for (const [which, y, bg, fg, text, ch] of tags) {
      const el = box.querySelector(`[data-qdts-ttag="${which}"]`);
      const txt = el.querySelector('.t-txt');
      if (txt.textContent !== text) txt.textContent = text;
      if (el._chips !== ch) {
        el._chips = ch;
        for (const c of el.querySelectorAll('[data-chip]')) c.remove();
        el.insertAdjacentHTML('beforeend', ch);
      }
      const top = `${Math.max(9, Math.min(geo.H - 9, y))}px`;
      if (el.style.top !== top) Object.assign(el.style, { top, background: bg, color: fg });
      el.style.cursor = which === 'entry' && geo.status !== 'pending' ? 'default' : 'ns-resize';
    }
  }
  // The replay minute of the first price chart of the ticker: { t, c }.
  function replayAt(tk) {
    // The own chart: its candles up to the replay minute (its zoom bar shows the visible candles, not the replay minute).
    const S = ocOfTk(tk);
    if (S) return ocRes(S, null);
    const info = plInfos.find((x) => x.tk === tk);
    const res = info && bridge('tradeRows', { k: info.info.k, from: null });
    return res && res.ok ? res : null;
  }
  // BUY / SELL in the panel: a position at the replay price. An open position the other way is closed first.
  function marketOrder(tk, dir) {
    const res = replayAt(tk);
    if (!res) return;
    const T = cfg.trade;
    const geo = currentGeo(tk);
    if (T && T.tk === tk && geo && geo.status === 'open') {
      if (T.dir !== dir) closeTrade();
      return; // one position: the same side again does nothing
    }
    setTrade({ tk, dir, kind: 'market', entry: tick25(res.c), tp: null, sl: null, et: res.t, day: dayOfMs(res.t) });
  }
  // An order at a price (right click): below the replay price a buy limit / sell stop, above a buy stop / sell limit.
  function placeOrder(tk, dir, price) {
    const res = replayAt(tk);
    if (!res) return;
    const p = tick25(price);
    const kind = (dir > 0) === (p <= res.c) ? 'limit' : 'stop';
    setTrade({ tk, dir, kind, entry: p, tp: null, sl: null, et: res.t, day: dayOfMs(res.t) });
  }
  function closeTrade() {
    const T = cfg.trade;
    const res = T && replayAt(T.tk);
    if (!res) return;
    setTrade({ ...T, closeT: res.t, closeP: res.c });
  }
  function currentGeo(tk) {
    const S = ocOfTk(tk);
    if (S) return S.geo && S.geo.trade;
    for (const x of plInfos) {
      if (x.tk !== tk) continue;
      const cv = plCanvasOf.get(x.c);
      if (cv && cv._trade) return cv._trade;
    }
    return null;
  }
  // Drag a tag, a line, or a [TP] / [SL] chip (a new leg): the price under the mouse, in ES ticks; TP and SL stay on
  // their side of the entry; a moved order takes its TP and SL with it.
  let tDrag = null; // { which, cv, info }
  let tRaf = 0;
  function tradeLineAt(e) {
    const T = cfg.trade;
    if (!T) return null;
    for (const x of plInfos) {
      if (x.tk !== T.tk || !x.tool.contains(e.target instanceof Element ? e.target : null)) continue;
      const cv = plCanvasOf.get(x.c);
      const tv = cv && cv._trade;
      if (!tv || tv.status === 'closed') continue;
      const b = cv.getBoundingClientRect();
      if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom) continue;
      const k = b.height / (parseFloat(cv.style.height) || b.height); // page px per CSS px of the chart (a scaled plane)
      const d = (y) => (y == null ? Infinity : Math.abs(e.clientY - b.top - y * k));
      const cand = [['tp', tv.yt], ['sl', tv.ys]];
      if (tv.status === 'pending') cand.push(['entry', tv.ye]);
      cand.sort((a, c) => d(a[1]) - d(c[1]));
      if (d(cand[0][1]) <= 6) return { which: cand[0][0], cv, info: x.info };
    }
    return null;
  }
  function tagAt(e) {
    const tag = e.target instanceof Element ? e.target.closest('[data-qdts-ttag]') : null;
    if (!tag) return null;
    const cv = tag.parentElement && tag.parentElement.previousElementSibling;
    const x = cv && plInfos.find((i) => plCanvasOf.get(i.c) === cv);
    return x ? { tag, which: tag.dataset.qdtsTtag, chip: e.target.closest('[data-chip]'), cv, info: x.info } : null;
  }
  window.addEventListener('pointerdown', (e) => {
    if (!e.isTrusted || e.button !== 0 || !cfg.trade) return;
    const t = tagAt(e);
    if (t) {
      e.preventDefault();
      e.stopPropagation();
      const chip = t.chip && t.chip.dataset.chip;
      if (chip === 'x') return; // the click handler
      if (chip === 'tp' || chip === 'sl') tDrag = { which: chip, cv: t.cv, info: t.info, create: true };
      else if (t.which !== 'entry' || (t.cv._trade && t.cv._trade.status === 'pending')) tDrag = { which: t.which, cv: t.cv, info: t.info };
      return;
    }
    const hit = tradeLineAt(e);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    tDrag = hit;
  }, true);
  window.addEventListener('mousedown', (e) => {
    if (e.isTrusted && (tDrag || (e.target instanceof Element && e.target.closest('[data-qdts-ttag]')))) e.stopPropagation();
  }, true);
  window.addEventListener('pointermove', (e) => {
    if (!e.isTrusted || !tDrag) return;
    e.stopPropagation();
    const b = tDrag.cv.getBoundingClientRect(); // the canvas covers the plot area
    const frac = (e.clientY - b.top) / b.height;
    const price = tick25(tDrag.info.pMax - frac * (tDrag.info.pMax - tDrag.info.pMin));
    const T = shownLegs(cfg.trade);
    let next = { ...T, [tDrag.which]: price };
    if (tDrag.which === 'entry') {
      const d = price - T.entry;
      next = { ...next, tp: T.tp == null ? null : T.tp + d, sl: T.sl == null ? null : T.sl + d };
      const res = replayAt(T.tk);
      if (res) next.kind = (T.dir > 0) === (price <= res.c) ? 'limit' : 'stop';
    }
    if (!legsOk(next)) return; // a take profit or a stop loss on the wrong side
    cfg.trade = withLegs(cfg.trade, next);
    if (!tRaf) tRaf = requestAnimationFrame(() => { tRaf = 0; plScanAt = -Infinity; drawPriceLines(); });
  }, true);
  window.addEventListener('pointerup', (e) => {
    if (!tDrag) return;
    tDrag = null;
    saveCfg();
    if (e.isTrusted) e.stopPropagation();
  }, true);
  // The cursor over a line that can be dragged.
  window.addEventListener('pointermove', (e) => {
    if (!e.isTrusted || tDrag || !cfg.trade) return;
    const hit = tradeLineAt(e);
    const t = e.target instanceof HTMLElement ? e.target : null;
    if (t && !t.closest('[data-qdts-ttag]') && (hit || t.style.cursor === 'ns-resize')) t.style.cursor = hit ? 'ns-resize' : '';
  }, { capture: true, passive: true });
  // × on a tag: a position closes at the replay price, an order is cancelled, a closed trade goes; TP / SL: removed.
  window.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const t = tagAt(e);
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    if (!t.chip || t.chip.dataset.chip !== 'x') return;
    const T = cfg.trade;
    const geo = t.cv._trade;
    if (t.which === 'tp' || t.which === 'sl') setTrade(withLegs(T, { ...shownLegs(T), [t.which]: null }));
    else if (geo && geo.status === 'open') closeTrade();
    else setTrade(null);
  }, true);
  // Right click on the price chart (the panel is open): Buy / Sell at the price under the mouse.
  let tctx = null;
  function closeTradeCtx() {
    if (tctx) tctx.remove();
    tctx = null;
  }
  window.addEventListener('contextmenu', (e) => {
    const ttk = tradeTk();
    if (!e.isTrusted || !ttk) return;
    const x = plInfos.find((i) => !i.own && i.tk === ttk && i.tool.contains(e.target instanceof Element ? e.target : null));
    if (!x) return;
    const b = x.c.getBoundingClientRect();
    const sc = scaleOf(x.c, b);
    const lx = (e.clientX - b.left) / sc;
    const ly = (e.clientY - b.top) / sc;
    const [pl, pr, pt, pb] = x.info.plot;
    if (lx < pl || lx > pr || ly < pt || ly > pb) return;
    e.preventDefault();
    e.stopPropagation();
    const price = tick25(x.info.pMax - ((ly - pt) / (pb - pt)) * (x.info.pMax - x.info.pMin));
    const res = replayAt(x.tk);
    if (!res) return;
    const o = tradeOpt(x.tk);
    const kind = (d) => ((d > 0) === (price <= res.c) ? 'limit' : 'stop');
    closeTradeCtx();
    tctx = document.createElement('div');
    tctx.className = 'list gmenu tctx';
    tctx.innerHTML = [1, -1].map((d) => `<div class="row" data-d="${d}"><span class="name ${d > 0 ? 't-buy' : 't-sell'}">${d > 0 ? 'Buy' : 'Sell'} ${o.qty} ${o.inst} @ ${px2(price)} ${kind(d)}</span></div>`).join('');
    tctx.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const row = ev.target.closest('[data-d]');
      if (row) placeOrder(x.tk, Number(row.dataset.d), price);
      closeTradeCtx();
    });
    panel.append(tctx);
    fixAt(tctx, Math.min(innerWidth - tctx.offsetWidth - 8, e.clientX), Math.min(innerHeight - tctx.offsetHeight - 8, e.clientY));
  }, true);
  window.addEventListener('click', (e) => { if (tctx && e.isTrusted && !e.composedPath().includes(tctx)) closeTradeCtx(); }, true);
  window.addEventListener('keydown', (e) => { if (tctx && e.key === 'Escape') closeTradeCtx(); }, true);
  // The pill "Trade": shows or hides the floating panel of the ticker.
  // The trade is an option in the list now (2026-10-22: "Trade-Button in die Einstellungen"), not a pill.
  function tradePill(tool) {
    for (const p of tool.querySelectorAll('[data-qdts-tpill]')) p.remove();
  }
  // The ticker of the trade: of its position or order, else of the first price chart (QuantData's own chart: the
  // floating panel).
  const tradeTk = () => (cfg.tradeOn ? (cfg.trade && cfg.trade.tk) || (plInfos[0] && plInfos[0].tk) || null : null);
  // The floating panel (TradingView's buy / sell panel): drag it at its top row.
  let tpanel = null;
  function tradePanel() {
    const tk = tradeTk();
    // The own price chart has its trade buttons in the chart: no floating panel.
    if (tk && ocOfTk(tk)) {
      if (tpanel) tpanel.remove();
      tpanel = null;
      return;
    }
    const res = tk && plInfos.some((x) => x.tk === tk) ? replayAt(tk) : null;
    if (!tk || !res) {
      if (tpanel) tpanel.remove();
      tpanel = null;
      return;
    }
    if (!tpanel || !tpanel.isConnected) {
      tpanel = document.createElement('div');
      tpanel.className = 'tpanel';
      tpanel.innerHTML = `<div class="tp-head"><span class="tp-grip">⋮⋮</span><span class="tp-tk"></span><span class="tp-x" title="Hide">×</span></div>
        <div class="tp-row"><button class="tp-sell" data-d="-1"><b>SELL</b><span class="tp-p"></span></button>
          <span class="tp-qbox"><button class="tp-step" data-q="-1" title="1 contract less">−</button><input type="text" inputmode="numeric" class="tp-qty" title="Contracts"><button class="tp-step" data-q="1" title="1 contract more">+</button></span>
          <button class="tp-buy" data-d="1"><b>BUY</b><span class="tp-p"></span></button></div>
        <div class="tp-row tp-qs">${TRADE_QTYS.map((n) => `<button data-qs="${n}" title="${n} contract${n > 1 ? 's' : ''}">${n}</button>`).join('')}</div>
        <div class="tp-row tp-inst"><button data-i="ES"></button><button data-i="MES"></button></div>
        <div class="tp-pos"><span class="tp-st"></span><button class="tp-close"></button></div>`;
      tpanel.addEventListener('click', (e) => {
        e.stopPropagation();
        const b = e.target.closest('button, .tp-x');
        if (!b) return;
        if (b.classList.contains('tp-x')) cfg.tradeOn = false;
        else if (b.dataset.d) marketOrder(tradeTk(), Number(b.dataset.d));
        else if (b.dataset.i) cfg.tradeOpt = { ...tradeOpt(), inst: b.dataset.i };
        else if (b.dataset.q) cfg.tradeOpt = { ...tradeOpt(), qty: Math.max(1, Math.min(500, tradeOpt().qty + Number(b.dataset.q))) };
        else if (b.dataset.qs) cfg.tradeOpt = { ...tradeOpt(), qty: Number(b.dataset.qs) };
        else if (b.classList.contains('tp-close')) {
          const geo = currentGeo(tradeTk());
          if (geo && geo.status === 'open') closeTrade();
          else setTrade(null);
        }
        saveCfg();
        plScanAt = -Infinity;
        drawPriceLines();
      });
      tpanel.addEventListener('change', (e) => {
        if (!e.target.classList.contains('tp-qty')) return;
        const v = Math.round(Number(e.target.value));
        if (v > 0) cfg.tradeOpt = { ...tradeOpt(), qty: Math.min(500, v) };
        saveCfg();
        plScanAt = -Infinity;
        drawPriceLines();
      });
      tpanel.querySelector('.tp-head').addEventListener('pointerdown', (e) => {
        if (e.target.classList.contains('tp-x')) return;
        e.preventDefault();
        const r = tpanel.getBoundingClientRect();
        const dx = e.clientX - r.left;
        const dy = e.clientY - r.top;
        const move = (ev) => {
          cfg.tradePanel = { x: Math.round(Math.max(0, Math.min(innerWidth - 60, ev.clientX - dx))), y: Math.round(Math.max(0, Math.min(innerHeight - 30, ev.clientY - dy))) };
          fixAt(tpanel, cfg.tradePanel.x, cfg.tradePanel.y);
        };
        const up = () => {
          window.removeEventListener('pointermove', move, true);
          window.removeEventListener('pointerup', up, true);
          saveCfg();
        };
        window.addEventListener('pointermove', move, true);
        window.addEventListener('pointerup', up, true);
      });
      panel.append(tpanel);
      const pos = cfg.tradePanel || { x: 200, y: 120 };
      fixAt(tpanel, pos.x, pos.y);
    }
    const o = tradeOpt(tk);
    const geo = currentGeo(tk);
    const T = cfg.trade && cfg.trade.tk === tk ? cfg.trade : null;
    const set = (sel, v) => { const el = tpanel.querySelector(sel); if (el.textContent !== v) el.textContent = v; };
    set('.tp-tk', `${tk} · backtest · ${clock(etMinOfMs(res.t))}`);
    for (const el of tpanel.querySelectorAll('.tp-p')) if (el.textContent !== px2(tick25(res.c))) el.textContent = px2(tick25(res.c));
    const q = tpanel.querySelector('.tp-qty');
    if (q !== tpanel.getRootNode().activeElement && q.value !== String(o.qty)) q.value = String(o.qty);
    for (const b of tpanel.querySelectorAll('.tp-inst button')) {
      const k = futOf(tk)[b.dataset.i === 'MES' ? 1 : 0]; // the button keeps its size, its name follows the ticker
      const label = `${k} $${TRADE_MULT[k]}/pt`;
      if (b.textContent !== label) b.textContent = label;
      b.classList.toggle('on', k === o.inst);
    }
    for (const b of tpanel.querySelectorAll('.tp-qs button')) b.classList.toggle('on', Number(b.dataset.qs) === o.qty);
    const st = !T || !geo ? 'No position.' : geo.status === 'pending' ? `${T.dir > 0 ? 'Buy' : 'Sell'} ${T.kind} @ ${px2(T.entry)}: pending`
      : geo.status === 'closed' ? `Closed (${geo.why}): ${pts(geo.pnl)} ${usdPnl(geo.pnl)}`
        : `${T.dir > 0 ? 'Long' : 'Short'} ${o.qty} ${o.inst} @ ${px2(T.entry)}: ${pts(geo.pnl)} ${usdPnl(geo.pnl)}`;
    set('.tp-st', st);
    const cb = tpanel.querySelector('.tp-close');
    const ct = !T || !geo ? '' : geo.status === 'open' ? 'Close' : geo.status === 'pending' ? 'Cancel' : 'Clear';
    set('.tp-close', ct);
    cb.hidden = !ct;
  }
  const etMinOfMs = (ms) => {
    const p = etClock.formatToParts(new Date(ms));
    const g = (t) => Number(p.find((x) => x.type === t).value);
    return (g('hour') % 24) * 60 + g('minute');
  };

  // ---------------------------------------------------------------------------
  // Own price chart (1.1; 2026-10-17: "der Stock-Chart wird einfach ersetzt ... soll Stock aussehen, aber eben
  // nicht Stock funktionieren"). It replaces each visible Stock Price / Time chart in its place: QuantData's chart keeps
  // running hidden (it gives the data, its header, its legend and its zoom bar stay), our canvas lies over its canvas in
  // the page DOM (it follows the layout at once, and a scaled plane scales it). The ground stays QuantData's own (the
  // gradient of the tool shows through: the canvas is transparent). The axes are at the places of QuantData's axes
  // (its plot area). Only candles up to the replay minute (the minute of the time sliders); the width of a candle does
  // not depend on the number of candles: 90 bars in view at the start, the newest at the right with room after it (like
  // TradingView). The price scale is automatic on the visible candles. The mouse: drag the chart to pan it freely (
  // 2026-10-17: no snap back to the right; a move up or down also moves the prices, then the scale is your own), the wheel zooms the time (on the price axis: the prices), drag the price axis to scale
  // it, drag the time axis to zoom the time, a double click on the price axis: automatic again, on the time axis: the
  // newest candles again. A click on the price axis adds or removes a level at the nearest strike (the price lines).
  // The trade (cfg.trade; the pill "Trade" and its panel stay): lines, zones, tags with [TP] / [SL] chips; a right
  // click places a limit / stop order. The σ lines of the ticker (the σ section of the list). QuantData's zoom bar shows
  // the visible candles (onChange at once, onChangeEnd 400 ms after the last change); your drag on the bar moves the
  // chart. cfg.ownChart false: QuantData's own charts.
  // ---------------------------------------------------------------------------
  const OC_PAD = 5; // bars of room right of the last candle
  const OC_BARS = 90; // bars in view at the start
  const OC_FONT = '600 10px interVariableFont, Inter, -apple-system, system-ui, sans-serif';
  const ocs = new Map(); // chart key (data-qdts-chart) -> the instance
  // The grid (2026-10-18: "Gridlines einstellen mit Opacity und Art"; the Lines menu): off, horizontal (at the
  // price ticks), vertical (at the time labels) or both; solid, dashed or dotted; the opacity in %. Off by default
  // (QuantData's chart has none).
  const ocGrid = () => ({ show: 'off', style: 'solid', op: 10, ...(cfg.ocGrid || {}) });
  const ocOn = () => cfg.ownChart !== false;
  const ocOfTool = (tool) => [...ocs.values()].find((S) => S.tool === tool) || null;
  // The chart of a ticker for the trade: the one with the newest candles (a chart of the day before is older).
  function ocOfTk(tk) {
    let best = null;
    for (const S of ocs.values()) {
      if (S.tk !== tk || !S.data || !S.data.t.length) continue;
      if (!best || S.data.t[S.data.t.length - 1] > best.data.t[best.data.t.length - 1]) best = S;
    }
    return best;
  }
  const cwSoon = () => { for (const S of ocs.values()) ocSoon(S); };
  function ocSoon(S) {
    if (!S.raf) S.raf = requestAnimationFrame(() => { S.raf = 0; ocDrawSafe(S); });
  }
  function ocDrawSafe(S) {
    const t0 = performance.now();
    try {
      ocDraw(S);
      perfAdd('draw', t0);
    } catch (err) {
      if (!sdErrorShown) console.warn('[QD Toolkit] own chart', err);
      sdErrorShown = true;
    }
  }
  // Nice tick values for a range (1, 2, 2.5, 5 x 10^n), about `count` of them.
  function cwTicks(lo, hi, count) {
    const raw = (hi - lo) / Math.max(1, count);
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((x) => x >= raw) || 10 * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
    return out;
  }
  // Like QuantData's axes: "4:00 PM" in your time zone; prices "$7,580" on the axis.
  const cwLocal = localClock;
  const cwAxP = (cents) => `$${usd(cents / 100).replace(/\.00$/, '')}`;
  const cwP = (cents) => `$${usd(cents / 100)}`;
  // The index of the last candle at or before the replay minute. All candles: a live day at its end, no time slider,
  // or a chart of another day than the time sliders (a chart of the day before, for the σ lines).
  // The minute of the strike charts (2026-10-21: "um eine Minute versetzt ... nicht korreliert"): QuantData's
  // server gives the strike data of a slider minute; which candle has the same price is not known in the page. So the
  // own chart measures it: the price of the strike charts of its ticker (their price line) against the closes of the
  // candles around the replay minute. The candle with that close (within 5 cents, clearly the nearest; 3 times at
  // other minutes) gives the shift (-2 ... +2 minutes), and the chart then ends at that candle. Stored: cfg.ocShift.
  const ocShift = () => (Number.isInteger(cfg.ocShift) ? cfg.ocShift : 0);
  // The chips Candle / Line and 1 Min ... of a custom chart (2026-10-28): QuantData's 2 chips are hidden, 2 own chips in
  // their look take their place and set only the custom chart (cfg.ocLine, cfg.ocN: no save, no load). Before, the custom
  // chart took over a change of QuantData's chips and set them back: QuantData showed the old value for some seconds,
  // so the choice came back and your clicks seemed to do nothing. QuantData stays on Candle / 1 Min: else
  // ocChips sets it back with its own menus (max once in 8 s); until then the custom chart waits (S.metaN).
  const OC_AGG = { ONE_MINUTE: 1, TWO_MINUTE: 2, THREE_MINUTE: 3, FOUR_MINUTE: 4, FIVE_MINUTE: 5, TEN_MINUTE: 10, FIFTEEN_MINUTE: 15,
    TWENTY_MINUTE: 20, THIRTY_MINUTE: 30, ONE_HOUR: 60, TWO_HOUR: 120, FOUR_HOUR: 240 };
  const ocNText = (n) => (n < 60 ? `${n} Min` : `${n / 60} Hour`);
  const OC_TYPE_RE = /^(Candle|Line)$/;
  const OC_PER_RE = /^\d+ (Min|Hour)s?$/;
  // QuantData's chip (the pill around the label) in the toolbar of a tool, by its text.
  function qdChip(tool, re) {
    const leaf = [...tool.querySelectorAll('[class*="toolbar"] *')].find((e) => !e.children.length && re.test((e.textContent || '').trim()) && !e.closest('[data-qdts-chip]'));
    return leaf && leaf.parentElement;
  }
  function ocChips(S) {
    const now = performance.now();
    if (!S.tool || now - (S.chipAt || 0) < 400) return;
    S.chipAt = now;
    for (const [kind, re] of [['type', OC_TYPE_RE], ['n', OC_PER_RE]]) {
      const qd = qdChip(S.tool, re);
      if (!qd) continue;
      if (qd.dataset.qdtsQdchip !== kind) qd.dataset.qdtsQdchip = kind; // hidden by the page rule (freezeStyle)
      let own = S.chips && S.chips[kind];
      if (!own || !own.isConnected || own.previousElementSibling !== qd) {
        if (own) own.remove();
        own = qd.cloneNode(true);
        own.removeAttribute('data-qdts-qdchip');
        own.dataset.qdtsChip = kind;
        own.removeAttribute('aria-describedby');
        own.addEventListener('click', (e) => { e.stopPropagation(); ocChipMenu(S, kind, own); });
        qd.after(own);
        S.chips = { ...(S.chips || {}), [kind]: own };
      }
      const text = kind === 'type' ? (cfg.ocLine ? 'Line' : 'Candle') : ocNText(ocN());
      const leaf = [...own.querySelectorAll('*')].find((e) => !e.children.length && re.test((e.textContent || '').trim())) || own;
      if (leaf.textContent !== text) leaf.textContent = text;
    }
    if (now - (S.metaAt || 0) < 1000) return;
    S.metaAt = now;
    const m = bridge('toolMeta', { k: S.k });
    if (!m || !m.ok || !m.agg) return;
    const n = OC_AGG[m.agg] || 1;
    S.metaN = n; // the period of QuantData's data (a candle of N minutes holds future minutes)
    if ((n === 1 && m.chartType !== 'LINE') || now - (S.chipFix || 0) < 8000) return;
    S.chipFix = now;
    dlog('chips', { qdN: n, qdLine: m.chartType === 'LINE' });
    ocChipsBack(S, n !== 1, m.chartType === 'LINE');
  }
  // QuantData's toolbar buttons of a price chart with the custom chart (2026-10-28, the reports of a user): "Reset zoom"
  // (tabler-icon-zoom-reset) resets the view of the custom chart; "Reset to default" (tabler-icon-restore, red) also
  // its candles (1 minute, candles). QuantData's own action runs too (its zoom bar, its settings).
  window.addEventListener('click', (e) => {
    if (!e.isTrusted || !(e.target instanceof Element)) return;
    const btn = e.target.closest('[class*="themeIcon"]');
    const icon = btn && btn.querySelector('svg.tabler-icon-zoom-reset, svg.tabler-icon-restore');
    if (!icon) return;
    const tool = btn.closest('[class*="QDToolLayout-module__"][class*="__container"]');
    const S = tool && ocOfTool(tool);
    if (!S) return;
    S.view = { end: null, bars: OC_BARS, follow: true, auto: true };
    S.y = null;
    if (icon.classList.contains('tabler-icon-restore')) {
      cfg.ocN = 1;
      cfg.ocLine = false;
      saveCfg();
      syncChartOpts();
      S.chipAt = 0;
      ocChips(S);
    }
    cwSoon();
  }, true);
  function ocChipsRemove(S) {
    for (const el of Object.values(S.chips || {})) el.remove();
    S.chips = null;
    if (S.tool) for (const el of S.tool.querySelectorAll('[data-qdts-qdchip]')) el.removeAttribute('data-qdts-qdchip');
    ocChipMenu(null);
  }
  // The menu of an own chip: in the style of the list (QuantData's menu colors).
  let ocMenu = null;
  function ocChipMenu(S, kind, chip) {
    if (ocMenu) {
      const same = ocMenu.kind === kind && ocMenu.S === S;
      ocMenu.el.remove();
      document.removeEventListener('pointerdown', ocMenu.away, true);
      document.removeEventListener('keydown', ocMenu.esc, true);
      ocMenu = null;
      if (same || !S) return;
    }
    if (!S) return;
    const items = kind === 'type' ? [['candle', 'Candle'], ['line', 'Line']] : OC_NS.map((n) => [n, ocNText(n)]);
    const cur = kind === 'type' ? (cfg.ocLine ? 'line' : 'candle') : ocN();
    const c = sdColorsNow();
    const el = document.createElement('div');
    el.dataset.qdtsChipmenu = kind;
    el.style.cssText = `position:fixed;z-index:400;min-width:120px;padding:4px;border-radius:8px;border:1px solid ${c.primary};background:#0b1620;`
      + 'box-shadow:0 8px 24px rgba(0,0,0,.5);font:500 13px interVariableFont, Inter, -apple-system, system-ui, sans-serif;color:#e8eaef;';
    for (const [v, label] of items) {
      const it = document.createElement('div');
      it.dataset.v = String(v);
      it.textContent = label;
      const on = String(v) === String(cur);
      it.style.cssText = `padding:6px 10px;border-radius:5px;cursor:pointer;${on ? `background:${c.primary};color:#fff;` : ''}`;
      it.addEventListener('pointerenter', () => { if (!on) it.style.background = 'rgba(255,255,255,.08)'; });
      it.addEventListener('pointerleave', () => { if (!on) it.style.background = ''; });
      it.addEventListener('click', (e) => {
        e.stopPropagation();
        if (kind === 'type') cfg.ocLine = v === 'line';
        else cfg.ocN = Number(v);
        saveCfg();
        syncChartOpts();
        S.chipAt = 0;
        ocChips(S);
        cwSoon();
        ocChipMenu(null);
      });
      el.appendChild(it);
    }
    document.body.appendChild(el);
    const r = chip.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(innerWidth - el.offsetWidth - 4, r.left))}px`;
    el.style.top = `${Math.min(innerHeight - el.offsetHeight - 4, r.bottom + 4)}px`;
    const away = (e) => { if (!el.contains(e.target) && !chip.contains(e.target)) ocChipMenu(null); };
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); ocChipMenu(null); } };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc, true);
    ocMenu = { S, kind, el, away, esc };
  }
  // QuantData back to Candle / 1 Min with its own menus (a click on its hidden chip, then on the menu item).
  async function ocChipsBack(S, period, type) {
    const pick = async (re, item) => {
      const chip = S.tool && qdChip(S.tool, re);
      if (!chip) return;
      chip.click();
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const it = [...document.querySelectorAll('[role=menuitem], [role=option], [class*="menu" i] *, [class*="dropdown" i] *')]
          .find((e) => !e.children.length && (e.textContent || '').trim() === item && !S.tool.contains(e) && !e.closest('[data-qdts-chipmenu]'));
        if (it) { it.click(); return; }
      }
    };
    if (period) await pick(OC_PER_RE, '1 Minute');
    if (type) {
      await new Promise((r) => setTimeout(r, 600));
      await pick(/^Line$/, 'Candle');
    }
  }
  // Candles of N minutes and the line (2026-10-28): built from the 1-minute candles up to the replay minute. QuantData's
  // own N-minute candles hold the minutes after the replay time (the candle of 13:20-13:25 at 13:21), so the custom chart
  // always reads 1-minute candles; QuantData's chips set cfg.ocN / cfg.ocLine and go back to Candle / 1 Min (ocChips).
  const ocN = () => (OC_NS.includes(Number(cfg.ocN)) ? Number(cfg.ocN) : 1);
  function ocAgg(S, d, cut, N) {
    const sig = `${d.v}|${cut}|${N}`;
    if (S.agg && S.agg.sig === sig) return S.agg;
    const B = N * 60000;
    const D = { v: `${d.v}|${N}`, t: [], o: [], h: [], l: [], c: [], up: d.up, down: d.down };
    const a = { sig, d: D, min: [], of: [] };
    const mx = (x, y) => (Number.isFinite(x) ? (Number.isFinite(y) ? Math.max(x, y) : x) : y);
    const mn = (x, y) => (Number.isFinite(x) ? (Number.isFinite(y) ? Math.min(x, y) : x) : y);
    let k = -1;
    let key = null;
    for (let i = 0; i <= cut; i++) {
      const b = Math.floor(d.t[i] / B);
      if (b !== key) {
        key = b;
        k++;
        D.t.push(b * B); D.o.push(d.o[i]); D.h.push(d.h[i]); D.l.push(d.l[i]); D.c.push(d.c[i]);
        a.min.push(etMinOfMs(b * B));
      } else {
        D.h[k] = mx(D.h[k], d.h[i]);
        D.l[k] = mn(D.l[k], d.l[i]);
        if (Number.isFinite(d.c[i])) D.c[k] = d.c[i];
      }
      a.of[i] = k;
    }
    a.cut = k;
    S.agg = a;
    return a;
  }
  let ocMeasures = []; // { cut, o } of the last measures
  let ocAlignInfo = null; // for the list: { o, spot, t } of the last measure
  function ocCut(S) {
    const raw = ocCutRaw(S);
    const d = S.data;
    if (raw < 0 || !d || S.liveEnd) return raw;
    return Math.max(0, Math.min(d.t.length - 1, raw + ocShift()));
  }
  function ocAlign(S) {
    const d = S.data;
    const raw = ocCutRaw(S);
    if (!d || raw < 1 || S.liveEnd || raw >= d.t.length - 1) return;
    const day = dayOfMs(d.t[raw]);
    const ks = [];
    for (const z of zoomBars) {
      if (!z.strike || z.vertical || !z.tool || !z.tool.isConnected || tickerOf(z.tool) !== S.tk || sdToolLoading(z.tool)) continue;
      if (toolDay(z.tool) && toolDay(z.tool) !== day) continue;
      const c = z.tool.querySelector('canvas[data-qdts-chart]');
      if (c) ks.push(c.getAttribute('data-qdts-chart'));
    }
    if (!ks.length || performance.now() - (S.cutAt || 0) < 1500) return; // after a step: the strike charts load
    const res = bridge('spots', { ks });
    const spot = Array.isArray(res) && res.length ? res[0].spot : null;
    if (spot == null) return;
    const diffs = [];
    for (let o = -2; o <= 2; o++) if (raw + o >= 0 && raw + o < d.t.length) diffs.push([Math.abs(d.c[raw + o] - spot), o]);
    diffs.sort((a, b) => a[0] - b[0]);
    const [best, second] = diffs;
    if (!best || best[0] > 5 || (second && second[0] < 3 * best[0] + 5)) return;
    ocAlignInfo = { o: best[1], spot, t: d.t[raw + best[1]] };
    if (ocMeasures.length && ocMeasures[ocMeasures.length - 1].cut === raw) return;
    ocMeasures = [...ocMeasures, { cut: raw, o: best[1] }].slice(-3);
    if (ocMeasures.length === 3 && ocMeasures.every((m) => m.o === best[1]) && ocShift() !== best[1]) {
      cfg.ocShift = best[1];
      saveCfg();
      cwSoon();
    }
  }
  let ocLastTime = null; // { day, M }: the last replay minute that a time slider showed
  function ocCutRaw(S) {
    const d = S.data;
    if (!d || !d.t.length) return -1;
    if (S.minV !== d.v) {
      S.minV = d.v;
      S.min = d.t.map(etMinOfMs);
    }
    const ref = refSlider();
    const r = ref && readV(ref);
    const cday = dayOfMs(d.t[d.t.length - 1]);
    S.wait = false;
    let M;
    if (!r || !isTime(r) || isNaN(r.value)) {
      // No time slider (2026-10-23: a new session date without an expiration: the strike charts have no slider
      // until you pick one, and the whole day showed). Today: live, all candles. Another day: the last replay minute
      // of that day, else nothing (a text in the chart) until a slider is there.
      S.liveEnd = cday === etDay.format(new Date());
      if (S.liveEnd) return d.t.length - 1;
      if (!ocLastTime || ocLastTime.day !== cday) {
        S.wait = true;
        return -1;
      }
      M = ocLastTime.M;
    } else {
      S.liveEnd = isLive(r) && r.value >= r.max;
      if (S.liveEnd) return d.t.length - 1;
      // A chart of a day BEFORE the day of the time sliders (the day before, for the σ lines): all its candles. Not when
      // its day is another one for a moment (a new day loads: before, the whole new day showed; 2026-10-22).
      const day = toolDay(toolOf(ref));
      if (day && cday < day) return d.t.length - 1;
      if (day && dayOfMs(d.t[0]) > day) return -1;
      M = wantNow() ?? etOf(r);
      if (day) ocLastTime = { day, M };
    }
    let cut = -1;
    for (let i = 0; i < d.t.length; i++) if (S.min[i] <= M) cut = i;
    return cut;
  }
  // The candles (only when they changed) and the plot area of QuantData's chart.
  function ocFetch(S) {
    const res = bridge('chartData', { k: S.k, have: { p: S.data && S.data.v } });
    if (!res || !res.ok) return;
    if (res.p && res.p.t) {
      S.data = res.p;
      ocSoon(S);
    }
  }
  // The replay price and the candles after a time (for the trade), like bridge tradeRows.
  function ocRes(S, fromT) {
    const d = S.data;
    const cut = ocCut(S);
    if (!d || cut < 0) return null;
    const rows = [];
    if (Number.isFinite(fromT)) for (let i = 0; i <= cut; i++) if (d.t[i] >= fromT) rows.push([d.t[i], d.h[i], d.l[i], d.c[i]]);
    return { ok: true, n: d.t.length, r: cut, t: d.t[cut], c: d.c[cut], first: d.t[0], rows };
  }
  function ocMake(c, tool) {
    const k = c.getAttribute('data-qdts-chart');
    const host = document.createElement('div');
    host.dataset.qdtsOc = k;
    host.style.cssText = 'position:absolute;margin:0;padding:0;border:0;z-index:4;touch-action:none;user-select:none;';
    const sh = host.attachShadow({ mode: 'open' });
    // The trade at the top left of the chart (2026-10-21: the floating panel was too large; like TradingView's
    // buttons on the chart): SELL / − contracts + / BUY at the replay price, ES or MES. Shown while the pill "Trade" is on.
    sh.innerHTML = '<style>.tbar{position:absolute;display:none;align-items:stretch;gap:4px;height:30px;width:max-content;z-index:2;user-select:none;'
      + 'font:600 11px/13px interVariableFont,Inter,-apple-system,system-ui,sans-serif}.tbar.on{display:flex}'
      + '.tbar button{all:unset;cursor:pointer;box-sizing:border-box;border-radius:4px;text-align:center}'
      + '.tbar .sell,.tbar .buy{display:flex;flex-direction:column;justify-content:center;padding:0 8px;min-width:64px;color:#fff;font-variant-numeric:tabular-nums}'
      + '.tbar .sell b,.tbar .buy b{font-size:9.5px;letter-spacing:.05em}.tbar .sell{background:rgb(239,83,80)}.tbar .buy{background:rgb(41,98,255)}'
      + '.tbar .sell:hover,.tbar .buy:hover{filter:brightness(1.12)}'
      + '.tbar .q{display:flex;align-items:stretch;box-sizing:border-box;border-radius:4px;background:rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.18);color:#fff}'
      + '.tbar .q button{width:20px;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.8);font-size:13px}'
      + '.tbar .q button:hover{background:rgba(255,255,255,.12)}.tbar .q .n{min-width:20px;display:flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums}'
      // a border, not an inset shadow: Safari left out the right edge of the inset shadow at some widths (MNQ; 2026-10-28)
      + '.tbar .inst{flex:none;min-width:max-content;padding:0 8px;display:flex;align-items:center;background:rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.18);color:#fff}'
      + '.tbar .inst:hover{background:rgba(255,255,255,.12)}</style>'
      + '<canvas style="position:absolute;left:0;top:0;display:block;touch-action:none"></canvas>'
      + '<div class="tags" style="position:absolute;inset:0;pointer-events:none"></div>'
      + '<div class="tbar"><button class="sell" data-d="-1" title="Sell at the replay price"><b>SELL</b><span class="p"></span></button>'
      + '<span class="q" title="Contracts"><button data-q="-1" title="1 contract less">−</button><span class="n"></span><button data-q="1" title="1 contract more">+</button></span>'
      + '<button class="buy" data-d="1" title="Buy at the replay price"><b>BUY</b><span class="p"></span></button>'
      + '<button class="inst" title="The full or the micro future of the index (ES / MES, NQ / MNQ, RTY / M2K)"></button></div>';
    const S = { k, c, tool, tk: tickerOf(tool), host, cv: sh.querySelector('canvas'), tagsEl: sh.querySelector('.tags'), data: null, plot: null,
      view: { end: null, bars: OC_BARS, follow: true, auto: true }, y: null, mouse: null, geo: null, drag: null, undo: null, raf: 0,
      range: null, barFollow: null, hidden: [] };
    // QuantData does not get the events on the own chart (its handlers pan its hidden chart, show its tooltip).
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'wheel', 'contextmenu', 'touchstart', 'touchmove']) {
      host.addEventListener(t, (e) => e.stopPropagation(), { passive: t !== 'wheel' && t !== 'contextmenu' });
    }
    const cv = S.cv;
    cv.addEventListener('pointerdown', (e) => ocDown(S, e));
    cv.addEventListener('pointermove', (e) => {
      const r = cv.getBoundingClientRect();
      const sc = scaleOf(cv, r);
      S.mouse = { x: (e.clientX - r.left) / sc, y: (e.clientY - r.top) / sc };
      if (!S.drag) cv.style.cursor = ocCursor(S, S.mouse);
      ocSoon(S);
    });
    cv.addEventListener('pointerleave', () => { S.mouse = null; ocSoon(S); });
    cv.addEventListener('wheel', (e) => ocWheel(S, e), { passive: false });
    cv.addEventListener('dblclick', (e) => {
      const m = ocPt(S, e);
      const g = S.geo;
      if (!g || !m) return;
      if (m.y > g.PB && m.x >= g.PL) {
        S.view = { end: null, bars: OC_BARS, follow: true, auto: true }; // the time axis: automatic again (all loaded candles)
      } else if (m.x < g.PL) {
        S.y = null;
        // the 2 clicks of the double click toggled a level: back
        if (S.undo && performance.now() - S.undo.at < 800) setPlLines(S.undo.tk, S.undo.lines);
        S.undo = null;
      }
      ocSoon(S);
    });
    cv.addEventListener('contextmenu', (e) => ocContext(S, e));
    S.tagsEl.addEventListener('pointerdown', (e) => ocTagDown(S, e));
    S.tbar = sh.querySelector('.tbar');
    S.tbar.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.d) marketOrder(S.tk, Number(b.dataset.d));
      else if (b.dataset.q) cfg.tradeOpt = { ...tradeOpt(), qty: Math.max(1, Math.min(500, tradeOpt().qty + Number(b.dataset.q))) };
      else if (b.classList.contains('inst')) cfg.tradeOpt = { ...tradeOpt(S.tk), inst: tradeOpt(S.tk).micro ? 'ES' : 'MES' };
      saveCfg();
      cwSoon();
    });
    S.tagsEl.addEventListener('click', (e) => ocTagClick(S, e));
    return S;
  }
  // Mouse position in the CSS px of the chart canvas (a scaled plane: divided by its scale).
  function ocPt(S, e) {
    const r = S.cv.getBoundingClientRect();
    const sc = scaleOf(S.cv, r);
    return { x: (e.clientX - r.left) / sc, y: (e.clientY - r.top) / sc };
  }
  // Put the host over QuantData's canvas and hide QuantData's canvases there (the chart, its crosshair layer, our
  // price line canvas); QuantData's DOM stays as it is.
  function ocMount(S) {
    const c = S.c;
    const par = c.parentElement;
    if (!par) return;
    if (S.host.parentElement !== par) par.append(S.host);
    // Not over QuantData's zoom bar (it can lie over the lower part of the chart canvas): the bar stays yours.
    let h = c.offsetHeight;
    const z = ocBarOf(S);
    if (z) {
      const cb = c.getBoundingClientRect();
      const zb = z.root.getBoundingClientRect();
      if (zb.height && zb.top < cb.bottom && zb.bottom > cb.top) h = Math.max(40, Math.min(h, (zb.top - cb.top) / scaleOf(c, cb)));
    }
    h = Math.round(h);
    S.H = h;
    const pos = `${c.offsetLeft}|${c.offsetTop}|${c.offsetWidth}|${h}`;
    if (S.pos !== pos) {
      S.pos = pos;
      Object.assign(S.host.style, { left: `${c.offsetLeft}px`, top: `${c.offsetTop}px`, width: `${c.offsetWidth}px`, height: `${h}px` });
      ocSoon(S);
    }
    // QuantData's canvases of this tool are hidden by a page rule at once, also a new one (a new day: QuantData makes
    // new canvases, they showed the whole day until the next refresh; 2026-10-22).
    if (!freezeStyle.isConnected) (document.head || document.documentElement).appendChild(freezeStyle);
    if (S.tool && S.tool.dataset.qdtsOchide !== '1') S.tool.dataset.qdtsOchide = '1';
    for (const el of par.children) {
      if (el === S.host || el.tagName !== 'CANVAS' || el.style.visibility === 'hidden') continue;
      el.style.visibility = 'hidden';
      S.hidden.push(el);
    }
  }
  function ocRemove(S) {
    ocChipsRemove(S);
    if (S.tool) delete S.tool.dataset.qdtsOchide;
    for (const el of S.hidden) el.style.visibility = '';
    S.hidden = [];
    S.host.remove();
    if (S.raf) cancelAnimationFrame(S.raf);
    ocs.delete(S.k);
  }
  // In the refresh: the instances of the visible price charts, their data and the replay minute.
  function ocRefresh() {
    try {
      tagCharts();
      const want = new Map();
      if (ocOn()) {
        for (const c of document.querySelectorAll('canvas[data-qdts-chart]')) {
          if (c.closest('#qd-time-sync-freeze') || !c.offsetWidth || !c.offsetHeight) continue;
          const tool = toolOf(c);
          if (!tool || !shownEl(tool) || !tickerOf(tool) || !/stock price/i.test(headTitle(tool))) continue;
          want.set(c.getAttribute('data-qdts-chart'), { c, tool });
        }
      }
      for (const S of [...ocs.values()]) {
        const w = want.get(S.k);
        if (!w || w.c !== S.c) ocRemove(S);
      }
      if (!want.size) return;
      const infos = chartsNow();
      for (const [k, { c, tool }] of want) {
        let S = ocs.get(k);
        if (!S) {
          S = ocMake(c, tool);
          ocs.set(k, S);
        }
        S.tool = tool;
        S.tk = tickerOf(tool);
        const t = Array.isArray(infos) && infos.find((x) => x.k === k && x.ok);
        if (t && JSON.stringify(t.plot) !== JSON.stringify(S.plot)) {
          S.plot = t.plot;
          ocSoon(S);
        }
        ocMount(S);
        ocFetch(S);
        ocChips(S);
        if (S.metaN > 1) { ocSoon(S); continue; } // QuantData's chip on another period: not 1-minute candles yet
        const cut = ocCut(S);
        if (S.rawCut !== ocCutRaw(S)) {
          S.rawCut = ocCutRaw(S);
          S.cutAt = performance.now();
        }
        if (!S.geo || S.geo.cut1 !== cut) ocSoon(S);
        ocAlign(S);
        ocBarRead(S);
        ocBarFollowCut(S, cut);
      }
    } catch (err) {
      if (!sdErrorShown) console.warn('[QD Toolkit] own chart', err);
      sdErrorShown = true;
    }
  }
  // QuantData's zoom bar of an own chart is the range of the loaded candles (2026-10-21: zoom and scale "wie ein
  // TradingView-Chart"): only the candles from its left end to its right end are drawn, and the pan, the zoom and the price
  // scale of the chart are free (they do not move the bar). Its right end at the replay minute goes with the replay (a
  // step moves it, so the mask still covers the future in its preview); a right end before it stays where you put it.
  // The time sync does not move this bar.
  const ocOwnsBar = (z) => !!(z && !z.vertical && ocOfTool(z.tool));
  const ocBarOf = (S) => zoomBars.find((z) => z.tool === S.tool && !z.vertical && z.root.isConnected) || null;
  function ocBarRead(S) {
    if (ocBarFollow && ocBarFollow.S === S) return; // your drag: read in each frame
    const z = ocBarOf(S);
    const v = z && z.info && z.info.ok && z.info.value;
    // Just after our own set the bar data of the refresh can be older: wait until it has the new value (max 1.5 s).
    if (v && S.setV && performance.now() - S.setAt < 1500 && (v[0] !== S.setV[0] || v[1] !== S.setV[1])) return;
    if (v && (!S.range || v[0] !== S.range[0] || v[1] !== S.range[1])) {
      S.range = [v[0], v[1]];
      ocSoon(S);
    }
  }
  // The right end follows the replay while it is at the replay minute (S.barFollow; 2026-10-22: with the rule
  // "it was at the replay minute of before" it stopped after a missed step until you went back to that minute). Only
  // your drag of the bar changes S.barFollow: its right end at or after the replay minute = follow. A right end after
  // the replay minute comes back to it (no future candles).
  function ocBarFollowCut(S, cut) {
    const z = ocBarOf(S);
    if (!z || !S.range || cut < 0 || (ocBarFollow && ocBarFollow.S === S)) return;
    // The first time for this chart: all candles up to the replay minute (the bar had the visible candles of the draft
    // before; QuantData stores the zoom, so this is done once per chart).
    if (!(cfg.ocBarInit || {})[z.key]) {
      const res = bridge('setRows', { k: z.k, l: 0, r: cut, end: true });
      if (res && res.ok) {
        S.range = res.v;
        S.setV = res.v;
        S.setAt = performance.now();
        S.barFollow = true;
        cfg.ocBarInit = { ...(cfg.ocBarInit || {}), [z.key]: true };
        saveCfg();
        ocSoon(S);
      }
      return;
    }
    // Stored per bar (2026-10-22: after a reload the chart stayed at the first candle: the follow was guessed from
    // the stored zoom). Only your drag of the right handle changes it.
    S.barFollow = (cfg.ocFollow || {})[z.key] !== false;
    const [l, r] = S.range;
    if (r === cut || (!S.barFollow && r < cut)) return;
    if (performance.now() - (S.setAt || 0) < 300 && S.setV && S.setV[1] === cut) return;
    const res = bridge('setRows', { k: z.k, l: Math.min(l, cut), r: cut, end: true });
    if (res && res.ok) {
      S.range = res.v;
      S.setV = res.v;
      S.setAt = performance.now();
    }
    ocSoon(S);
  }
  // While you hold the mouse button on the zoom bar of an own chart: its range in each frame.
  let ocBarFollow = null;
  window.addEventListener('pointerdown', (e) => {
    if (!e.isTrusted || !(e.target instanceof Element)) return;
    for (const S of ocs.values()) {
      const z = ocBarOf(S);
      if (!z || !z.root.contains(e.target)) continue;
      ocBarFollow = { S, k: z.k };
      const frame = () => {
        if (!ocBarFollow) return;
        const res = bridge('barRows', { k: ocBarFollow.k });
        if (res && res.ok) {
          ocBarFollow.S.range = res.v;
          ocSoon(ocBarFollow.S);
        }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }
  }, true);
  window.addEventListener('pointerup', () => {
    if (!ocBarFollow) return;
    const { S, k } = ocBarFollow;
    ocBarFollow = null;
    setTimeout(() => {
      const res = bridge('barRows', { k });
      if (res && res.ok) S.range = res.v;
      const z = ocBarOf(S);
      if (S.range && z) {
        cfg.ocFollow = { ...(cfg.ocFollow || {}), [z.key]: S.range[1] >= ocCut(S) }; // your right end: at the replay minute = follow
        saveCfg();
      }
      ocSoon(S);
    }, 60);
  }, true);
  // Where the mouse is: the 'price' axis (left), the 'time' axis, a trade line, or the plot.
  function ocZone(S, m) {
    const g = S.geo;
    if (!g || !m) return null;
    if (m.x < g.PL) return m.y <= g.PB ? 'price' : 'none';
    if (m.y > g.PB) return m.x <= g.PR ? 'time' : 'none';
    if (m.x > g.PR) return 'none';
    if (g.trade) for (const [k, y] of [['tp', g.trade.yt], ['sl', g.trade.ys], ['entry', g.trade.status === 'pending' ? g.trade.ye : null]]) {
      if (y != null && g.trade.status !== 'closed' && Math.abs(m.y - y) <= 5) return `line:${k}`;
    }
    return 'plot';
  }
  const ocCursor = (S, m) => {
    const z = ocZone(S, m);
    return z === 'price' ? 'ns-resize' : z === 'time' ? 'ew-resize' : z && z.startsWith('line:') ? 'row-resize' : z === 'none' ? 'default' : 'crosshair';
  };
  // The time of the candle under the mouse (ms), or null.
  function ocHoverT(S) {
    const g = S.geo;
    const m = S.mouse;
    if (!g || !m || !S.data || m.x < g.PL || m.x > g.PR || m.y < g.PT || m.y > g.PB) return null;
    const i = Math.max(g.rl, Math.min(g.rr, Math.round(g.end + 0.5 - (g.PR - m.x) / g.barW)));
    // The minute of the other charts: the candle less the shift to the strike charts ("+1 min": the candle of 10:31 is
    // their 10:30; 2026-10-23: the crosshair was 1 minute off).
    return (S.vd || S.data).t[i] - ocShift() * 60000;
  }
  const ocPrice = (S, y) => S.geo.hi - ((y - S.geo.PT) / (S.geo.PB - S.geo.PT)) * (S.geo.hi - S.geo.lo);
  function ocDown(S, e) {
    if (e.button !== 0 || !S.geo) return;
    const cv = S.cv;
    const m = ocPt(S, e);
    const z = ocZone(S, m);
    if (!z || z === 'none') return;
    e.preventDefault();
    cv.setPointerCapture(e.pointerId);
    const g = S.geo;
    S.drag = { z, end0: S.view.end, bars0: S.view.bars, lo0: g.lo, hi0: g.hi, moved: false };
    const mv = (ev) => {
      const p = ocPt(S, ev);
      const dx = p.x - m.x;
      const dy = p.y - m.y;
      if (!S.drag.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      S.drag.moved = true;
      if (z === 'plot') {
        S.view.end = S.drag.end0 - dx / g.barW;
        S.view.follow = false;
        S.view.auto = false;
        if (S.y || Math.abs(dy) > 6) {
          const d = (dy / (g.PB - g.PT)) * (S.drag.hi0 - S.drag.lo0);
          S.y = [S.drag.lo0 + d, S.drag.hi0 + d];
        }
      } else if (z === 'price') {
        const f = Math.exp(dy * 0.006); // down: a larger range
        const mid = (S.drag.lo0 + S.drag.hi0) / 2;
        const half = ((S.drag.hi0 - S.drag.lo0) / 2) * f;
        S.y = [mid - Math.max(25, half), mid + Math.max(25, half)];
      } else if (z === 'time') {
        const bars = Math.max(10, Math.min(2000, S.drag.bars0 * Math.exp(-dx * 0.006)));
        S.view.end = S.view.follow ? S.view.end : S.drag.end0;
        S.view.bars = bars;
        S.view.auto = false;
      } else if (z.startsWith('line:')) {
        ocMoveLeg(S, z.slice(5), ocPrice(S, p.y));
      }
      ocSoon(S);
    };
    const up = () => {
      cv.removeEventListener('pointermove', mv);
      cv.removeEventListener('pointerup', up);
      cv.removeEventListener('pointercancel', up);
      const was = S.drag;
      S.drag = null;
      if (was && !was.moved && was.z === 'price') ocLevel(S, ocPrice(S, m.y)); // a click on the price axis: a level
      if (was && was.z.startsWith('line:')) saveCfg();
      ocSoon(S);
    };
    cv.addEventListener('pointermove', mv);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
  }
  function ocWheel(S, e) {
    if (!S.geo) return;
    e.preventDefault();
    const m = ocPt(S, e);
    const g = S.geo;
    const f = Math.exp(Math.max(-300, Math.min(300, e.deltaY)) * 0.0015);
    if (m.x < g.PL && m.y <= g.PB) {
      const P = ocPrice(S, m.y);
      S.y = [P - (P - g.lo) * f, P + (g.hi - P) * f];
    } else {
      // zoom the time around the bar under the mouse (the newest candles stay at the right while it follows)
      const bars = Math.max(10, Math.min(2000, S.view.bars * f));
      if (!S.view.follow) {
        const x = Math.max(g.PL, Math.min(g.PR, m.x));
        const atBar = g.end - (g.PR - x) / g.barW;
        S.view.end = atBar + ((g.PR - x) / (g.PR - g.PL)) * bars;
      }
      S.view.bars = bars;
      S.view.auto = false;
    }
    ocSoon(S);
  }
  // A level at the nearest strike (the strike step of the price lines), or the level there goes.
  function ocLevel(S, price) {
    const tk = S.tk;
    const all = plLines(tk);
    const day = toolDay(S.tool);
    const lines = all.filter((x) => plDayOk(x, day));
    const perPx = (S.geo.hi - S.geo.lo) / (S.geo.PB - S.geo.PT);
    const step = plCfg().step * 100;
    const p = Math.round(price / step) * step;
    // A click that snaps to a level, or one near it, removes it.
    const near = lines.find((x) => x.p === p) || lines.find((x) => Math.abs(x.p - price) <= Math.max((x.w * 100) / 2, 4 * perPx));
    // For a double click: the lines before its 1st click.
    if (!S.undo || performance.now() - S.undo.at > 600) S.undo = { tk, lines: all, at: performance.now() };
    if (near) setPlLines(tk, all.filter((x) => x !== near));
    else setPlLines(tk, [...all.filter((x) => !(x.p === p && lines.includes(x))), { t: 'hline', p, w: plCfg().w, day }]);
  }
  // Move a TP / SL / order line (the sides stay right; an order takes its TP and SL with it).
  function ocMoveLeg(S, which, price) {
    if (!cfg.trade) return;
    const T = shownLegs(cfg.trade);
    const p = tick25(price);
    let next = { ...T, [which]: p };
    if (which === 'entry') {
      const d = p - T.entry;
      const res = ocRes(S, null);
      next = { ...next, tp: T.tp == null ? null : T.tp + d, sl: T.sl == null ? null : T.sl + d };
      if (res) next.kind = (T.dir > 0) === (p <= res.c) ? 'limit' : 'stop';
    }
    if (!legsOk(next)) return;
    cfg.trade = withLegs(cfg.trade, next);
    cwSoon();
  }
  // A right click in the plot: a buy or sell order at the price under the mouse (a limit or a stop order).
  let cwCtx = null;
  function ocContext(S, e) {
    e.preventDefault();
    if (!S.geo) return;
    const m = ocPt(S, e);
    if (ocZone(S, m) !== 'plot' && !String(ocZone(S, m)).startsWith('line:')) return;
    const price = tick25(ocPrice(S, m.y));
    const res = ocRes(S, null);
    if (!res) return;
    const o = tradeOpt(S.tk);
    const kind = (d) => ((d > 0) === (price <= res.c) ? 'limit' : 'stop');
    if (cwCtx) cwCtx.remove();
    cwCtx = document.createElement('div');
    cwCtx.className = 'list gmenu tctx';
    cwCtx.innerHTML = [1, -1].map((d) => `<div class="row" data-d="${d}"><span class="name ${d > 0 ? 't-buy' : 't-sell'}">${d > 0 ? 'Buy' : 'Sell'} ${o.qty} ${o.inst} @ ${px2(price)} ${kind(d)}</span></div>`).join('');
    cwCtx.addEventListener('click', (ev) => {
      const row = ev.target.closest('[data-d]');
      if (row) placeOrder(S.tk, Number(row.dataset.d), price);
      cwCtx.remove();
      cwCtx = null;
    });
    root.append(cwCtx);
    fixAt(cwCtx, Math.min(innerWidth - cwCtx.offsetWidth - 8, e.clientX), Math.min(innerHeight - cwCtx.offsetHeight - 8, e.clientY));
  }
  window.addEventListener('pointerdown', (e) => { if (cwCtx && !e.composedPath().includes(cwCtx)) { cwCtx.remove(); cwCtx = null; } }, true);
  window.addEventListener('keydown', (e) => { if (cwCtx && e.key === 'Escape') { cwCtx.remove(); cwCtx = null; } }, true);
  // The tags of the trade: drag a tag or a [TP] / [SL] chip, × closes, cancels or removes.
  function ocTagDown(S, e) {
    const tag = e.target.closest('[data-cwtag]');
    if (!tag || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const chip = e.target.closest('[data-chip]');
    const which = tag.dataset.cwtag;
    if (chip && chip.dataset.chip === 'x') return;
    const T = cfg.trade;
    const geo = S.geo && S.geo.trade;
    if (!T || !geo) return;
    const leg = chip ? chip.dataset.chip : which === 'entry' ? (geo.status === 'pending' ? 'entry' : null) : which;
    if (!leg) return;
    S.drag = { z: `tag:${leg}`, moved: true };
    const mv = (ev) => ocMoveLeg(S, leg, ocPrice(S, ocPt(S, ev).y));
    const up = () => {
      window.removeEventListener('pointermove', mv, true);
      window.removeEventListener('pointerup', up, true);
      S.drag = null;
      saveCfg();
      cwSoon();
    };
    window.addEventListener('pointermove', mv, true);
    window.addEventListener('pointerup', up, true);
  }
  function ocTagClick(S, e) {
    const chip = e.target.closest('[data-chip]');
    const tag = e.target.closest('[data-cwtag]');
    if (!chip || !tag || chip.dataset.chip !== 'x') return;
    const T = cfg.trade;
    const geo = S.geo && S.geo.trade;
    if (!T) return;
    if (tag.dataset.cwtag === 'tp' || tag.dataset.cwtag === 'sl') setTrade(withLegs(T, { ...shownLegs(T), [tag.dataset.cwtag]: null }));
    else if (geo && geo.status === 'open') closeTrade();
    else setTrade(null);
  }
  function ocTags(S, geoT) {
    const box = S.tagsEl;
    if (!geoT) {
      if (box.innerHTML) box.innerHTML = box._html = '';
      return;
    }
    const g = S.geo;
    const o = tradeOpt(S.tk);
    const side = geoT.dir > 0 ? 'LONG' : 'SHORT';
    const ord = geoT.dir > 0 ? 'BUY' : 'SELL';
    const chips = (...k) => k.map((x) => `<span data-chip="${x}" style="${CHIP_CSS}">${x === 'x' ? '×' : x.toUpperCase()}</span>`).join('');
    const legs = [geoT.tp == null ? 'tp' : null, geoT.sl == null ? 'sl' : null].filter(Boolean);
    const tags = [];
    if (geoT.status === 'pending') tags.push(['entry', geoT.ye, T_BLUE, '#fff', `${ord} ${geoT.kind === 'limit' ? 'LMT' : 'STP'} ${o.qty} ${o.inst} @ ${px2(geoT.entry)}`, chips(...legs, 'x')]);
    else if (geoT.status === 'closed') tags.push(['entry', geoT.ye, geoT.pnl >= 0 ? T_GREEN : T_RED, '#0b0d10', `${side} closed (${geoT.why}) ${pts(geoT.pnl)} ${usdPnl(geoT.pnl)}`, chips('x')]);
    else tags.push(['entry', geoT.ye, 'rgba(255,255,255,.92)', '#0b0d10', `${side} ${o.qty} ${o.inst} ${pts(geoT.pnl)} ${usdPnl(geoT.pnl)}`, chips(...legs, 'x')]);
    if (geoT.tp != null && geoT.status !== 'closed') tags.push(['tp', geoT.yt, T_GREEN, '#04120b', `TP ${px2(geoT.tp)} ${pts((geoT.tp - geoT.entry) * geoT.dir)} ${usdPnl((geoT.tp - geoT.entry) * geoT.dir)}`, chips('x')]);
    if (geoT.sl != null && geoT.status !== 'closed') tags.push(['sl', geoT.ys, T_RED, '#1a0505', `SL ${px2(geoT.sl)} ${pts((geoT.sl - geoT.entry) * geoT.dir)} ${usdPnl((geoT.sl - geoT.entry) * geoT.dir)}`, chips('x')]);
    const html = tags.map(([w, y, bg, fg, text, ch]) => `<div data-cwtag="${w}" style="${TAG_CSS}left:auto;right:${g.W - g.PR + 6}px;top:${Math.max(g.PT + 9, Math.min(g.PB - 9, y))}px;background:${bg};color:${fg}">`
      + `<span class="t-txt">${text}</span>${ch}</div>`).join('');
    if (box._html !== html) {
      box._html = html;
      box.innerHTML = html;
    }
  }
  // Draw the chart.
  function ocDraw(S) {
    const c = S.c;
    const cv = S.cv;
    const W = c.offsetWidth;
    const H = Math.min(c.offsetHeight, S.H || c.offsetHeight);
    if (!W || !H) return;
    const b = c.getBoundingClientRect();
    const u = (devicePixelRatio || 1) * scaleOf(c, b);
    if (cv.width !== Math.round(W * u)) cv.width = Math.round(W * u);
    if (cv.height !== Math.round(H * u)) cv.height = Math.round(H * u);
    if (cv.style.width !== `${W}px`) Object.assign(cv.style, { width: `${W}px`, height: `${H}px` });
    const g = cv.getContext('2d');
    g.setTransform(u, 0, 0, u, 0, 0);
    g.clearRect(0, 0, W, H); // QuantData's ground (the gradient of the tool) shows through
    const d1 = S.data;
    const cut1 = ocCut(S);
    // QuantData's chips on another period: its candles hold future minutes; wait for the 1-minute candles (ocChips).
    S.notOne = S.metaN > 1;
    const N = ocN();
    const A = N > 1 && d1 && cut1 >= 0 && !S.notOne ? ocAgg(S, d1, cut1, N) : null;
    const d = A ? A.d : d1;
    const cut = S.notOne ? -1 : A ? A.cut : cut1;
    const mins = A ? A.min : S.min;
    const toA = (i) => (A ? A.of[Math.max(0, Math.min(cut1, i))] : i); // a 1-minute row -> its candle
    // The same with the part of the candle (row 13:22 of 13:20-13:25: candle + 2/5): the view moves by minutes, not by
    // whole candles (2026-10-28: with 5-minute candles the chart seemed to lag on a drag of the zoom bar).
    const toAf = (i) => {
      if (!A) return i;
      const j = Math.max(0, Math.min(cut1, i));
      return A.of[j] + Math.max(0, Math.min(N - 1, S.min[j] - A.min[A.of[j]])) / N;
    };
    S.vd = d;
    if (S.viewN !== undefined && S.viewN !== N) S.view = { end: null, bars: OC_BARS, follow: true, auto: true };
    S.viewN = N;
    const [PL, PR, PT, PB0] = S.plot && S.plot[1] > S.plot[0] + 20 && S.plot[3] > S.plot[2] + 20 ? S.plot : [56, W - 24, 8, H - 20];
    const PB = Math.min(PB0, H - 18); // room for the time axis above the zoom bar
    if (!d || cut < 0) {
      S.geo = null;
      ocTags(S, null);
      if (S.tbar) S.tbar.classList.remove('on');
      // Nothing to draw: a text in the middle (2026-10-22: before 09:30 the chart was empty).
      const c0 = sdColorsNow();
      const first = d && d.t.length ? d.t[0] : null;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = c0.text;
      g.font = '600 13px interVariableFont, Inter, -apple-system, system-ui, sans-serif';
      const wait = S.wait && first;
      g.fillText(S.notOne ? 'Loading the 1-minute candles' : wait ? 'Waiting for the replay time' : first ? 'Not in session' : 'No price data', W / 2, H / 2 - (first && !wait && !S.notOne ? 9 : 0));
      if (first && !wait && !S.notOne) {
        g.globalAlpha = 0.6;
        g.font = '500 11px interVariableFont, Inter, -apple-system, system-ui, sans-serif';
        g.fillText(`The first candle: ${cwLocal.format(new Date(first))}`, W / 2, H / 2 + 10);
        g.globalAlpha = 1;
      }
      cv.dataset.state = JSON.stringify({ empty: wait ? 'wait' : first ? 'session' : 'data' });
      return;
    }
    const col = sdColorsNow();
    const UP = d.up || 'rgb(0, 255, 0)';
    const DOWN = d.down || 'rgb(255, 0, 0)';
    const PW = PR - PL;
    const PH = PB - PT;
    // The loaded candles: the range of the zoom bar, up to the replay minute (ocBarRead).
    const rg = S.range;
    const rl = rg ? Math.max(0, Math.min(cut, toA(rg[0]))) : 0;
    const rr = rg ? Math.max(rl, Math.min(cut, toA(Math.min(cut1, rg[1])))) : cut;
    // The time axis automatic (2026-10-22; at the start and after a double click on it): all loaded candles in
    // view (the range of the zoom bar), at least OC_BARS wide (the first candles of the day stay narrow). Your zoom on
    // it: that width, the newest at the right; your drag: free.
    // 2026-10-22: the candles fill the chart from its left end. (The option of a candle width was removed on
    // 2026-10-28: it was a maximum width, and nobody used it.)
    if (S.view.auto) {
      const span = rg ? toAf(Math.min(cut1, rg[1])) - toAf(rg[0]) : rr - rl;
      S.view.bars = Math.max(span + 1 + OC_PAD, 10);
    }
    if (S.view.follow || S.view.end == null) S.view.end = (rg ? Math.max(rl, Math.min(cut, toAf(Math.min(cut1, rg[1])))) : rr) + OC_PAD;
    const bars = S.view.bars;
    const end = S.view.end;
    const barW = PW / bars;
    const X = (i) => PR - (end - i + 0.5) * barW;
    const i0 = Math.max(rl, Math.floor(end - bars));
    const i1 = Math.min(rr, Math.ceil(end));
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = i0; i <= i1; i++) {
      if (Number.isFinite(d.l[i])) lo = Math.min(lo, d.l[i]);
      if (Number.isFinite(d.h[i])) hi = Math.max(hi, d.h[i]);
    }
    if (!Number.isFinite(lo)) [lo, hi] = [d.c[rr] - 500, d.c[rr] + 500];
    // "Keep the lines in view" (the Lines menu): the levels and the trade lines in the automatic range.
    const tk = S.tk;
    const T = cfg.trade && cfg.trade.tk === tk && cfg.trade.day === dayOfMs(d.t[cut]) ? cfg.trade : null;
    if (plCfg().fit) {
      for (const v of [...plLinesAt(tk, S.tool).map((x) => x.p), ...(T ? [T.entry, T.tp, T.sl] : [])]) {
        if (v == null) continue;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    const pad = Math.max(50, (hi - lo) * 0.08);
    [lo, hi] = S.y || [lo - pad, hi + pad];
    const Y = (v) => PT + ((hi - v) / (hi - lo)) * PH;
    S.geo = { W, H, PL, PR, PT, PB, end, bars, barW, lo, hi, cut, cut1, rl, rr, i0, i1 };
    // the price axis at the left and the time axis at the bottom, like QuantData's
    g.font = OC_FONT;
    g.textBaseline = 'middle';
    g.fillStyle = col.text;
    g.textAlign = 'right';
    const gc = ocGrid();
    const gridH = [];
    const gridV = [];
    for (const v of cwTicks(lo, hi, Math.max(3, Math.round(PH / 70)))) {
      const y = Math.round(Y(v));
      if (y < PT + 4 || y > PB - 4) continue;
      g.fillText(cwAxP(v), PL - 8, y);
      gridH.push(y);
    }
    // a label each `every` minutes (a whole number of candles), about 90 px apart
    const every = [1, 2, 5, 10, 15, 30, 60, 120].find((k) => k % N === 0 && (k / N) * barW >= 90) || 240;
    g.textAlign = 'center';
    for (let i = i0; i <= Math.min(d.t.length - 1, Math.ceil(end)); i++) {
      if (mins[i] % every) continue;
      const x = X(i);
      if (x < PL + 20 || x > PR - 20) continue;
      g.fillText(cwLocal.format(new Date(d.t[i])), x, PB + (H - PB) / 2);
      gridV.push(Math.round(x));
    }
    if (gc.show !== 'off' && gc.op > 0) {
      g.save();
      g.strokeStyle = col.text;
      g.globalAlpha = Math.min(1, gc.op / 100);
      g.lineWidth = 1;
      g.setLineDash(gc.style === 'dashed' ? [6, 4] : gc.style === 'dotted' ? [1, 3] : []);
      g.beginPath();
      if (gc.show === 'h' || gc.show === 'both') for (const y of gridH) { g.moveTo(PL, y + 0.5); g.lineTo(PR, y + 0.5); }
      if (gc.show === 'v' || gc.show === 'both') for (const x of gridV) { g.moveTo(x + 0.5, PT); g.lineTo(x + 0.5, PB); }
      g.stroke();
      g.restore();
    }
    g.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(PL, Math.round(PB) + 0.5);
    g.lineTo(PR, Math.round(PB) + 0.5);
    g.stroke();
    g.save();
    g.beginPath();
    g.rect(PL, PT, PW, PH);
    g.clip();
    // levels (bands in points, like the price lines on QuantData's chart)
    const labels = [];
    for (const ln of plLinesAt(tk, S.tool)) {
      const y1 = Y(ln.p + (ln.w * 100) / 2);
      const y2 = Y(ln.p - (ln.w * 100) / 2);
      if (y2 < PT || y1 > PB) continue;
      g.globalAlpha = 0.55;
      g.fillStyle = col.primary;
      g.fillRect(PL, Math.round(y1), PW, Math.max(1, Math.round(y2 - y1)));
      g.globalAlpha = 1;
      labels.push([usd(ln.p / 100).replace(/\.00$/, ''), (y1 + y2) / 2]);
    }
    // The overnight gap (2026-10-23; Indicators): a box from the prior close to the open of the day (the first
    // candle at or after 09:30), from that candle to the right. It gets smaller with the fill (the lowest low since the
    // open for a gap up, the highest high for a gap down) and ends at the candle that fills it. The label at the prior
    // close: "Gap +12.50 · 63% filled".
    let gapInfo = null;
    let gapLabel = null;
    const pcl = sdClose(tk);
    if (cfg.gap !== false && pcl && dayOfMs(d.t[cut]) === (sdDayNow() || dayOfMs(d.t[cut]))) {
      const P = Math.round(pcl * 100);
      let io = -1;
      for (let i = 0; i <= cut; i++) if (mins[i] >= RTH_OPEN) { io = i; break; }
      if (io >= 0) {
        const O = d.o[io];
        const gp = O - P;
        let ext = O; // the furthest price into the gap since the open
        let fill = -1;
        for (let i = io; i <= cut; i++) {
          ext = gp > 0 ? Math.min(ext, d.l[i]) : Math.max(ext, d.h[i]);
          if (fill < 0 && gp !== 0 && (gp > 0 ? d.l[i] <= P : d.h[i] >= P)) fill = i;
        }
        const pct = gp === 0 ? 100 : Math.max(0, Math.min(100, Math.round(((O - ext) / gp) * 100)));
        gapInfo = { tk, P, open: O, gap: gp, pct, io, end: fill >= 0 ? fill : cut, filled: gp === 0 || fill >= 0, at: fill >= 0 ? d.t[fill] : null };
        const AMBER = 'rgb(255, 196, 0)';
        const xo = Math.max(PL, X(io) - barW / 2);
        // Only up to the candle that filled it, else up to the replay minute (2026-10-23: "nur bis zu der Kerze,
        // wo sie mitigiert wurde").
        const xe = Math.min(PR, X(fill >= 0 ? fill : cut) + barW / 2);
        if (gp !== 0 && xo < xe) {
          const yP = Y(P);
          // The box gets smaller with the fill (2026-10-23): each candle shows only the part of the gap that was
          // not filled before it, so a leg into the gap cuts the box at that leg and the filled part does not go on to
          // the right. The candle that fills the gap is the last one with a box.
          const last = fill >= 0 ? fill : cut;
          const a = Math.max(io, i0 - 1);
          const b2 = Math.min(last, i1 + 1);
          let e = O;
          for (let i = io; i < a; i++) e = gp > 0 ? Math.min(e, d.l[i]) : Math.max(e, d.h[i]);
          g.save();
          g.beginPath();
          g.rect(PL, PT, PW, PH);
          g.clip();
          const look = gapCfg();
          g.fillStyle = AMBER;
          g.globalAlpha = Math.max(0, Math.min(100, look.op)) / 100;
          g.beginPath();
          for (let i = a; i <= b2; i++) {
            const ye = Y(e);
            g.rect(X(i) - barW / 2, Math.min(yP, ye), barW, Math.abs(ye - yP));
            e = gp > 0 ? Math.min(e, d.l[i]) : Math.max(e, d.h[i]);
          }
          g.fill();
          if (look.line) {
            g.globalAlpha = gapInfo.filled ? 0.5 : 0.95;
            g.strokeStyle = AMBER;
            g.lineWidth = 1;
            if (gapInfo.filled) g.setLineDash([5, 4]);
            g.beginPath();
            g.moveTo(xo, Math.round(yP) + 0.5);
            g.lineTo(xe, Math.round(yP) + 0.5);
            g.stroke();
          }
          g.restore();
          const sz = `${gp > 0 ? '+' : '−'}${usd(Math.abs(gp) / 100)}`;
          gapLabel = look.label === 'off' ? null : look.label === 'size' ? `Gap ${sz}` : `Gap ${sz} · ${gapInfo.filled ? (gapInfo.at ? `filled ${cwLocal.format(new Date(gapInfo.at))}` : 'filled') : `${pct}% filled`}`;
          if (gapLabel) labels.push([gapLabel, Math.round(yP) + 0.5]);
        }
      }
    }
    S.gap = gapInfo;
    // the σ lines of the ticker (prior close ± each selected σ; dashed like on the strike charts)
    const sdDrawn = [];
    const sg = cfg.sd.on && cfg.sd.price !== false && sdSigma(tk); // the option in the σ section (2026-10-22)
    if (sg && dayOfMs(d.t[cut]) === (sdDayNow() || dayOfMs(d.t[cut]))) {
      const P = sdClose(tk) * 100;
      g.save();
      g.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      g.lineWidth = 1;
      g.setLineDash([6, 4]);
      for (const k of cfg.sd.levels) {
        for (const s of [1, -1]) {
          const v = P + s * k * sg * 100;
          const y = Math.round(Y(v)) + 0.5;
          if (y < PT || y > PB) continue;
          g.beginPath();
          g.moveTo(PL, y);
          g.lineTo(PR, y);
          g.stroke();
          labels.push([`${s > 0 ? '+' : '−'}${lvText(k)}`, y]);
          sdDrawn.push({ k: s * k, p: Math.round(v) });
        }
      }
      g.restore();
    }
    // candles, or a line of the closes (like QuantData's line: grey, 1.5 px)
    const bw = Math.max(1, Math.min(barW * 0.7, barW - 1));
    if (cfg.ocLine) {
      g.save();
      g.strokeStyle = 'hsl(0, 1.2%, 70%)';
      g.lineWidth = 1.5;
      g.lineJoin = 'round';
      g.beginPath();
      let on = false;
      for (let i = i0; i <= i1; i++) {
        if (!Number.isFinite(d.c[i])) continue;
        if (on) g.lineTo(X(i), Y(d.c[i]));
        else g.moveTo(X(i), Y(d.c[i]));
        on = true;
      }
      g.stroke();
      g.restore();
    }
    for (let i = i0; i <= i1 && !cfg.ocLine; i++) {
      const o = d.o[i];
      const h = d.h[i];
      const l = d.l[i];
      const cl = d.c[i];
      if (![o, h, l, cl].every(Number.isFinite)) continue;
      const x = X(i);
      g.strokeStyle = g.fillStyle = cl >= o ? UP : DOWN;
      g.beginPath();
      g.moveTo(Math.round(x) + 0.5, Y(h));
      g.lineTo(Math.round(x) + 0.5, Y(l));
      g.stroke();
      const yt = Y(Math.max(o, cl));
      g.fillRect(Math.round(x - bw / 2), Math.round(yt), Math.max(1, Math.round(bw)), Math.max(1, Math.round(Y(Math.min(o, cl)) - yt)));
    }
    // the trade: zones, lines over the whole chart
    let geoT = null;
    if (T) {
      const res = ocRes(S, T.et);
      const v = res && evalTrade(T, res);
      if (v && v.status !== 'before' && v.status !== 'cancelled') {
        const xAt = (ms) => {
          let k = 0;
          while (k < cut && d.t[k + 1] <= ms) k++;
          return X(k);
        };
        const x0 = Math.max(PL, xAt(v.fillT ?? T.et));
        const x1 = v.status === 'closed' ? xAt(v.exitT) : PR;
        const ye = Y(T.entry);
        if (v.status !== 'pending') {
          if (v.tp != null) { g.fillStyle = 'rgba(38, 194, 129, 0.16)'; g.fillRect(x0, Math.min(ye, Y(v.tp)), x1 - x0, Math.abs(Y(v.tp) - ye)); }
          if (v.sl != null && (v.sl - T.entry) * T.dir < 0) { g.fillStyle = 'rgba(239, 83, 80, 0.16)'; g.fillRect(x0, Math.min(ye, Y(v.sl)), x1 - x0, Math.abs(Y(v.sl) - ye)); }
        }
        const hl = (y, colr, dash) => {
          g.save(); g.strokeStyle = colr; g.lineWidth = 1.5; if (dash) g.setLineDash([6, 4]);
          g.beginPath(); g.moveTo(PL, Math.round(y) + 0.5); g.lineTo(PR, Math.round(y) + 0.5); g.stroke(); g.restore();
        };
        if (v.tp != null) hl(Y(v.tp), T_GREEN, v.status !== 'open');
        if (v.sl != null) hl(Y(v.sl), T_RED, v.status !== 'open');
        hl(ye, v.status === 'pending' ? T_BLUE : 'rgba(255, 255, 255, 0.9)', v.status !== 'open');
        geoT = { ...v, entry: T.entry, kind: T.kind, dir: T.dir, ye, yt: v.tp != null ? Y(v.tp) : null, ys: v.sl != null ? Y(v.sl) : null };
      }
    }
    S.geo.trade = geoT;
    g.restore();
    // the labels of the levels and σ lines at the left end of the plot, like on QuantData's chart
    for (const [text, y] of labels) if (y >= PT + 9 && y <= PB - 9) cwLabel(g, text, PL + 4, y, col.primary, col.text, col.bg, 'left');
    // the last price on the price axis
    const last = d.c[rr];
    const yl = Y(last);
    // The price line (2026-10-23; Charts > Price chart, on by default): a dotted line at the last price over the
    // whole plot, in the color of the last candle.
    const plineOn = cfg.ocPriceLine !== false && yl >= PT && yl <= PB;
    if (plineOn) {
      g.save();
      g.strokeStyle = last >= d.o[rr] ? UP : DOWN;
      g.globalAlpha = 0.8;
      g.lineWidth = 1;
      g.setLineDash([2, 3]);
      g.beginPath();
      g.moveTo(PL, Math.round(yl) + 0.5);
      g.lineTo(PR, Math.round(yl) + 0.5);
      g.stroke();
      g.restore();
    }
    if (yl >= PT && yl <= PB) cwLabel(g, cwAxP(last), PL - 2, yl, last >= d.o[rr] ? UP : DOWN, '#0b0d10', col.bg, 'right');
    // the crosshair: the bar under the mouse, the price at the mouse (QuantData's dashed primary lines and labels)
    let hover = null;
    const m = S.mouse;
    if (m && m.x >= PL && m.x <= PR && m.y >= PT && m.y <= PB && !(S.drag && S.drag.z.startsWith('tag'))) {
      hover = Math.max(rl, Math.min(rr, Math.round(end + 0.5 - (PR - m.x) / barW)));
      const x = Math.round(X(hover)) + 0.5;
      g.save();
      g.strokeStyle = col.primary;
      g.lineWidth = 1;
      g.setLineDash([4, 4]);
      g.beginPath(); g.moveTo(x, PT); g.lineTo(x, PB); g.moveTo(PL, Math.round(m.y) + 0.5); g.lineTo(PR, Math.round(m.y) + 0.5); g.stroke();
      g.restore();
      cwLabel(g, cwP(ocPrice(S, m.y)), PL - 2, m.y, col.primary, col.text, col.bg, 'right');
      cwLabel(g, cwLocal.format(new Date(d.t[hover])), x, PB + (H - PB) / 2, col.primary, col.text, col.bg, 'center');
      // the values of the candle under the mouse at the top left (like TradingView's legend)
      const f = (v) => px2(v);
      g.font = '600 11px interVariableFont, Inter, -apple-system, system-ui, sans-serif';
      g.textAlign = 'left';
      g.fillStyle = col.text;
      // At the top right (2026-10-22: not below the trade buttons); off in the chart menu (cfg.ocOhlc false).
      if (cfg.ocOhlc !== false) {
        g.textAlign = 'right';
        g.fillText(`O ${f(d.o[hover])}  H ${f(d.h[hover])}  L ${f(d.l[hover])}  C ${f(d.c[hover])}`, PR - 6, PT + 10);
      }
    }
    // the line of another chart under the mouse (the crosshair line of the other charts): at the candle of that time
    let ext = null;
    if (hover == null && S.ext != null) {
      const te = S.ext + ocShift() * 60000; // the time of the other charts as a candle of this one
      let j = -1;
      for (let i = rl; i <= rr; i++) if (d.t[i] <= te) j = i;
      if (j >= 0 && te - d.t[j] < N * 60000) {
        const x = Math.round(X(j)) + 0.5;
        if (x >= PL && x <= PR) {
          ext = d.t[j];
          g.save();
          g.strokeStyle = col.primary;
          g.lineWidth = 1;
          g.setLineDash([4, 4]);
          g.beginPath(); g.moveTo(x, PT); g.lineTo(x, PB); g.stroke();
          g.restore();
          cwLabel(g, cwLocal.format(new Date(d.t[j])), x, PB + (H - PB) / 2, col.primary, col.text, col.bg, 'center');
        }
      }
    }
    // the price axis: the preview of a level (a click adds it; "×": a click removes the level there)
    let prev = null;
    if (m && m.x < PL && m.y >= PT && m.y <= PB && !S.drag) {
      const step = plCfg().step * 100;
      const price = ocPrice(S, m.y);
      const p = Math.round(price / step) * step;
      const perPx = (hi - lo) / PH;
      const near = plLinesAt(tk, S.tool).find((x) => x.p === p) || plLinesAt(tk, S.tool).find((x) => Math.abs(x.p - price) <= Math.max((x.w * 100) / 2, 4 * perPx));
      prev = { p: near ? near.p : p, del: !!near };
      const y = Math.round(Y(prev.p)) + 0.5;
      g.save(); g.strokeStyle = col.primary; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(PL, y); g.lineTo(PR, y); g.stroke(); g.restore();
      cwLabel(g, `${prev.del ? '× ' : ''}${usd(prev.p / 100).replace(/\.00$/, '')}`, PL + 4, y, col.primary, col.text, col.bg, 'left');
    }
    ocTags(S, geoT);
    // The trade buttons (the pill "Trade" on): at the replay price.
    const tOn = !!cfg.tradeOn;
    S.tbar.classList.toggle('on', tOn);
    if (tOn) {
      const o = tradeOpt(tk);
      const rp = px2(tick25(d.c[cut]));
      Object.assign(S.tbar.style, { left: `${PL + 6}px`, top: `${PT + 6}px` });
      for (const el of S.tbar.querySelectorAll('.p')) if (el.textContent !== rp) el.textContent = rp;
      const n = S.tbar.querySelector('.n');
      if (n.textContent !== String(o.qty)) n.textContent = String(o.qty);
      const inst = S.tbar.querySelector('.inst');
      if (inst.textContent !== o.inst) inst.textContent = o.inst;
    }
    cv.dataset.state = JSON.stringify({ n: N, line: !!cfg.ocLine, last: [d.t[cut], d.o[cut], d.h[cut], d.l[cut], d.c[cut]], cut, rl, rr, i0, i1, lo, hi, bars, end, follow: S.view.follow, auto: !!S.view.auto, own: !!S.y, plot: [PL, PR, PT, PB], hover, ext, prev, sd: sdDrawn, gap: gapInfo, gapLabel, pline: plineOn ? Math.round(yl) : null,
      grid: gc.show === 'off' || !gc.op ? null : { ...gc, h: gc.show === 'v' ? 0 : gridH.length, v: gc.show === 'h' ? 0 : gridV.length },
      trade: geoT && { status: geoT.status, pnl: geoT.pnl, why: geoT.why, ye: geoT.ye, yt: geoT.yt, ys: geoT.ys } });
  }
  // A label like QuantData's crosshair label: its ground, white semibold 11 px, radius 3, 18 px high, a shadow in the
  // background color. x: the left end ('left'), the right end ('right') or the middle.
  function cwLabel(g, text, x, y, bg, fgc, shadow, align) {
    g.save();
    g.font = '600 11px interVariableFont, Inter, -apple-system, system-ui, sans-serif';
    const w = g.measureText(text).width + 12;
    const x0 = Math.max(0, Math.round(align === 'left' ? x : align === 'right' ? x - w : x - w / 2)); // not cut at the left edge
    const y0 = Math.round(y - 9);
    g.shadowColor = shadow;
    g.shadowOffsetX = 1;
    g.shadowOffsetY = 1;
    g.shadowBlur = 2;
    g.fillStyle = bg;
    g.beginPath();
    if (g.roundRect) g.roundRect(x0, y0, w, 18, 3);
    else g.rect(x0, y0, w, 18);
    g.fill();
    g.shadowColor = 'transparent';
    g.fillStyle = fgc;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, x0 + w / 2, y0 + 9.5);
    g.restore();
  }
  window.addEventListener('resize', cwSoon);

  // ---------------------------------------------------------------------------
  // A fixed y scale on the strike charts (1.1; 2026-10-21: "eine fixierte Skala, die ich selber dragen kann,
  // sodass ich nicht durcheinander komme"). QuantData scales the exposure axis again at each zoom, pan and load. Here the
  // range stays: the first automatic range of a chart is kept, and only you change it. Drag the value axis (at the left)
  // down: a larger range, up: a smaller one (around zero); the wheel on it does the same; a double click on it takes
  // QuantData's automatic range of now and keeps it. The bridge draws the chart (op strikeY): the same look, the fixed
  // range, no entrance animation. Stored per strike chart and its title (DEX and GEX have other units): cfg.sy.
  // cfg.syOn false (the list option): QuantData's own scale.
  // ---------------------------------------------------------------------------
  const syOn = () => cfg.syOn !== false;
  const syAt = new Map(); // chart key -> { c, key, info (bridge charts), auto [min, max], seen }
  const sySaved = (key) => {
    const d = (cfg.sy || {})[key];
    return Array.isArray(d) && d[1] > d[0] ? d : null;
  };
  // A double click on the value axis: automatic again (2026-10-21: it follows the zoom), stored as 'auto' until
  // you drag or wheel on the axis.
  const syAuto = (key) => (cfg.sy || {})[key] === 'auto';
  function setSy(key, dom) {
    cfg.sy = { ...(cfg.sy || {}), [key]: dom };
    const keys = Object.keys(cfg.sy);
    if (keys.length > 60) delete cfg.sy[keys[0]];
  }
  // In the refresh: the strike charts on the page get our drawing with their range.
  function syRefresh() {
    try {
      if (!syOn() && !syAt.size) return; // off: no bridge call (the load on the page)
      tagCharts();
      const infos = chartsNow();
      const want = new Map();
      if (syOn()) {
        for (const t of Array.isArray(infos) ? infos : []) {
          if (!t.ok || t.kind !== 'strike' || t.yMin !== undefined) continue; // not the Interval Map
          const c = document.querySelector(`canvas[data-qdts-chart="${t.k}"]`);
          if (!c || !isChart(c) || !c.getClientRects().length) continue;
          const tool = toolOf(c);
          const z = zoomBars.find((b) => b.tool === tool && !b.vertical);
          const old = syAt.get(t.k);
          // During a load the title and the zoom bar are gone: then the key of before (else the chart had no stored range
          // for a moment and showed QuantData's automatic one).
          const title = headTitle(tool);
          const own = z && z.root.isConnected && title ? `${z.key}|${title}` : old && old.c === c ? old.own : null;
          // A scale group (Linking, 2026-10-23): the charts with the same letter share 1 stored range.
          const grp = z ? syGroupOf(z.key) : old ? old.grp : '';
          const key = own && grp ? `group:${grp}` : own;
          if (key) want.set(t.k, { c, key, own, grp, info: t, tool });
        }
      }
      for (const [k, x] of syAt) {
        if (want.has(k)) continue;
        // A step loads the strike chart: its zoom bar and its layout are gone for a moment. Our scale stays on (else
        // QuantData's automatic scale showed for a moment and the chart jumped; 2026-10-21), while its canvas
        // is on the page and shown (max 10 s without data).
        if (syOn() && x.c && x.c.isConnected && x.c.getClientRects().length && performance.now() - (x.at || 0) < (sdToolLoading(x.tool) ? 30000 : 10000)) {
          syLoad(k, x);
          continue;
        }
        bridge('strikeY', { k, on: false });
        if (x.c) x.c.style.cursor = '';
        syAt.delete(k);
      }
      // A group in the automatic mode (or without a range yet): the range that holds the automatic ranges of all of them.
      const grpAuto = new Map();
      for (const [k, w] of want) {
        const a = w.grp && (syAt.get(k) || {}).auto;
        if (!a) continue;
        const g = grpAuto.get(w.key);
        grpAuto.set(w.key, g ? [Math.min(g[0], a[0]), Math.max(g[1], a[1])] : [a[0], a[1]]);
      }
      for (const [k, w] of want) {
        const old = syAt.get(k);
        const x = { ...w, auto: old && old.auto, seen: old && old.key === w.key ? old.seen : performance.now(), at: performance.now() };
        syAt.set(k, x);
        const dom = sySaved(x.key) || (x.grp && syAuto(x.key) ? grpAuto.get(x.key) || null : null);
        syLoad(k, x, old);
        const res = bridge('strikeY', { k, on: true, dom });
        if (!res || !res.ok) continue;
        x.auto = res.auto;
        // No range yet: QuantData's range when the chart is ready (shown 1.5 s, not loading, a real range).
        if (!dom && !syAuto(x.key) && res.auto && res.auto[1] > res.auto[0] && !(res.auto[0] === 0 && res.auto[1] === 1)
          && performance.now() - x.seen > 1500 && !sdToolLoading(w.tool)) {
          const g = x.grp && grpAuto.get(x.key);
          const first = g ? [Math.min(g[0], res.auto[0]), Math.max(g[1], res.auto[1])] : res.auto;
          setSy(x.key, first);
          saveCfg();
          bridge('strikeY', { k, on: true, dom: first });
        }
      }
    } catch (err) {
      if (!sdErrorShown) console.warn('[QD Toolkit] strike scale', err);
      sdErrorShown = true;
    }
  }
  // A load starts (QuantData's placeholder, no zoom bar): our drawing goes until QuantData draws the new data (the
  // bridge shows it again at that draw). Only at the start of a load: else it went again just after that draw.
  function syLoad(k, x, old) {
    const loading = !!x.tool && sdToolLoading(x.tool);
    const was = old ? old.loading : x.loading;
    x.loading = loading;
    if (loading && !was) bridge('strikeY', { k, on: true, dom: sySaved(x.key), hide: true });
  }
  // The mouse on the value axis of a strike chart with our scale (left of the plot): its entry, or null.
  let syLastDown = null; // the last press on a chart (for the report)
  function syHit(e) {
    const t = e.target instanceof HTMLCanvasElement ? e.target : null;
    const k = t && t.getAttribute('data-qdts-chart');
    const x = k && syAt.get(k);
    syLastDown = { target: e.target && e.target.tagName, cls: String((e.target && e.target.className) || '').slice(0, 60), k, entry: !!x, plot: x && x.info ? x.info.plot : null };
    if (!x || !x.info || !x.info.plot) return null;
    const b = t.getBoundingClientRect();
    const sc = scaleOf(t, b);
    const lx = (e.clientX - b.left) / sc;
    const ly = (e.clientY - b.top) / sc;
    const [pl, , pt, pb] = x.info.plot;
    Object.assign(syLastDown, { lx: Math.round(lx), ly: Math.round(ly), sc, cw: t.width, ow: t.offsetWidth });
    return lx >= 0 && lx < pl && ly >= pt && ly <= pb ? { k, x, sc } : null;
  }
  let syDrag = null;
  let syRaf = 0;
  function syApply(k, key, dom) {
    setSy(key, dom);
    if (!syRaf) {
      syRaf = requestAnimationFrame(() => {
        syRaf = 0;
        for (const [kk, x] of syAt) if (x.key === key) bridge('strikeY', { k: kk, on: true, dom: sySaved(key) });
        drawBands(); // the σ lines and labels with the new layout
      });
    }
    void k;
  }
  const syScale = (d, f) => [d[0] * f, d[1] * f]; // around zero (the zero line stays)
  window.addEventListener('pointerdown', (e) => {
    if (!e.isTrusted || e.button !== 0 || !syAt.size) return;
    const h = syHit(e);
    if (!h) return;
    const d0 = sySaved(h.x.key) || h.x.auto;
    if (!d0) return;
    e.preventDefault();
    e.stopPropagation();
    syDrag = { ...h, y0: e.clientY, d0 };
  }, true);
  window.addEventListener('mousedown', (e) => { if (e.isTrusted && syDrag) e.stopPropagation(); }, true);
  window.addEventListener('pointermove', (e) => {
    if (!e.isTrusted) return;
    if (syDrag) {
      e.stopPropagation();
      const f = Math.exp(((e.clientY - syDrag.y0) / syDrag.sc) * 0.006); // down: a larger range
      syApply(syDrag.k, syDrag.x.key, syScale(syDrag.d0, f));
      return;
    }
    if (!syAt.size) return;
    const t = e.target instanceof HTMLCanvasElement ? e.target : null;
    if (!t || !syAt.has(t.getAttribute('data-qdts-chart') || '')) return;
    const cur = syHit(e) ? 'ns-resize' : '';
    if (t.style.cursor !== cur) t.style.cursor = cur;
  }, { capture: true, passive: true });
  window.addEventListener('pointerup', (e) => {
    if (!syDrag) return;
    syDrag = null;
    saveCfg();
    if (e.isTrusted) e.stopPropagation();
  }, true);
  window.addEventListener('wheel', (e) => {
    if (!e.isTrusted || !syAt.size) return;
    const h = syHit(e);
    if (!h) return;
    const d0 = sySaved(h.x.key) || h.x.auto;
    if (!d0) return;
    e.preventDefault();
    e.stopPropagation();
    syApply(h.k, h.x.key, syScale(d0, Math.exp(Math.max(-300, Math.min(300, e.deltaY)) * 0.0015)));
    saveCfg();
  }, { capture: true, passive: false });
  window.addEventListener('dblclick', (e) => {
    if (!e.isTrusted || !syAt.size) return;
    const h = syHit(e);
    if (!h) return;
    e.preventDefault();
    e.stopPropagation();
    // Automatic again: QuantData's range, also when you zoom (until you drag or wheel on the axis).
    syApply(h.k, h.x.key, 'auto');
    saveCfg();
  }, true);

  // ---------------------------------------------------------------------------
  // Legend values at the replay minute (1.1).
  // QuantData's legend of a time chart (Net Drift "Calls ($5.38 M)", a price chart "SPX ($7,499.44)") shows the last
  // value of the day, also when the chart shows an earlier minute: in a replay you see where the price goes (
  // 2026-10-15). The panel writes the value at the right end of the visible range (the replay minute) into the
  // legend. Which series a value belongs to is found by its last value (cents or not, M / B units); the format stays.
  // A MutationObserver writes it again before the page paints when QuantData renders the legend again.
  // ---------------------------------------------------------------------------
  const LV_RE = /\(([-−]?)(\$?)([\d,]+(?:\.\d+)?)(\s*)([KMBT%]?)\)/;
  const LV_UNIT = { '': 1, K: 1e3, M: 1e6, B: 1e9, T: 1e12, '%': 1 };
  const lvSpans = new Map(); // name span -> { orig (QuantData's text), mine (our text) }
  const lvObserved = new WeakSet();
  let lvAt = new Map(); // chart canvas -> { end, vals }
  const lvObs = new MutationObserver(() => {
    for (const [sp, st] of lvSpans) {
      if (!sp.isConnected) {
        lvSpans.delete(sp);
        continue;
      }
      if (st.mine && sp.textContent !== st.mine) {
        st.orig = sp.textContent; // QuantData wrote a new (last) value
        lvWrite(sp, st);
      }
    }
  });
  function lvNew(st) {
    const m = LV_RE.exec(st.orig);
    if (!m || !st.chart) return null;
    const at = lvAt.get(st.chart);
    if (!at || at.end) return null;
    const dec = (m[3].split('.')[1] || '').length;
    const unit = LV_UNIT[m[5]] || 1;
    const shown = (m[1] ? -1 : 1) * Number(m[3].replace(/,/g, '')) * unit;
    const tol = 0.5 * 10 ** -dec * unit + 1e-9;
    // The series of this item: found by its last value (cents or not); kept (st.map), because live QuantData writes a
    // new last value into the legend before its chart data has it (seen on the real page, probe s2).
    let hit = null;
    at.vals.forEach(([last, now], i) => {
      if (hit || last === null || now === null) return;
      for (const f of [0.01, 1, 100]) if (!hit && Math.abs(last * f - shown) <= tol) hit = { i, f };
    });
    if (hit) st.map = hit;
    else if (st.map && at.vals[st.map.i] && at.vals[st.map.i][1] !== null && at.vals.length === st.nVals) hit = st.map;
    st.nVals = at.vals.length;
    if (!hit) return null;
    const { i, f } = hit;
    const now = at.vals[i][1];
    const v = now * f;
    // QuantData's unit is for its last value: at the replay minute 1,000 K and more show as M (2026-10-18:
    // "Net 1000+ K statt M"), and so on up.
    let u = m[5];
    const UP = ['K', 'M', 'B', 'T'];
    while (UP.includes(u) && u !== 'T' && Math.abs(v) / LV_UNIT[u] >= 999.995) u = UP[UP.indexOf(u) + 1];
    const uv = LV_UNIT[u] || 1;
    const num = (Math.abs(v) / uv).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: m[3].includes(',') || Math.abs(v) / uv >= 1000 });
    return st.orig.replace(LV_RE, () => `(${v < 0 ? '-' : ''}${m[2]}${num}${m[4]}${u})`); // a function: "$1" is no pattern
  }
  function lvWrite(sp, st) {
    let t = lvNew(st);
    // No match: QuantData wrote a new last value (live, about every 2 s) that the values of the refresh do not have yet.
    // Read them again at once (before the page paints), else its live value showed for up to 400 ms (2026-10-21).
    if (!t && st.chart && LV_RE.test(st.orig)) {
      const k = st.chart.getAttribute('data-qdts-chart');
      const at = Object.fromEntries([...ocs.values()].filter((S) => S.k === k).map((S) => [S.k, ocCut(S)]).filter(([, r]) => r >= 0));
      const res = k && bridge('legendVals', { ks: [k], at });
      const x = Array.isArray(res) && res[0];
      if (x) {
        lvAt.set(st.chart, x);
        t = lvNew(st);
      }
    }
    st.mine = t;
    const want = t || st.orig;
    if (sp.textContent === want) return;
    // Into QuantData's own text node: when React writes its next value there, the observer sees it.
    const tn = sp.childNodes.length === 1 && sp.firstChild.nodeType === 3 ? sp.firstChild : null;
    if (tn) tn.nodeValue = want;
    else sp.textContent = want;
  }
  function updateLegends() {
    try {
      tagCharts();
      const cvs = [...document.querySelectorAll('canvas[data-qdts-chart]')].filter((c) => isChart(c) && c.getClientRects().length);
      const res = cvs.length ? bridge('legendVals', { ks: cvs.map((c) => c.getAttribute('data-qdts-chart')), at: Object.fromEntries([...ocs.values()].map((S) => [S.k, ocCut(S)]).filter(([, r]) => r >= 0)) }) : [];
      lvAt = new Map();
      for (const x of Array.isArray(res) ? res : []) {
        const c = document.querySelector(`canvas[data-qdts-chart="${x.k}"]`);
        if (c) lvAt.set(c, x);
      }
      for (const c of lvAt.keys()) {
        const tool = toolOf(c);
        if (!tool) continue;
        for (const sp of tool.querySelectorAll('[class*="QDChartLegendItem-module__"][class*="__name"]')) {
          if (sp.closest('[data-qdts-sd]')) continue;
          let st = lvSpans.get(sp);
          if (!st) {
            st = { orig: sp.textContent, mine: null };
            lvSpans.set(sp, st);
          } else if (sp.textContent !== st.mine && sp.textContent !== st.orig) st.orig = sp.textContent;
          st.chart = c;
          lvWrite(sp, st);
          const head = sp.parentElement && sp.parentElement.parentElement;
          if (head && !lvObserved.has(head)) {
            lvObserved.add(head);
            lvObs.observe(head, { subtree: true, childList: true, characterData: true });
          }
        }
      }
    } catch (err) {
      if (!sdErrorShown) console.warn('[QD Toolkit] legend values', err);
      sdErrorShown = true;
    }
  }

  let sdErrorShown = false;
  function drawBands() {
    try {
      drawBandsNow();
    } catch (err) {
      if (!sdErrorShown) console.warn('[QD Toolkit] σ lines', err);
      sdErrorShown = true;
    }
    drawPriceLines();
  }
  // The legends in the refresh, and soon after a zoom sync of the time (the right end moved).
  function legendsSoon() {
    setTimeout(updateLegends, 60);
    setTimeout(updateLegends, 250);
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
    // horizontal lines; 2026-10-11). A chart can be switched off in the list (cfg.sd.charts, by bar key).
    const strike = zoomBars.filter((z) => z.info && z.info.strikes && z.tool && z.tool.isConnected);
    const bars = cfg.sd.on ? strike.filter((z) => sdTicker(z) && sdSigma(sdTicker(z)) && cfg.sd.charts[z.key] !== false) : [];
    for (const z of strike) if (!bars.includes(z)) setLegend(z, null);
    if (bars.length) {
      tagCharts();
      const infos = chartsNow(true);
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
  const freezeTraces = []; // the last freeze copies: tool, start time, trace (for the report)
  // The copies live in the page DOM (not in the shadow root), so the page styles apply to the copied header and zoom bar.
  const freezeBox = document.createElement('div');
  freezeBox.id = 'qd-time-sync-freeze';
  // z-index 150: above the charts, below QuantData's menus (Mantine 200+) and its toasts.
  freezeBox.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:visible;z-index:150;pointer-events:none;';
  freezeBox.inert = true; // No focus, no clicks: they go to the page under the copy.
  const freezeStyle = document.createElement('style');
  freezeStyle.textContent = '[data-qdts-ochide] canvas[class*="nativeChartSurface-module__"] { visibility: hidden !important; } [data-qdts-ochide] [data-qdts-qdchip] { display: none !important; }' // the custom price chart
    + '#qd-time-sync-freeze, #qd-time-sync-freeze * { pointer-events: none !important; }'
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
    // A strike chart with our drawing (the fixed scale): ours must be shown, else the chart was empty for a frame after
    // the copy went (2026-10-21: "ein Flimmern"; ours waits for QuantData's draw at the new size).
    const own = [...tool.querySelectorAll('canvas.qdts-sy')].find((x) => !x.closest('#qd-time-sync-freeze'));
    if (own && own.style.visibility === 'hidden') return false;
    const c = own || [...tool.querySelectorAll('canvas')].find((x) => hasToken(x, /^nativeChartSurface-module__.*__canvas$/) && !x.closest('#qd-time-sync-freeze'));
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
    qdAliasFlush();
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
    const t0 = performance.now();
    try { return makePictureNow(tool, lite); } finally { perfAdd(lite ? 'pic' : 'copy', t0); }
  }
  function makePictureNow(tool, lite) {
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
      // The line height as a factor (QuantData sets 1.55: its 14 px title gets 21.7 px). The computed value is in px
      // (17.05 px at 11 px), and with it the title of the copy was lower and its legend 2 px higher (2026-10-21;
      // measured on the real page).
      const lh = ps && /px$/.test(ps.lineHeight) && parseFloat(ps.fontSize) > 0 ? String(Math.round((parseFloat(ps.lineHeight) / parseFloat(ps.fontSize)) * 1000) / 1000) : ps && ps.lineHeight;
      if (ps) Object.assign(wrap.style, { color: ps.color, fontFamily: ps.fontFamily, fontSize: ps.fontSize, fontWeight: ps.fontWeight, lineHeight: lh, letterSpacing: ps.letterSpacing, textShadow: ps.textShadow });
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
    // Never at the bottom: there it covers the price scale (1.14).
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

  function freezeTools(moves, targets, onlyKnown) {
    qdAliasFlush();
    if (!cfg.freeze) return;
    const tools = new Map(); // tool -> its moving sliders
    for (const el of activeSliders()) {
      const t = moves(el) && toolOf(el);
      if (t) tools.set(t, [...(tools.get(t) || []), el]);
    }
    const now = performance.now();
    for (const [tool, els] of tools) {
      // The sliders move one after the other: the "no placeholder" time counts from the move of this tool's slider.
      const watch = { els, v0: els.map((el) => read(el).value), movedAt: 0, servedAt: 0 };
      // A picture of the new minute (the picture cache): it shows at once, while QuantData loads.
      const known = targets && picShow(tool, els.map(targets));
      if (onlyKnown && !known) continue; // the preview at a click: only a picture of the new minute
      const f = freezes.get(tool);
      if (f) {
        // Still waiting for data: keep the copy of the last complete chart (or show the picture of the new minute).
        if (known) {
          picSwap(f, known);
          f.known = true;
          f.trace.push([Math.round(now - f.start), 'picture of the new minute']);
        }
        Object.assign(f, { start: now, sawLoading: false, ending: false }, watch);
        continue;
      }
      if (!known && toolLoading(tool)) continue; // No complete chart to copy.
      const pic = known || makePicture(tool);
      if (pic && known) {
        // Shown when its images are decoded (the real chart stays visible until then, no empty frame).
        pic.style.visibility = 'hidden';
        Promise.all([...pic.querySelectorAll('img')].map((i) => (i.decode ? i.decode().catch(() => {}) : null))).then(() => { pic.style.visibility = ''; });
      }
      if (pic) startFreeze(tool, pic, watch);
      if (pic && known && freezes.get(tool)) freezes.get(tool).known = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Picture cache (2026-10-26): a step to a minute that was shown before shows the picture of that minute at once,
  // while QuantData loads (QuantData waits about 300 ms before it loads). The picture of each chart with a time slider
  // is taken when its chart is complete and still (per tool, checked every 150 ms), with the option "Enable cache".
  // A picture fits only the same layout: the key has the tool, the day, the minute, the size of the chart parts, the
  // range of its zoom bars and its strike scale. Canvases are kept as compressed images (max picMax() pictures).
  // ---------------------------------------------------------------------------
  // Size of the picture cache (the list: Size), default 400.
  const picMax = () => (PIC_SIZES.includes(Number(cfg.picMax)) ? Number(cfg.picMax) : 400);
  // Max picMax() pictures per tool (tk), the oldest go first.
  function picTrim(tk) {
    const per = new Map();
    for (const e of picCache.values()) per.set(e.tk, (per.get(e.tk) || 0) + 1);
    for (const [k, v] of [...picCache]) {
      if (tk !== undefined && v.tk !== tk) continue;
      if ((per.get(v.tk) || 0) <= picMax()) continue;
      for (const u of v.urls) URL.revokeObjectURL(u);
      picCache.delete(k);
      per.set(v.tk, per.get(v.tk) - 1);
    }
  }
  const picCache = new Map(); // key -> { pic (a detached copy, canvases as <img>), urls } (Map order: the oldest first)
  const picSeen = new Map(); // tool -> { key, since }: the key must stay the same for 1 s before a picture is taken
  const picBusy = new WeakSet(); // tools whose picture is being made (async)
  const picLiveAt = new WeakMap(); // tool -> time of its last picture of the live minute
  let picStats = { taken: 0, shown: 0 };
  function picKey(tool, vals) {
    const sl = activeSliders().find((el) => toolOf(el) === tool);
    const tk = sl && sliderKeys.get(sl);
    if (!tk || vals.some((v) => isNaN(v))) return null;
    // The size of the tool, not of its chart parts: while QuantData loads, the header and the zoom bar are gone and the
    // canvas is taller (a 2nd quick click then found no picture).
    const tr = tool.getBoundingClientRect();
    if (!tr.width || !tr.height) return null;
    const size = `${Math.round(tr.width)}x${Math.round(tr.height)}`;
    const sy = [...syAt.values()].filter((x) => x.tool === tool).map((x) => JSON.stringify(sySaved(x.key) || null)).join(',');
    // Not the zoom range: QuantData fits it to the strikes of each minute (fewer strikes at 00:00), so it differs from
    // minute to minute. Your own zoom or pan on a chart removes the pictures instead (picDrop).
    return `${tk}|${toolDay(tool)}|${vals.join(',')}|${size}|${sy}|${devicePixelRatio}`;
  }
  // The new picture goes below the shown one and replaces it when its images are decoded (else 1 frame showed only
  // the background: the chart looked empty; 2026-10-26, a video of a user). The same minute: the shown picture stays.
  function picSwap(f, pic) {
    const old = f.pic;
    if (old && old.dataset.key && old.dataset.key === pic.dataset.key) return;
    f.pic = pic;
    if (!old || !old.isConnected) {
      freezeBox.appendChild(pic);
      return;
    }
    old.after(pic);
    pic.style.visibility = 'hidden';
    Promise.all([...pic.querySelectorAll('img')].map((i) => (i.decode ? i.decode().catch(() => {}) : null))).then(() => {
      pic.style.visibility = '';
      old.remove();
    });
  }
  const picHas = (tool, vals) => { const k = cfg.snap === true && picKey(tool, vals); return !!(k && picCache.has(k)); };
  // The stored picture for the target values, placed over the tool now; null when there is none.
  function picShow(tool, vals) {
    if (cfg.snap !== true) return null;
    const key = picKey(tool, vals);
    const e = key && picCache.get(key);
    if (!e) return null;
    picCache.delete(key);
    picCache.set(key, e); // used now: it goes last
    // At its place in the tool (the chart parts can be gone for a moment while QuantData loads).
    const tr = tool.getBoundingClientRect();
    const pic = e.pic.cloneNode(true);
    pic.dataset.key = key;
    Object.assign(pic.style, { left: `${tr.left + e.dx}px`, top: `${tr.top + e.dy}px` });
    picStats.shown++;
    return pic;
  }
  // In refresh(): take the pictures of the complete charts.
  function picTake() {
    const t0 = performance.now();
    try { picTakeNow(); } finally { perfAdd('picTake', t0); }
  }
  function picTakeNow() {
    if (cfg.snap !== true || virtOn || dataShown.size) return;
    const done = new Set();
    for (const el of activeSliders()) {
      const tool = toolOf(el);
      if (!tool || done.has(tool) || picBusy.has(tool)) continue;
      done.add(tool);
      // Per tool (2026-10-26: before, only when no tool loaded and 1 s after the last step, so a quick replay got few
      // pictures): its own chart complete, not covered by a copy, its slider not on its way to another minute.
      if (freezes.has(tool) || toolLoading(tool) || !chartDrawn(tool)) continue;
      if (activeSliders().some((x) => toolOf(x) === tool && virt.has(x) && virt.get(x) !== read(x).value)) continue;
      const le = liveEnd();
      const own = activeSliders().filter((x) => toolOf(x) === tool);
      // Outside RTH (09:30–16:00 ET) only with the option.
      if (cfg.picX === false && own.some((x) => isTime(read(x)) && (etOf(read(x)) < RTH_OPEN || etOf(read(x)) >= RTH_CLOSE))) continue;
      // The live minute: its picture changes with the live data, so at most every 8 s (the last one stays for later).
      const live = le !== null && own.some((x) => isTime(read(x)) && etOf(read(x)) >= le - 1);
      if (live && performance.now() - (picLiveAt.get(tool) || 0) < 8000) continue;
      const key = picKey(tool, own.map((x) => read(x).value));
      if (!key) continue;
      // Still: the same key and the same small sample of its chart canvas as 150 ms before (QuantData has drawn and
      // does not animate any more). Before (2026-10-26), a fixed 0.7 s after the load: a replay with 1 step in 1.5 s
      // got few pictures in Safari (its loads take about 1.1 s).
      const sig = picSample(tool);
      const seen = picSeen.get(tool);
      if (!seen || seen.key !== key || seen.sig !== sig) {
        picSeen.set(tool, { key, sig, since: performance.now() });
        continue;
      }
      // Once per still view, also for a key with a picture: a picture taken while the chart was not complete is
      // replaced (before, a picture of the first moment after a page load stayed).
      if (seen.taken || sig === null) continue;
      seen.taken = true;
      if (live) picLiveAt.set(tool, performance.now());
      try { dataKeep(tool); } catch (err) { console.warn('[QD Toolkit] data snapshot', err); }
      // No picture of a tool that our drawing shows from its data snapshot (the strike charts with the fixed scale):
      // virtual steps draw the data, a picture would only take memory (2026-10-28).
      if (dataHas(tool, own.map((x) => read(x).value))) {
        const old = picCache.get(key);
        if (old) { for (const u of old.urls) URL.revokeObjectURL(u); picCache.delete(key); }
        continue;
      }
      if (cfg.freeze) picStore(tool, key);
    }
  }
  // A small sample of the chart canvas of a tool (24 x 12 pixels, as text): it changes while QuantData draws.
  function picSample(tool) {
    const own = [...tool.querySelectorAll('canvas.qdts-sy')].find((x) => !x.closest('#qd-time-sync-freeze'));
    const c = own || [...tool.querySelectorAll('canvas')].find((x) => hasToken(x, /^nativeChartSurface-module__.*__canvas$/) && !x.closest('#qd-time-sync-freeze'));
    if (!c || !c.width || !c.height) return null;
    try {
      const g = sampler.getContext('2d', { willReadFrequently: true });
      g.clearRect(0, 0, 24, 12);
      g.drawImage(c, 0, 0, 24, 12);
      return Array.from(g.getImageData(0, 0, 24, 12).data).join(',');
    } catch {
      return null;
    }
  }
  // The pictures are checked every 150 ms (not only in the refresh of 400 ms).
  setInterval(() => { try { picTake(); } catch (err) { console.warn('[QD Toolkit] pictures', err); } }, 150);
  // Your zoom or pan drops the pictures only: the data snapshots are drawn in each zoom.
  function picDrop() {
    if (!picCache.size) return;
    for (const v of picCache.values()) for (const u of v.urls) URL.revokeObjectURL(u);
    picCache.clear();
    picSeen.clear();
  }
  function picStore(tool, key) {
    const pic = makePicture(tool, true);
    if (!pic) return;
    // No loading spinner in a picture: it shows the right minute, and while steps are virtual nothing loads (2026-10-26:
    // "lädt einfach unendlich lange im Eck").
    for (const sp of pic.querySelectorAll('.qdts-spin')) sp.remove();
    // No tooltip of QuantData and no synced crosshair line (our canvas qdts-xh in the chart) in a picture (2026-10-26:
    // the crosshair of the other chart was in the pictures). QuantData's own crosshair is on its overlay canvas, which
    // is not copied. So the mouse may be on a chart while a picture is taken (before, that was not allowed: with the
    // mouse on a chart, few pictures were taken, and the steps loaded from QuantData again).
    for (const n of pic.querySelectorAll('[class*="__tooltip"], [class$="_tooltip"], canvas.qdts-xh')) n.remove();
    const sl0 = activeSliders().find((x) => toolOf(x) === tool);
    const r0 = sl0 && read(sl0);
    const meta = { tk: sl0 && sliderKeys.get(sl0), day: toolDay(tool), et: r0 && isTime(r0) ? etOf(r0) : null, bytes: 0 };
    const tr = tool.getBoundingClientRect();
    const dx = parseFloat(pic.style.left) - tr.left;
    const dy = parseFloat(pic.style.top) - tr.top;
    picBusy.add(tool);
    const urls = [];
    // The same order as in the copy (without the removed crosshair canvases).
    const src = chartParts(tool).flatMap((p) => [...p.querySelectorAll('canvas')].filter((c) => !c.classList.contains('qdts-xh')));
    const jobs = [...pic.querySelectorAll('canvas')].map((c, i) => new Promise((ok) => {
      const s0 = src[i];
      // QuantData's crosshair layer and a canvas without pixels are dropped.
      if (!c.width || !c.height || !s0 || hasToken(s0, /overlayCanvas$/)) { c.remove(); ok(); return; }
      const cw = s0.offsetWidth;
      const ch = s0.offsetHeight;
      c.toBlob((b) => {
        if (!b) { ok(); return; }
        const url = URL.createObjectURL(b);
        urls.push(url);
        meta.bytes += b.size;
        const img = document.createElement('img');
        img.className = c.className;
        img.style.cssText = c.style.cssText;
        img.style.width = `${cw}px`; // the size on the page (the canvas pixels can differ: dpr, QuantData's own scale)
        img.style.height = `${ch}px`;
        img.src = url;
        c.replaceWith(img);
        ok();
      }, 'image/webp', 0.85);
    }));
    Promise.all(jobs).then(() => {
      picBusy.delete(tool);
      const old = picCache.get(key);
      if (old) for (const u of old.urls) URL.revokeObjectURL(u);
      picCache.delete(key);
      picCache.set(key, { pic, urls, dx, dy, ...meta });
      picStats.taken++;
      picTrim(meta.tk);
    }, () => picBusy.delete(tool));
  }
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
  // The snapshot cache answered a tool from memory (bridge.js): its new chart comes at once, without QuantData's loading
  // placeholder, so its freeze copy goes after about 120 ms (2026-10-24; before: 700 ms after its slider moved).
  document.addEventListener('qdts:snapserved', (e) => {
    const id = String(e.detail || '');
    for (const [tool, f] of freezes) {
      if (!f.els.some((el) => (sliderKeys.get(el) || '').startsWith(`tool:${id}|`))) continue;
      f.servedAt = performance.now();
      setTimeout(() => checkFreeze(tool), 130);
    }
  });
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
  // so no message of the panel there reaches this tab (2026-10-11: Play in Safari on the large screen, the same
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
    if (!f || f.ending || f.hold) return; // held: a virtual step shows its picture (virtCommit)
    // More steps wait (quick clicks): the load of a minute in between does not show; the copy stays until the
    // load of the last minute (2026-10-27: after 5 quick steps the chart showed step 1 until step 5 was there).
    if (virtTimer && pendingSteps) return;
    if (freezeMoved(tool)) {
      f.trace.push([Math.round(performance.now() - f.start), 'tool moved']);
      unfreeze(tool);
      return;
    }
    const age = performance.now() - f.start;
    const loading = toolLoading(tool);
    if (loading && !f.sawLoading) f.trace.push([Math.round(age), 'loading']);
    if (loading) f.sawLoading = true;
    // The placeholder must stay away for 150 ms: after quick steps QuantData loads 2 times, with a short gap between
    // (2026-10-26, Safari: the placeholder showed for 40 ms after the copy went).
    if (loading) f.idleAt = 0;
    else if (f.sawLoading && !f.idleAt) f.idleAt = performance.now();
    // Only for a picture of the new minute (it shows the right data; an old copy goes at once, as before).
    // Max time: 20 s for a picture of the new minute, 10 s for a copy of the old one (QuantData took 8 s once).
    const maxAge = f.known ? 20000 : 10000;
    if (f.known && f.sawLoading && !loading && performance.now() - f.idleAt < 150 && age < maxAge) {
      // exactly when the 150 ms are over (before: a fixed 160 ms more; 2026-10-28: the copy stayed a bit too long)
      setTimeout(() => checkFreeze(tool), Math.max(10, 152 - (performance.now() - f.idleAt)));
      return;
    }
    if (!f.movedAt && f.els.some((el, i) => read(el).value !== f.v0[i])) {
      f.movedAt = performance.now();
      f.trace.push([Math.round(age), 'slider moved']);
    }
    // Done: the placeholder came and went, or no placeholder came in 700 ms after the slider moved,
    // or the slider did not move in 2 s, or 6 s passed.
    const done = !tool.isConnected || (f.sawLoading && !loading) || age > maxAge
      || (!f.sawLoading && f.servedAt && performance.now() - f.servedAt > 120)
      || (!f.sawLoading && (f.movedAt ? performance.now() - f.movedAt > 700 : age > 2000));
    if (!done) return;
    f.ending = true;
    f.trace.push([Math.round(age), f.sawLoading ? 'loaded' : age > maxAge ? 'timeout' : f.servedAt ? 'from memory' : 'no loading placeholder']);
    // Loaded: remove the copy in the first frame in which the new chart has pixels (max 600 ms). Else at once.
    // A picture of the new minute stays until the chart is still (2 equal samples 100 ms apart, max 1.5 s): QuantData
    // draws new data with a short animation (the bars grow), and without this the chart looked empty for a moment
    // (2026-10-26: "ganz kurz nichts zu sehen und dann die Balken").
    const t0 = performance.now();
    const until = t0 + (f.sawLoading && !loading ? 600 : 0);
    let last = null;
    let lastAt = 0;
    const tick = () => {
      if (!f.ending) return;
      const now = performance.now();
      const drawn = now >= until || chartDrawn(tool);
      if (drawn && f.known && now - t0 < 1500) {
        if (now - lastAt >= 50) { // 2 equal samples 50 ms apart (before 100 ms; QuantData's bars change in each frame while they grow)
          const sig = picSample(tool);
          if (sig === null || sig !== last) {
            last = sig;
            lastAt = now;
            requestAnimationFrame(tick);
            return;
          }
        } else {
          requestAnimationFrame(tick);
          return;
        }
      }
      if (drawn) unfreeze(tool);
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
    if (xSelf && xPt) selfXhair(xPt.el instanceof HTMLCanvasElement ? xPt.el : null, xPt); // QuantData's crosshair again where it shows
    lastFreezeTrace = { trace: f.trace };
    dlog('freeze', { tool: headTitle(tool).slice(0, 40), known: !!f.known, trace: f.trace });
    freezeTraces.push({ tool: headTitle(tool).slice(0, 40), at: Math.round(f.start), trace: f.trace });
    if (freezeTraces.length > 8) freezeTraces.shift();
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
      tool: `QD Toolkit ${QDTS_VERSION}`,
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
      freeze: { on: !!cfg.freeze, active: freezes.size, last: lastFreezeTrace, recent: freezeTraces },
      sy: { on: syOn(), charts: [...syAt].map(([k, x]) => ({ k, key: x.key, plot: x.info ? x.info.plot : null, auto: x.auto || null, saved: sySaved(x.key) || null })), lastDown: syLastDown },
      // The snapshot cache: counts and the last events (page time in ms, like the freeze "at").
      snap: (() => { const r = bridge('snap', { log: true }); return r && r.ok ? r : null; })(),
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
    optSnap.checked = cfg.snap === true;
    optDlog.checked = !!cfg.dlog;
    optPicX.checked = cfg.picX !== false;
    for (const b of picMaxEl.querySelectorAll('button')) b.classList.toggle('on', Number(b.dataset.v) === picMax());
    optLocal.checked = !!cfg.localTime;
    optH24.checked = cfg.h24 !== false;
    timeEl.title = `Type a time (for example ${cfg.localTime ? '16:45' : '10:45'}) and press Enter. All sliders go to this time.${cfg.localTime ? ' The time of your computer; with ET after it, New York time.' : ' New York time (ET).'}`;
  }

  function refresh() {
    const t0 = performance.now();
    try { refreshNow(); } finally { perfAdd('refresh', t0); }
  }
  function refreshNow() {
    qdAliasFlush();
    dlogTick();
    if (virtOn) virtThumbs(); // React can render the sliders again (live data)
    if (wantLive && !working) resumeAll(null); // a tool went back to "historical" (a new expiration, a reload of it)
    mount(); // The page removed the panel, or the header came or went: put it in its place again.
    scan();
    snapMarks();
    updateLegends();
    ocRefresh();
    syRefresh();
    const sl = activeSliders();
    for (const n of root.querySelectorAll('.n')) n.textContent = String(sl.length);
    root.querySelector('.count').classList.toggle('zero', sl.length === 0);

    const ref = refSlider();
    const editing = root.activeElement === timeEl;
    if (ref) {
      const r = readV(ref);
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
    if (!list.hidden) {
      showBudget();
      updatePanes();
      updateGapOut();
    }
    showBudgetBar();
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
  optDlog.addEventListener('change', () => {
    cfg.dlog = optDlog.checked;
    saveCfg();
    dlog('log on', { ua: navigator.userAgent.slice(0, 120), w: innerWidth, h: innerHeight, dpr: devicePixelRatio, path: location.pathname });
  });
  optPicX.addEventListener('change', () => {
    cfg.picX = optPicX.checked;
    saveCfg();
  });
  $('.pic-clear').addEventListener('click', (e) => {
    dlog('clear', {});
    const b = e.currentTarget;
    b.textContent = 'Cleared';
    setTimeout(() => { b.textContent = 'Clear cache'; }, 1200);
    picDrop();
    dataIdx.clear();
    bridge('snap', { clear: true });
    picOvSig = '';
    picOverview();
    showBudget();
  });
  picMaxEl.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    cfg.picMax = Number(b.dataset.v);
    saveCfg();
    picTrim();
    // the data snapshots of each tool too
    const per = new Map();
    for (const e of dataIdx.values()) per.set(e.tk, (per.get(e.tk) || 0) + 1);
    for (const [k, e] of [...dataIdx]) {
      if ((per.get(e.tk) || 0) <= picMax()) continue;
      dataIdx.delete(k);
      bridge('syDrop', { key: k });
      per.set(e.tk, per.get(e.tk) - 1);
    }
    snapMarks(); // the loaded data of the bridge (its limit per tool)
    render();
    picOverview();
  });
  optSnap.addEventListener('change', () => {
    cfg.snap = optSnap.checked;
    saveCfg();
    render();
    snapMarks();
    showBudget();
  });

  optLocal.addEventListener('change', () => {
    cfg.localTime = optLocal.checked;
    saveCfg();
    render();
    refresh();
    updateListValues();
  });
  $('.gen-ver').textContent = QDTS_VERSION;
  for (const el of root.querySelectorAll('.dev-only')) el.hidden = !QDTS_DEV; // the public build: no Debug log
  if (!QDTS_DEV && cfg.dlog) { cfg.dlog = false; saveCfg(); }
  $('.gen-copy').addEventListener('click', (e) => {
    const b = e.currentTarget;
    const label = b.textContent;
    const done = () => { b.textContent = 'Copied'; setTimeout(() => { b.textContent = label; }, 1500); };
    try { navigator.clipboard.writeText(b.dataset.copy).then(done, () => {}); } catch { /* no clipboard: the name is shown */ }
  });
  const lzEl = $('.lz');
  const syncLz = () => { for (const b of lzEl.querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === (LIST_ZOOMS[cfg.listZoom] ? cfg.listZoom : 'm')); };
  syncLz();
  lzEl.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    cfg.listZoom = b.dataset.v;
    saveCfg();
    syncLz();
    placeList(); // the new size in the middle again
    onbEl.style.setProperty('--onb-z', String(listZoom()));
  });

  // ---------------------------------------------------------------------------
  // Setup (onboarding, 2026-10-28): at the first start, a window with the features in steps. Each step has a picture
  // or a short video (from the public repo; without a network a placeholder) and the switches of the list for it: a
  // switch here clicks the one in the list, so its own code runs and the list shows the same. Skip, Back / Next,
  // the dots. General › "Setup guide". After an update: "What's new" (once per version) for the users of before.
  // ---------------------------------------------------------------------------
  const ONB_MEDIA = 'https://raw.githubusercontent.com/julianhtg/qd-toolkit/main/docs/onboarding/';
  // The developer build first tries a server on this computer (python3 -m http.server 8766 -d docs/onboarding), so
  // new pictures show before they are in the public repo.
  const ONB_LOCAL = 'http://127.0.0.1:8766/';
  const MOD = /Mac/i.test(navigator.platform) ? '⌘' : 'Ctrl';
  // [kind, selector in the list, label, info text (the "i")]
  const ONB_STEPS = [
    { tag: 'Welcome', title: 'Backtest replay for QuantData', media: 'welcome.webp', icon: '⏱',
      text: '<p>One time slider for all your charts. Step through any session, minute by minute.</p><p>Choose your features in a few steps. You can change them anytime in the menu.</p>',
      ctl: [['btns', '.lz', 'Menu size'], ['sw', '.opt-local', 'Local time', 'Times in your time zone instead of New York time (ET).'], ['sw', '.opt-h24', '24-hour clock']] },
    { tag: 'Replay', title: 'Step through the session', media: 'replay.webp', icon: '▶',
      text: `<p>Easily step through the session with keyboard shortcuts or the buttons of the panel.</p><div class="onb-keys">`
        + `<span>1 minute</span><span><kbd>←</kbd> <kbd>→</kbd></span><span>5 minutes</span><span><kbd>⇧</kbd> + <kbd>←</kbd> <kbd>→</kbd></span>`
        + `<span>Start / end</span><span><kbd>${MOD}</kbd> + <kbd>←</kbd> <kbd>→</kbd></span><span>Play / pause</span><span><kbd>-</kbd></span></div>`,
      ctl: [['press', '.bar .rth', 'RTH', 'Replay only the regular session, 09:30–16:00 ET.']] },
    { tag: 'Cache', rec: true, beta: true, title: 'Instant steps, fewer requests', media: 'cache.webp', icon: '⚡',
      text: '<p>Minutes you already loaded open instantly and use none of your request limit.</p>',
      ctl: [['sw', '.opt-snap', 'Enable cache', 'Keeps the loaded minutes in memory until you reload the page.'], ['btns', '.pic-max', 'Cache size (minutes)', 'How many minutes per chart stay in memory. A whole day needs more memory.']] },
    { tag: 'Display', title: 'Calm charts, no future', media: 'display.webp', icon: '◐',
      text: '<p>No loading text, no flicker, no peek into the future.</p>',
      ctl: [['sw', '.opt-freeze', 'Hold chart while loading', 'While QuantData loads a new minute, each chart keeps its last picture instead of the loading text.'], ['sw', '.opt-mask', 'Hide the future', 'Covers the mini chart of the zoom bars after the replay minute.']] },
    { tag: 'Price chart', title: 'A price chart for backtesting', media: 'pricechart.webp', icon: '▮',
      text: '<p>Replaces the Stock Price / Time chart: candles up to the replay minute, free pan and zoom, price lines and a position tool.</p><p>Drag a scale to zoom it. Double-click it for the automatic scale again.</p>',
      ctl: [['sw', '.opt-oc', 'Custom price chart'], ['btns', '.pc-type', 'Type'], ['btns', '.pc-n', 'Interval', 'Built from the 1-minute candles, so a candle never shows the future.'], ['sw', '.opt-trade', 'Trade buttons', 'Buy and sell at the replay price, for paper trading.']] },
    { tag: 'Linking', title: 'Strike charts that move together', media: 'linking.webp', icon: '⇄',
      text: '<p>Zoom or scroll one strike chart, and the charts of the same ticker follow.</p>',
      ctl: [['sw', '.opt-xhair', 'Shared crosshair', 'The same strike or time shows as a dashed line in the other charts.'], ['sw', '.opt-sy', 'Draggable value scale', 'The value axis of the strike charts stays fixed. Drag it to change the range, double-click it for the automatic range. Needed for instant steps from the cache.']] },
    { tag: 'Indicators', title: 'σ lines and the overnight gap', media: 'indicators.webp', icon: 'σ',
      text: '<p>The standard deviation lines (the 15.87 rule) show the expected move of the day around the prior close. The gap box shows the overnight gap and how much of it is filled.</p><p>For the VIX value, add the second userscript "QD Toolkit Data".</p>',
      ctl: [['sw', '.opt-sd', 'σ lines on the strike charts'], ['sw', '.opt-sdprice', 'σ lines on the price chart'], ['sw', '.opt-gap', 'Gap close']] },
    { tag: 'Done', title: 'Thanks for using QD Toolkit!', media: 'thanks.webp', icon: '♥', cards: true,
      text: '<p>You are all set. Happy backtesting!</p>', ctl: [] },
  ];
  // What's new: per version, for the users of before (once).
  const ONB_NEWS = {
    '1.1': ['Cache: minutes you already loaded open instantly and use none of your request limit', 'Custom configurable price chart with candles and lines', 'Position tool for paper trading and backtesting', 'σ lines and the overnight gap on the price chart', 'A new, better looking menu', 'Many more quality-of-life changes'],
  };
  const onbEl = $('.onb');
  const onbBack = $('.onb-back');
  let onbStep = 0;
  let onbMode = 'setup'; // or 'news'
  const onbOpen = () => !onbEl.hidden;
  function onbCtl(c) {
    const [kind, sel, label, info] = c;
    const src = root.querySelector(`.list ${sel}`) || root.querySelector(sel);
    const row = document.createElement('div');
    row.className = 'opt';
    const name = document.createElement('span');
    name.textContent = label;
    if (info) {
      const i = document.createElement('i');
      i.className = 'onb-i';
      i.textContent = 'i';
      i.dataset.tip = info;
      // the tip in the window, above the icon (not in the side column: there the picture covered it)
      i.addEventListener('mouseenter', () => {
        const tip = $('.onb-tip');
        tip.textContent = info;
        tip.hidden = false;
        const z = listZoom();
        const ob = onbEl.getBoundingClientRect();
        const ib = i.getBoundingClientRect();
        const x = (ib.left + ib.width / 2 - ob.left) / z - tip.offsetWidth / 2;
        const y = (ib.top - ob.top) / z - tip.offsetHeight - 8;
        tip.style.left = `${Math.max(8, Math.min(onbEl.offsetWidth - tip.offsetWidth - 8, x))}px`;
        tip.style.top = `${Math.max(8, y)}px`;
      });
      i.addEventListener('mouseleave', () => { $('.onb-tip').hidden = true; });
      name.append(i);
    }
    row.append(name);
    if (!src) return null;
    if (kind === 'sw' || kind === 'press') {
      const sw = document.createElement('input');
      sw.type = 'checkbox';
      sw.className = 'sw';
      const isOn = () => (kind === 'sw' ? src.checked : src.getAttribute('aria-pressed') === 'true' || src.classList.contains('on'));
      sw.checked = isOn();
      sw.addEventListener('change', () => { src.click(); setTimeout(() => { sw.checked = isOn(); }, 50); });
      row.addEventListener('click', (e) => { if (e.target !== sw) { sw.click(); } });
      row.append(sw);
    } else {
      const grp = document.createElement('span');
      grp.className = 'sd-lv';
      const sync = () => { for (const b of grp.children) b.classList.toggle('on', !!src.querySelector(`button[data-v="${b.dataset.v}"].on`)); };
      for (const b0 of src.querySelectorAll('button[data-v]')) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.v = b0.dataset.v;
        b.textContent = b0.textContent;
        b.addEventListener('click', () => { b0.click(); setTimeout(sync, 50); });
        grp.append(b);
      }
      sync();
      row.append(grp);
    }
    return row;
  }
  function onbShow() {
    const st = onbMode === 'news' ? null : ONB_STEPS[onbStep];
    $('.onb-tip').hidden = true;
    const media = $('.onb-media');
    const side = { tag: $('.onb-tag'), title: $('.onb-title'), text: $('.onb-text'), ctl: $('.onb-ctl') };
    media.textContent = '';
    side.ctl.textContent = '';
    const ph = (icon) => { const d = document.createElement('div'); d.className = 'ph'; d.innerHTML = `<b>${icon}</b><span>QD Toolkit</span>`; return d; };
    // a picture or a video of the step: local first (the developer build), then the public repo, else a placeholder
    const showMedia = (file, icon) => {
      const img = document.createElement('img');
      img.alt = '';
      img.onload = () => img.classList.add('ok');
      const srcs = [...(QDTS_DEV ? [ONB_LOCAL + file] : []), ONB_MEDIA + file];
      img.onerror = () => {
        if (!img.isConnected) return; // a later step can be shown already
        if (srcs.length) { img.src = srcs.shift(); return; }
        img.remove();
        media.append(ph(icon));
      };
      media.append(img);
      if (!QDTS_DEV) { img.src = srcs.shift(); return; }
      // the developer build: through QD Toolkit Data (Safari does not load an http picture into the https page)
      srcs.shift();
      const id = `m${Math.random().toString(36).slice(2)}`;
      let done = false;
      const onRes = (ev) => {
        let r;
        try { r = JSON.parse(ev.detail); } catch { return; }
        if (!r || r.id !== id) return;
        done = true;
        document.removeEventListener('qdts:media-res', onRes);
        if (!img.isConnected) return;
        if (r.url) img.src = r.url;
        else img.src = srcs.shift();
      };
      document.addEventListener('qdts:media-res', onRes);
      document.dispatchEvent(new CustomEvent('qdts:media-req', { detail: JSON.stringify({ id, file }) }));
      setTimeout(() => { if (!done && img.isConnected) { document.removeEventListener('qdts:media-res', onRes); img.src = srcs.shift(); } }, 3000);
    };
    if (onbMode === 'news') {
      side.tag.textContent = `What's new in ${QDTS_VERSION}`;
      side.title.textContent = 'QD Toolkit got an update';
      side.text.innerHTML = `<ul class="news">${(ONB_NEWS[QDTS_VERSION] || []).map((x) => `<li>${x}</li>`).join('')}</ul>`;
      showMedia('thanks.webp', '✦'); // the logo picture (the page picture looked cut)
      $('.onb-dots').textContent = '';
      $('.onb-skip').hidden = false;
      $('.onb-prev').textContent = 'Close';
      $('.onb-next').textContent = 'Open the setup guide';
      return;
    }
    side.tag.innerHTML = `${onbStep + 1} / ${ONB_STEPS.length} · ${st.tag}${st.beta ? '<span class="beta">Beta</span>' : ''}${st.rec ? '<span class="rec">Recommended</span>' : ''}`;
    side.title.textContent = st.title;
    side.text.innerHTML = st.text;
    if (st.media) showMedia(st.media, st.icon);
    else media.append(ph(st.icon));
    for (const c of st.ctl) { const r = onbCtl(c); if (r) side.ctl.append(r); }
    if (st.cards) {
      const cards = root.querySelector('.list .gen-cards').cloneNode(true);
      const cp = cards.querySelector('.gen-copy');
      if (cp) cp.addEventListener('click', () => {
        root.querySelector('.list .gen-copy').click();
        const label = cp.textContent;
        cp.textContent = 'Copied';
        setTimeout(() => { cp.textContent = label; }, 1500);
      });
      side.ctl.append(cards);
    }
    const dots = $('.onb-dots');
    dots.textContent = '';
    ONB_STEPS.forEach((_, i) => {
      const d = document.createElement('i');
      d.className = i === onbStep ? 'on' : '';
      d.addEventListener('click', () => { onbStep = i; onbShow(); });
      dots.append(d);
    });
    $('.onb-prev').textContent = 'Back';
    $('.onb-prev').style.visibility = onbStep ? '' : 'hidden';
    $('.onb-next').textContent = onbStep === ONB_STEPS.length - 1 ? 'Done' : 'Next';
    $('.onb-skip').hidden = onbStep === ONB_STEPS.length - 1; // nothing to skip at the end
  }
  function onbStart(mode = 'setup') {
    if (!list.hidden) openList(false);
    // the states of the list controls (they are set when the list opens): the setup shows them
    render();
    syncChartOpts();
    onbMode = mode;
    onbStep = 0;
    onbEl.style.setProperty('--onb-z', String(listZoom())); // Menu size S / M / L
    onbEl.hidden = false;
    onbBack.hidden = false;
    $('.onb-prev').style.visibility = '';
    // 1 height for all steps (like the list): the highest step, measured once
    const main = $('.onb-main');
    main.style.minHeight = '';
    let h = 0;
    if (mode === 'setup') {
      for (let i = 0; i < ONB_STEPS.length; i++) { onbStep = i; onbShow(); h = Math.max(h, main.offsetHeight); }
      onbStep = 0;
    }
    onbShow();
    if (h) main.style.minHeight = `${h}px`;
  }
  function onbClose() {
    onbEl.hidden = true;
    onbBack.hidden = true;
    cfg.onb = { ...(cfg.onb || {}), done: true, news: QDTS_VERSION };
    saveCfg();
  }
  $('.onb-skip').addEventListener('click', onbClose);
  $('.onb-next').addEventListener('click', () => {
    if (onbMode === 'news') return onbStart('setup');
    if (onbStep < ONB_STEPS.length - 1) { onbStep++; onbShow(); } else onbClose();
  });
  $('.onb-prev').addEventListener('click', () => {
    if (onbMode === 'news') return onbClose();
    if (onbStep > 0) { onbStep--; onbShow(); }
  });
  onbBack.addEventListener('click', (e) => e.stopPropagation()); // a click outside does not close the setup
  window.addEventListener('keydown', (e) => {
    if (!onbOpen() || !e.isTrusted) return;
    // While the setup is open, the keys are for it: no steps, no Play (the arrows go through the steps).
    e.stopImmediatePropagation();
    if (e.key === 'Escape') onbClose();
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      $(e.key === 'ArrowRight' ? '.onb-next' : '.onb-prev').click();
    }
  }, true);
  $('.gen-onb').addEventListener('click', () => onbStart('setup'));
  $('.gen-news').addEventListener('click', () => onbStart('news'));
  // The first start: the setup; a user of before after an update: What's new (once). Not in the tests (a flag in
  // localStorage, set by tests/common.py).
  setTimeout(() => {
    let noOnb = false;
    try { noOnb = localStorage.getItem('qdTimeSync.noOnb') === '1'; } catch { /* no storage */ }
    if (noOnb || onbOpen()) return;
    const o = cfg.onb || {};
    if (!o.done && !hadCfg) onbStart('setup');
    else if (o.news !== QDTS_VERSION && ONB_NEWS[QDTS_VERSION]) onbStart('news');
  }, 1500);
  optH24.addEventListener('change', () => {
    cfg.h24 = optH24.checked;
    saveCfg();
    cwSoon();
  });
  // The settings of the price charts in the list (2026-10-22: before in the menu of the pill "Lines").
  const chartPane = list.querySelector('[data-pane="charts"]');
  function syncChartOpts() {
    const pc = plCfg();
    const gc = ocGrid();
    const on = (sel, v) => { for (const b of chartPane.querySelectorAll(`${sel} button`)) b.classList.toggle('on', String(b.dataset.v) === String(v)); };
    chartPane.querySelector('.pc-ohlc').checked = cfg.ocOhlc !== false;
    chartPane.querySelector('.pc-pline').checked = cfg.ocPriceLine !== false;
    on('.pc-n', ocN());
    on('.pc-type', cfg.ocLine ? 'line' : 'candle');
    on('.pc-grid', gc.show);
    on('.pc-gs', gc.style);
    on('.pc-go', gc.op);
    on('.pl-w', pc.w);
    on('.pl-s', pc.step);
    chartPane.querySelector('.pl-fit').checked = !!pc.fit;
    chartPane.querySelector('.pl-day').checked = !!pc.dayOnly;
    const own = (sel, v) => { const f = chartPane.querySelector(sel); if (root.activeElement !== f) f.value = String(v); };
    own('.pc-gop', gc.op);
    own('.pl-nw', pc.w);
    for (const sel of ['.pc-n', '.pc-type', '.pc-grid', '.pc-gs', '.pc-go']) chartPane.querySelector(sel).classList.toggle('off', !ocOn());
  }
  function chartOptsChanged() {
    saveCfg();
    plScanAt = -Infinity;
    drawPriceLines();
    cwSoon();
    syncChartOpts();
  }
  chartPane.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    const grp = b && b.parentElement;
    if (!grp) return;
    const v = b.dataset.v;
    if (grp.classList.contains('pc-n')) cfg.ocN = Number(v);
    else if (grp.classList.contains('pc-type')) cfg.ocLine = v === 'line';
    else if (grp.classList.contains('pc-grid')) cfg.ocGrid = { ...ocGrid(), show: v };
    else if (grp.classList.contains('pc-gs')) cfg.ocGrid = { ...ocGrid(), style: v };
    else if (grp.classList.contains('pc-go')) cfg.ocGrid = { ...ocGrid(), op: Number(v) };
    else if (grp.classList.contains('pl-w')) return setPlWidth(Number(v)), syncChartOpts();
    else if (grp.classList.contains('pl-s')) cfg.pl = { ...plCfg(), step: Number(v) };
    else return;
    chartOptsChanged();
  });
  chartPane.addEventListener('change', (e) => {
    const c = e.target.classList;
    const num = (x) => Number(String(x).replace(',', '.'));
    if (c.contains('pc-ohlc')) cfg.ocOhlc = e.target.checked;
    else if (c.contains('pc-pline')) cfg.ocPriceLine = e.target.checked;
    else if (c.contains('pl-fit')) cfg.pl = { ...plCfg(), fit: e.target.checked };
    else if (c.contains('pl-day')) cfg.pl = { ...plCfg(), dayOnly: e.target.checked };
    else if (c.contains('pc-gop')) {
      const v = Math.round(num(e.target.value));
      if (!(v >= 0)) return;
      cfg.ocGrid = { ...ocGrid(), op: Math.min(100, v) };
    } else if (c.contains('pl-nw')) {
      const w = num(e.target.value);
      if (!(w > 0)) return;
      setPlWidth(Math.min(50, Math.round(w * 100) / 100));
      return syncChartOpts();
    } else return;
    chartOptsChanged();
  });
  optSdPrice.addEventListener('change', () => {
    cfg.sd = { ...cfg.sd, price: optSdPrice.checked };
    saveCfg();
    cwSoon();
  });
  optTrade.addEventListener('change', () => {
    cfg.tradeOn = optTrade.checked;
    saveCfg();
    plScanAt = -Infinity;
    drawPriceLines();
    cwSoon();
  });
  optSy.addEventListener('change', () => {
    cfg.syOn = optSy.checked;
    saveCfg();
    syRefresh();
    drawBands();
  });
  optOc.addEventListener('change', () => {
    cfg.ownChart = optOc.checked;
    saveCfg();
    ocRefresh();
    syRefresh();
    plScanAt = -Infinity;
    drawPriceLines();
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
      if (!e.isTrusted || e.altKey) return;
      if (isTyping(e.composedPath()[0])) return;
      if (!activeSliders().length) return;
      // Cmd (Mac) or Ctrl + arrow: to the start or the end, like the buttons (2026-10-26).
      const jump = (e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight');
      if ((e.ctrlKey || e.metaKey) && !jump) return;

      let run = null;
      if (jump) run = () => act.edge(e.key === 'ArrowLeft' ? 'start' : 'end');
      else if (e.key === '.') run = () => act.step(1);
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
    data: () => [...dataIdx.keys()],
    picKey: (v) => { const el = activeSliders()[0]; return picKey(toolOf(el), [v]); },
    virt: () => [...virt].map(([el, v]) => [read(el).value, v]),
    pics: (px) => ({ n: picCache.size, ...picStats, seen: [...picSeen.values()].map((x) => x.key.slice(0, 120)),
      keys: [...picCache].map(([k, e]) => { const img = e.pic.querySelector('img'); let c = null;
        if (Array.isArray(px) && img && img.complete && img.naturalWidth) { const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight; const g = cv.getContext('2d'); g.drawImage(img, 0, 0); c = [...g.getImageData(px[0], px[1], 1, 1).data].slice(0, 3); }
        return [px === 'full' ? k : k.split('|').slice(0, 4).join('|'), c]; }) }),
    budget: () => ({ free: budgetNow(), cost: stepCost(), waitMs: Math.max(0, budgetWaitUntil - performance.now()) }),
    zoom: () => zoomBars.map((z) => ({ title: z.title, key: z.key, applied: z.applied, touched: z.touched, status: z.status, info: z.info, left: leftEt.get(z.key) })),
    bridge: (op, args) => bridge(op, args),
    sd: () => ({ following: !!followRaf, auto: sdAuto, error: sdErrorShown }),
    link: () => [...linkGroups.values()].map((g) => ({ id: g.id, label: g.label, range: linkRange.get(g.id) || null,
      charts: g.all.map((z) => ({ title: z.title, key: z.key, linked: linked(z), sv: z.info && z.info.sv, set: linkSet.get(z.key) || null })) })),
  };
})();
