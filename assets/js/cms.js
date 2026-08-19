/* ==========================================================================
   True Kind — public-site CMS hydration.

   Every editable element on every page carries a data-cms="<id>" attribute,
   stamped by server/cms/build-registry.js. This script fetches the admin's
   overrides for the current page in ONE request and applies them by id.

   Design rules it follows, in order of importance:

   1. The page must never look broken because of the backend. If the request
      fails, times out, or returns nothing, the HTML already in the document is
      what the visitor sees — which is the real content, not a placeholder.
   2. Only overridden fields come down the wire. Defaults live in the HTML, so
      re-sending them would double the payload and risk a stale copy clobbering
      good markup.
   3. No layout shift. Nothing is hidden while loading; text is swapped in place.

   Loaded on all 9 pages after main.js. Runs alongside the older content.js,
   which still handles the five original hand-wired keys.
   ========================================================================== */
(function () {
  "use strict";

  var API = "/api/cms/";   // same-origin: this site is served by its own server

  /* Page name from the filename, matching the registry's `name` values. */
  function pageName() {
    var f = location.pathname.split("/").pop() || "index.html";
    f = f.replace(/\.html$/, "");
    return f === "" ? "index" : f;
  }

  function fetchJson(url) {
    var opts = {};
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
      opts.signal = AbortSignal.timeout(6000);
    }
    return fetch(url, opts).then(function (r) {
      // The 404 handler renders HTML, so never assume the body is JSON.
      return r.ok ? r.json() : null;
    }).catch(function () { return null; });
  }

  /* ---- appliers ---------------------------------------------------------- */

  function applyText(el, value) {
    if (el.textContent === value) return;
    el.textContent = value;
  }

  /* Richtext is sanitised server-side on save (inline tags only, no event
     handlers, no javascript: hrefs), so assigning it here is safe. Belt and
     braces: strip anything script-shaped that somehow made it through. */
  function applyRich(el, value) {
    var safe = String(value).replace(/<\s*\/?\s*(script|style|iframe|object|embed|form)\b[^>]*>/gi, "");
    if (el.innerHTML === safe) return;
    el.innerHTML = safe;
  }

  function applyImage(el, value) {
    if (!value) return;
    if (value.src) el.setAttribute("src", value.src);
    if (typeof value.alt === "string") el.setAttribute("alt", value.alt);
  }

  /* A photo slot is an <img> injected into a container that currently shows a
     line illustration or a set of initials. Reveal the photograph and flag the
     container so the CSS can stand the placeholder down. With no src the <img>
     stays hidden and the illustration is what the visitor sees — so an unfilled
     slot never leaves a gap. */
  function applyPhoto(el, value) {
    var src = value && value.src;
    var holder = el.parentElement;
    if (!src) {
      el.hidden = true;
      el.removeAttribute("src");
      if (holder) holder.classList.remove("has-photo");
      return;
    }
    el.setAttribute("src", src);
    el.setAttribute("alt", (value && value.alt) || "");
    el.hidden = false;
    if (holder) holder.classList.add("has-photo");
  }

  function applyVideo(container, value) {
    if (!container) return;
    var mode = value && value.mode;
    if (!mode) { container.hidden = true; container.innerHTML = ""; return; }

    var aspect = container.getAttribute("data-aspect") || "16/9";
    var inner = "";
    if (mode === "upload" && value.src) {
      inner = '<video controls preload="metadata" playsinline' +
              (value.poster ? ' poster="' + escAttr(value.poster) + '"' : "") +
              ' style="width:100%;height:100%;display:block;border-radius:14px;background:#101F29">' +
              '<source src="' + escAttr(value.src) + '">' +
              "</video>";
    } else if (mode === "embed" && value.embedUrl) {
      // Only URLs the server already canonicalised to a youtube-nocookie or
      // player.vimeo embed path can reach this point.
      inner = '<iframe src="' + escAttr(value.embedUrl) + '" title="' +
              escAttr(value.caption || "Video") + '" loading="lazy" allowfullscreen ' +
              'referrerpolicy="strict-origin-when-cross-origin" ' +
              'style="width:100%;height:100%;border:0;display:block;border-radius:14px"></iframe>';
    }
    if (!inner) { container.hidden = true; container.innerHTML = ""; return; }

    var caption = value.caption
      ? '<p style="margin:10px 0 0;font-size:.82rem;color:#5B6870">' + escHtml(value.caption) + "</p>"
      : "";
    container.innerHTML =
      '<div style="aspect-ratio:' + escAttr(aspect) + ';width:100%;overflow:hidden;border-radius:14px">' +
      inner + "</div>" + caption;
    container.hidden = false;
  }

  function escAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;")
                    .replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ---- apply a whole bundle --------------------------------------------- */

  function apply(bundle) {
    if (!bundle || !bundle.fields) return 0;
    var n = 0;
    Object.keys(bundle.fields).forEach(function (id) {
      var f = bundle.fields[id];
      try {
        if (f.t === "video") {
          applyVideo(document.querySelector('[data-cms-video="' + cssEsc(id) + '"]'), f.v);
          n++;
          return;
        }
        // A field with an explicit selector edits something outside the body
        // (a <title>, a <meta content>), an attribute on another element, or a
        // photo slot.
        if (f.s) {
          var t = document.querySelector(f.s);
          if (!t) return;
          if (f.t === "image") applyPhoto(t, f.v);
          else if (f.a) t.setAttribute(f.a, f.v);
          else {
            // Declared text slots start empty AND hidden, so that an unfilled
            // one leaves no blank gap. Setting a value has to reveal it.
            t.textContent = f.v;
            if (t.hasAttribute("hidden")) t.hidden = !String(f.v).trim();
          }
          n++;
          return;
        }
        var el = document.querySelector('[data-cms="' + cssEsc(id) + '"]');
        if (!el) return;
        if (f.t === "image") applyImage(el, f.v);
        else if (f.t === "richtext") applyRich(el, f.v);
        else if (f.t === "url") el.setAttribute("href", f.v);
        else applyText(el, f.v);
        n++;
      } catch (e) { /* one bad field must not stop the rest */ }
    });
    return n;
  }

  /* CSS.escape is not in older Safari; ids are [\w.-] so a manual escape of the
     dots is enough for an attribute-value selector. */
  function cssEsc(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\]/g, "\\$&");
  }

  /* ---- go ---------------------------------------------------------------- */

  var page = pageName();

  // Global (header/footer) and page bundles are separate rows server-side but
  // one request each; fire both together rather than serialising them.
  Promise.all([fetchJson(API + "global"), fetchJson(API + page)])
    .then(function (res) {
      var applied = apply(res[0]) + apply(res[1]);
      // Announce completion so the click-to-edit overlay can bind after the DOM
      // has settled — content.js rebuilds whole containers, which would
      // otherwise throw away any handler bound directly to those elements.
      document.dispatchEvent(new CustomEvent("cms:hydrated", { detail: { page: page, applied: applied } }));
    });
})();
