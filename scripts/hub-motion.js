/* ===========================================================================
   Liquid & Larder — hub motion layer  (v2, 30 Jul 2026)
   Paired with the "v6 — motion layer" and "v8 — theme control" blocks in
   /styles/hub.css.

   v2 adds the theme control. It is injected rather than written into each page,
   the same bargain as the rest of this layer: eleven pages get the control and
   none of them needed a markup change. The theme itself is NOT set here — the
   inline script in each <head> does that before first paint, because this file
   is deferred and would arrive too late to stop a flash.

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
  function hold(mo, node) { OBSERVERS.push({ mo: mo, node: node || null }); }

  /* Pages that rebuild a dialog body on every open (Pre-Auth does) hand us a
     fresh .msg element each time. Without this the observer list would grow
     for the whole shift, each one watching a node that no longer exists. */
  function pruneObservers() {
    for (var i = OBSERVERS.length - 1; i >= 0; i--) {
      var o = OBSERVERS[i];
      if (o.node && !o.node.isConnected) { o.mo.disconnect(); OBSERVERS.splice(i, 1); }
    }
  }

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
    hold(mo, box);
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
    var paths = document.querySelectorAll(
      'svg.spark path[stroke]:not([stroke-dasharray]), svg.spark polyline[stroke]:not([stroke-dasharray])');
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

  function isShown(el) { return !!(el.getClientRects && el.getClientRects().length); }

  /* outcomes -> toasts.
     Two conventions exist in the hub. App pages use `.msg` and mark the
     outcome with an `ok` / `err` class. The reporting pages instead keep a
     hidden `.error` panel and reveal it with the failure text — those failures
     can sit below the fold and be missed entirely, which is the reason this
     handles both. */
  function reportOutcome(el, alwaysErr) {
    var txt = (el.textContent || '').trim();
    if (!txt) { el.__llLast = ''; return; }
    var isOk = false, isErr;
    if (alwaysErr) {
      if (!isShown(el)) return;                         // hidden leftover text stays quiet
      isErr = true;
    } else {
      isOk = el.classList.contains('ok');
      isErr = el.classList.contains('err');
      if (!isOk && !isErr) return;                      // in-progress text, not an outcome
    }

    /* A handler writes the text and the class (or the text and the display)
       as separate statements. When they land in the same task the observer
       batches them into ONE callback, so we cannot rely on seeing the
       intermediate cleared state — dedupe on a short time window instead of on
       the text alone. Anything less than this swallows a legitimate repeat,
       e.g. pressing Save twice with the same validation error. */
    var t = nowMs();
    if (txt === el.__llLast && (t - (el.__llLastAt || 0)) < 400) return;
    el.__llLast = txt;
    el.__llLastAt = t;
    if (isOk) lastOkAt = t;
    LL.toast(txt, { err: isErr, life: isErr ? 5200 : 2800 });
  }

  function bridge(sel, alwaysErr) {
    var els = document.querySelectorAll(sel);
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.__llMsg) continue;
      el.__llMsg = true;
      if (alwaysErr) {
        /* a panel injected with its failure text already in place never
           mutates afterwards, so announce it as we adopt it */
        reportOutcome(el, true);
      } else {
        el.__llLast = (el.textContent || '').trim();    // never announce what is already on screen
      }
      (function (node) {
        var mo = new MutationObserver(function () { reportOutcome(node, alwaysErr); });
        mo.observe(node, { childList: true, characterData: true, subtree: true,
                           attributes: true, attributeFilter: ['class', 'style'] });
        hold(mo, node);
      })(el);
    }
  }

  function bridgeMsgs() { bridge('.msg', false); bridge('.error', true); }

  /* in-flight buttons — arm on click, then look one tick later: if the
     handler disabled the very button that was pressed, it is an async action
     worth showing state for. A button disabled for any other reason is never
     touched. */
  function watchButton(btn, handle) {
    var settled = false, poll = null;
    function finish(ok) {
      if (settled) return;
      settled = true;
      mo.disconnect();
      if (poll) clearInterval(poll);
      if (ok) handle.done(); else handle.fail();
    }
    var mo = new MutationObserver(function () {
      if (btn.disabled) return;                         // still working
      finish((nowMs() - lastOkAt) < 700);               // an ok landed alongside it
    });
    mo.observe(btn, { attributes: true, attributeFilter: ['disabled'] });
    hold(mo, btn);

    /* Some handlers finish by hiding the button instead of re-enabling it —
       Pre-Auth's charge / release / edit-date / refund all do, since the
       action is done and the control should go away. Watch for the button
       stopping being rendered (or leaving the DOM) as a second completion
       signal, otherwise those four would spin until the stall timeout. */
    var poll = setInterval(function () {
      if (settled) { clearInterval(poll); return; }
      if (!btn.isConnected || !btn.getClientRects().length) { clearInterval(poll); finish(true); }
    }, 250);
    setTimeout(function () { clearInterval(poll); finish(false); }, 25000);  // never leave a button stuck
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


  /* ---------- theme control (System / Light / Dark) ----------------------
     The <head> script has already resolved data-theme before first paint, and
     the user's own choice is in localStorage under "ll-theme". All this does is
     draw the switch, write the choice, and keep "system" honest by listening
     for OS changes. Injected into the topbar, or the sidebar footer on the home
     page; if a page has neither it is simply skipped (the 404 page). --------- */

  var THEME_KEY = 'll-theme';
  var ICONS = {
    system: '<svg viewBox="0 0 24 24"><rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 20h8"/><path d="M12 17v3"/></svg>',
    light:  '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4"/></svg>',
    dark:   '<svg viewBox="0 0 24 24"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5z"/></svg>'
  };
  var LABEL = { system:'Match my device', light:'Light', dark:'Dark' };

  function readPref() {
    try { var v = localStorage.getItem(THEME_KEY); return (v === 'light' || v === 'dark') ? v : 'system'; }
    catch (e) { return 'system'; }
  }
  function systemIsDark() {
    return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function applyPref(pref) {
    var dark = pref === 'dark' || (pref !== 'light' && systemIsDark());
    var r = document.documentElement;
    r.setAttribute('data-theme', dark ? 'dark' : 'light');
    r.setAttribute('data-theme-pref', pref);
    try { if (pref === 'system') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, pref); }
    catch (e) {}
    syncControls(pref);
  }
  function syncControls(pref) {
    var all = document.querySelectorAll('.ll-theme button');
    for (var i = 0; i < all.length; i++)
      all[i].setAttribute('aria-pressed', all[i].getAttribute('data-theme-set') === pref ? 'true' : 'false');
  }
  function buildControl() {
    var pref = readPref();
    var wrap = document.createElement('div');
    wrap.className = 'll-theme';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Colour theme');
    ['system', 'light', 'dark'].forEach(function (k) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-theme-set', k);
      b.setAttribute('aria-pressed', pref === k ? 'true' : 'false');
      b.setAttribute('title', LABEL[k]);
      b.setAttribute('aria-label', LABEL[k]);
      b.innerHTML = ICONS[k];
      wrap.appendChild(b);
    });
    wrap.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-theme-set]') : null;
      if (b) applyPref(b.getAttribute('data-theme-set'));
    });
    return wrap;
  }
  function mountControl() {
    if (document.querySelector('.ll-theme')) return;      /* already mounted */
    /* The home page keeps it in the sidebar footer next to Sign out; every
       other staff page has a .topbar .bar. */
    var host = document.querySelector('.sideUser') || document.querySelector('.topbar .bar');
    if (!host) return;
    if (host.classList.contains('bar')) {
      /* .bar is justify-content:space-between, so push the title block left and
         everything after it packs to the right alongside the new control. */
      var first = host.firstElementChild;
      if (first) first.style.marginRight = 'auto';
    }
    host.appendChild(buildControl());
    /* The home page also has a compact mobile bar, shown when the sidebar is not. */
    var mob = document.querySelector('.mobileBar');
    if (mob && !mob.querySelector('.ll-theme')) mob.insertBefore(buildControl(), mob.lastElementChild);
    syncControls(readPref());
  }
  function watchSystem() {
    if (!window.matchMedia) return;
    var mq = matchMedia('(prefers-color-scheme: dark)');
    var onChange = function () { if (readPref() === 'system') applyPref('system'); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }
  LL.theme = { get: readPref, set: applyPref };

  /* ---------- boot ------------------------------------------------------- */
  function tick() { mountControl(); scanKpis(); scanSparks(); bridgeMsgs(); pruneObservers(); }

  function boot() {
    mountControl();
    watchSystem();
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
    hold(mo, document.body);

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
