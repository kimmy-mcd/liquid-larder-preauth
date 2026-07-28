/* ===========================================================================
   Liquid & Larder — hub motion layer  (v1, 28 Jul 2026)
   Paired with the "v6 — motion layer" block in /styles/hub.css.

   Applied automatically, no page changes needed:
     · KPI values count up on first render and flash green when they change
     · a soft spotlight follows the cursor inside home-page tiles
     · sparklines draw themselves left to right
     · action buttons show press → spinner → tick, and outcomes slide in as
       a toast (see "action feedback bridge" below)

   Available to page code as window.LL:
     LL.toast(msg, {err:true})     → slide-in confirmation, auto-dismisses
     LL.busy(button)               → press → spinner → tick; returns {done, fail}
     LL.flash(el)                  → one green wash over an element
     LL.countUp(el, to)            → ease a number to a new value

   Every effect is skipped when the browser reports prefers-reduced-motion,
   and nothing here throws if the markup it expects isn't on the page.
   =========================================================================== */
(function () {
  'use strict';

  var RM = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var LL = window.LL = window.LL || {};

  /* Every MutationObserver we create is pushed here and the array is hung off
     window.LL. An observer with no reference held anywhere is eligible for
     garbage collection even while it still has registered observations, and
     Chrome does collect them on a busy page — which silently stopped the
     document-level watcher on the live home page. Hold the references. */
  var OBSERVERS = LL._observers = [];

  /* ---------- number parsing -------------------------------------------
     Handles "412", "31.4", "$1,240", "-2.4", each optionally wrapped in
     prefixes/suffixes, and leaves any <small>/<span> unit siblings alone. */
  function parseVal(txt) {
    var m = String(txt).match(/^(\D*?)(-?\d[\d,]*(?:\.\d+)?)(\D*)$/);
    if (!m) return null;
    var raw = m[2], num = parseFloat(raw.replace(/,/g, ''));
    if (!isFinite(num)) return null;
    return { pre: m[1], post: m[3], num: num,
             dp: (raw.split('.')[1] || '').length,
             comma: raw.indexOf(',') > -1 };
  }
  function fmt(v, s) {
    var body = s.comma
      ? v.toLocaleString('en-AU', { minimumFractionDigits: s.dp, maximumFractionDigits: s.dp })
      : v.toFixed(s.dp);
    return s.pre + body + s.post;
  }
  function firstNumNode(el) {
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3 && /\d/.test(n.nodeValue)) return n;
    }
    return null;
  }

  /* ---------- easing ---------------------------------------------------- */
  function ease(p) { return p === 1 ? 1 : 1 - Math.pow(2, -10 * p); }

  function animateNode(node, from, to, shape, dur, onEnd) {
    var t0 = null;
    function frame(t) {
      if (t0 === null) t0 = t;
      var p = Math.min(1, (t - t0) / dur);
      node.nodeValue = fmt(from + (to - from) * ease(p), shape);
      if (p < 1) requestAnimationFrame(frame); else if (onEnd) onEnd();
    }
    requestAnimationFrame(frame);
  }

  /* ---------- public: flash --------------------------------------------- */
  LL.flash = function (el) {
    if (!el || RM) return;
    el.classList.remove('ll-flash');
    void el.offsetWidth;                       // restart the animation
    el.classList.add('ll-flash');
    setTimeout(function () { el.classList.remove('ll-flash'); }, 1000);
  };

  /* ---------- public: countUp ------------------------------------------- */
  LL.countUp = function (el, to, dur) {
    if (!el) return;
    var node = firstNumNode(el);
    if (!node) return;
    var shape = parseVal(node.nodeValue.trim());
    if (!shape) return;
    if (RM) { node.nodeValue = fmt(to, shape); return; }
    animateNode(node, shape.num, to, shape, dur || 900);
  };

  /* ---------- KPI count-up + change flash -------------------------------
     Values are remembered per container + label, so a re-render (period
     change, filter change) animates from the old figure and only flashes the
     cards that actually moved. */
  var MEM = {};

  function labelOf(card) {
    var lab = card.querySelector('.k, .lab, .kpiLabel');
    return lab ? lab.textContent.trim().slice(0, 60) : '';
  }

  function processKpis(box) {
    var boxKey = box.id || box.className || 'kpis';
    var cards = box.querySelectorAll('.kpi');
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var vEl = card.querySelector('.v, .val');
      if (!vEl || vEl.dataset.llAnim === '1') continue;

      var node = firstNumNode(vEl);
      if (!node) continue;
      var shape = parseVal(node.nodeValue.trim());
      if (!shape) continue;

      var key = boxKey + '|' + (labelOf(card) || i);
      var prev = MEM[key];
      MEM[key] = shape.num;
      if (RM || prev === shape.num) continue;

      var from = prev === undefined ? 0 : prev;
      var dur = prev === undefined ? 900 : 620;
      if (prev !== undefined) LL.flash(vEl);

      (function (el, n, f, t, s, d) {
        el.dataset.llAnim = '1';
        animateNode(n, f, t, s, d, function () { delete el.dataset.llAnim; });
      })(vEl, node, from, shape.num, shape, dur);
    }
  }

  function watch(box) {
    box.__llWatched = true;
    /* childList only — our own edits are to text nodes (characterData), so we
       can never re-trigger ourselves and end up fighting the animation. */
    var mo = new MutationObserver(function () { processKpis(box); });
    mo.observe(box, { childList: true, subtree: true });
    OBSERVERS.push(mo);
  }

  function scanKpis() {
    var boxes = document.querySelectorAll('.kpis');
    for (var i = 0; i < boxes.length; i++) {
      if (!boxes[i].__llWatched) watch(boxes[i]);
      processKpis(boxes[i]);
    }
  }

  /* ---------- sparkline draw-on ----------------------------------------- */
  function scanSparks() {
    var paths = document.querySelectorAll('svg.spark path[stroke]');
    for (var i = 0; i < paths.length; i++) {
      var p = paths[i];
      if (p.__llLen) continue;
      p.__llLen = true;
      try { p.style.setProperty('--ll-len', Math.ceil(p.getTotalLength())); } catch (e) { /* detached */ }
    }
  }

  /* ---------- cursor spotlight (delegated, so async tiles work) ---------- */
  if (!RM) {
    document.addEventListener('pointermove', function (e) {
      if (!e.target || !e.target.closest) return;
      var t = e.target.closest('a.tile');
      if (!t || t.classList.contains('soon')) return;
      var r = t.getBoundingClientRect();
      t.style.setProperty('--ll-mx', (e.clientX - r.left) + 'px');
      t.style.setProperty('--ll-my', (e.clientY - r.top) + 'px');
    }, { passive: true });
  }

  /* ---------- public: toast --------------------------------------------- */
  function zone() {
    var z = document.getElementById('llToastZone');
    if (!z) { z = document.createElement('div'); z.id = 'llToastZone'; document.body.appendChild(z); }
    return z;
  }
  LL.toast = function (msg, opts) {
    opts = opts || {};
    var t = document.createElement('div');
    t.className = 'll-toast' + (opts.err ? ' err' : '');
    t.setAttribute('role', 'status');
    t.innerHTML = '<span class="dot ' + (opts.err ? 'warn' : 'ok') + '"></span><span></span>';
    t.lastChild.textContent = msg;
    zone().appendChild(t);
    setTimeout(function () {
      t.classList.add('out');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 320);
    }, opts.life || 2800);
    return t;
  };

  /* ---------- public: busy button --------------------------------------- */
  var TICK = '<span class="ll-tick"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg></span>';
  LL.busy = function (btn) {
    if (!btn || btn.__llBusy) return { done: function () {}, fail: function () {} };
    btn.__llBusy = true;
    btn.classList.add('ll-busy');
    var spin = document.createElement('span');
    spin.className = 'll-spin';
    spin.innerHTML = '<i></i>';
    btn.appendChild(spin);

    function clear() {
      btn.classList.remove('ll-busy', 'll-done');
      if (spin.parentNode) spin.parentNode.removeChild(spin);
      var tick = btn.querySelector('.ll-tick');
      if (tick) tick.parentNode.removeChild(tick);
      btn.__llBusy = false;
    }
    return {
      done: function (msg, hold) {
        btn.classList.remove('ll-busy');
        if (spin.parentNode) spin.parentNode.removeChild(spin);
        btn.classList.add('ll-done');
        btn.insertAdjacentHTML('beforeend', TICK);
        if (msg) LL.toast(msg);
        setTimeout(clear, hold || 1400);
      },
      fail: function (msg) {
        clear();
        if (msg) LL.toast(msg, { err: true });
      }
    };
  };

  /* ---------- action feedback bridge -------------------------------------
     Every action handler in the hub is written the same way: disable the
     button that was clicked, await the call, then write the outcome into a
     .msg element as `msg ok` or `msg err`, and re-enable the button in a
     finally block. That existing convention is enough to drive the button
     states and the toasts without editing a single handler.

     Nothing here changes what a handler does. The inline .msg text stays
     exactly where it is — the toast is an addition, so if this file ever
     fails to load, the pages behave precisely as they do today. */

  var lastOkAt = 0;
  function nowMs() { return (window.performance && performance.now) ? performance.now() : +new Date(); }

  /* outcomes -> toasts */
  function reportMsg(el) {
    var txt = (el.textContent || '').trim();
    if (!txt) { el.__llLast = ''; return; }
    var isOk = el.classList.contains('ok');
    var isErr = el.classList.contains('err');
    if (!isOk && !isErr) return;                        // in-progress text, not an outcome

    /* A handler writes the text and the class as separate statements. When
       they land in the same task the observer batches them into ONE callback,
       so we cannot rely on seeing the intermediate cleared state — dedupe on a
       short time window instead of on the text alone. Anything less than this
       swallows a legitimate repeat, e.g. pressing Save twice with the same
       validation error still needs to tell you twice. */
    var t = nowMs();
    if (txt === el.__llLast && (t - (el.__llLastAt || 0)) < 400) return;
    el.__llLast = txt;
    el.__llLastAt = t;
    if (isOk) lastOkAt = t;
    LL.toast(txt, { err: isErr, life: isErr ? 5200 : 2800 });
  }

  function bridgeMsgs() {
    var els = document.querySelectorAll('.msg');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.__llMsg) continue;
      el.__llMsg = true;
      el.__llLast = (el.textContent || '').trim();      // never announce what is already on screen
      (function (node) {
        var mo = new MutationObserver(function () { reportMsg(node); });
        mo.observe(node, { childList: true, characterData: true, subtree: true,
                           attributes: true, attributeFilter: ['class'] });
        OBSERVERS.push(mo);
      })(el);
    }
  }

  /* in-flight buttons — arm on click, then look one tick later: if the
     handler disabled the very button that was pressed, it is an async action
     worth showing state for. A button disabled for any other reason is never
     touched. */
  function watchButton(btn, handle) {
    var settled = false;
    function finish(ok) {
      if (settled) return;
      settled = true;
      mo.disconnect();
      if (ok) handle.done(); else handle.fail();
    }
    var mo = new MutationObserver(function () {
      if (btn.disabled) return;                         // still working
      finish((nowMs() - lastOkAt) < 700);               // an ok landed alongside it
    });
    mo.observe(btn, { attributes: true, attributeFilter: ['disabled'] });
    OBSERVERS.push(mo);
    setTimeout(function () { finish(false); }, 25000);  // never leave a button stuck
  }

  if (!RM) {
    document.addEventListener('click', function (e) {
      if (!e.target || !e.target.closest) return;
      var btn = e.target.closest('button');
      if (!btn || btn.disabled || btn.__llBusy) return;
      setTimeout(function () {
        if (!btn.disabled || btn.__llBusy) return;      // synchronous action, nothing to show
        watchButton(btn, LL.busy(btn));
      }, 0);
    }, true);
  }

  /* ---------- boot ------------------------------------------------------- */
  function tick() { scanKpis(); scanSparks(); bridgeMsgs(); }

  function boot() {
    tick();
    /* Pages render their data asynchronously, so watch the document for new
       .kpis / svg.spark arriving. Debounced to one pass per frame. */
    var queued = false;
    var mo = new MutationObserver(function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; tick(); });
    });
    mo.observe(document.body, { childList: true, subtree: true });
    OBSERVERS.push(mo);

    /* Belt and braces: a few cheap re-scans so a slow Supabase response is
       still picked up even if the observer were ever to go missing. Each pass
       is a querySelectorAll and an early return on anything already handled. */
    window.addEventListener('load', tick);
    setTimeout(tick, 800);
    setTimeout(tick, 2500);
    setTimeout(tick, 6000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
