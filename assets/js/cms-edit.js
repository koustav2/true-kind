/* ==========================================================================
   True Kind — click-to-edit on the live site.

   For a signed-in admin only. Probes /portal/admin/cms/session; if that says
   "admin", a small toolbar appears and every editable block on the page becomes
   clickable. The admin edits the real page, sees the real typography and the
   real line breaks, and saves without leaving it.

   For a visitor, the probe returns 401/403/a redirect and this file does
   nothing at all — no toolbar, no outlines, no extra requests, no DOM changes.

   Two implementation notes worth knowing:

   * Handlers are bound by DELEGATION on document, never to the editable
     elements. assets/js/content.js rebuilds whole containers (team cards, press
     entries) inside async callbacks that resolve after this file runs, so any
     handler attached directly to those nodes would be silently discarded.

   * Editing writes to a per-field panel, not to contentEditable on the live
     node. contentEditable on a heading whose CSS uses ::before/::after or a
     clamped font-size fights the layout and pastes arbitrary markup; a panel
     keeps the saved value exactly what the admin typed.
   ========================================================================== */
(function () {
  "use strict";

  var SESSION = "/portal/admin/cms/session";
  var SCHEMA  = "/portal/admin/cms/schema/";
  var SAVE    = "/portal/admin/cms/inline/";

  var state = { csrf: null, fields: {}, page: null, open: null, dirty: false };

  function pageName() {
    var f = (location.pathname.split("/").pop() || "index.html").replace(/\.html$/, "");
    return f === "" ? "index" : f;
  }

  /* The session probe must not be followed into a redirect: requireAdmin sends
     302 -> /portal/signin, and fetch's default redirect:'follow' would hand back
     a 200 with an HTML sign-in page, which JSON.parse would then choke on. */
  function probe() {
    return fetch(SESSION, {
      credentials: "same-origin",
      redirect: "manual",
      headers: { "Accept": "application/json", "X-Requested-With": "fetch" }
    }).then(function (r) {
      if (!r.ok) return null;
      var ct = r.headers.get("content-type") || "";
      if (ct.indexOf("application/json") === -1) return null;
      return r.json();
    }).catch(function () { return null; });
  }

  function start(session) {
    state.csrf = session.csrfToken;
    state.page = pageName();

    fetch(SCHEMA + state.page, { credentials: "same-origin", headers: { "Accept": "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.ok) return;
        d.fields.forEach(function (f) { state.fields[f.id] = f; });
        injectUi(session);
      }).catch(function () {});
  }

  /* ---- UI ---------------------------------------------------------------- */

  function injectUi(session) {
    var css = document.createElement("style");
    css.textContent = [
      ".tkedit-bar{position:fixed;left:50%;transform:translateX(-50%);bottom:18px;z-index:99999;",
      "  display:flex;gap:10px;align-items:center;padding:10px 14px;border-radius:100px;",
      "  background:#101F29;color:#FCFAF6;font:500 13px/1 'Work Sans',system-ui,sans-serif;",
      "  box-shadow:0 8px 30px rgba(16,31,41,.28)}",
      ".tkedit-bar button{font:inherit;border:0;cursor:pointer;padding:7px 13px;border-radius:100px}",
      ".tkedit-on{background:#59B306;color:#fff}",
      ".tkedit-off{background:rgba(252,250,246,.16);color:#FCFAF6}",
      ".tkedit-bar .who{opacity:.7;font-weight:400}",
      "body.tkedit [data-cms],body.tkedit [data-cms-video]{outline:1px dashed rgba(3,146,212,.55);",
      "  outline-offset:2px;cursor:pointer}",
      "body.tkedit [data-cms]:hover,body.tkedit [data-cms-video]:hover{outline:2px solid #0392D4;",
      "  background:rgba(3,146,212,.06)}",
      ".tkedit-panel{position:fixed;right:16px;bottom:76px;width:min(420px,calc(100vw - 32px));z-index:99999;",
      "  background:#fff;border:1px solid rgba(16,31,41,.18);border-radius:14px;padding:16px;",
      "  box-shadow:0 14px 44px rgba(16,31,41,.24);font:400 14px/1.5 'Work Sans',system-ui,sans-serif;color:#29373F}",
      ".tkedit-panel h4{margin:0 0 4px;font:500 14px/1.3 'Work Sans',sans-serif}",
      ".tkedit-panel .k{font:400 10px/1.4 'IBM Plex Mono',monospace;color:#676E73;margin-bottom:10px;word-break:break-all}",
      ".tkedit-panel textarea,.tkedit-panel input{width:100%;box-sizing:border-box;padding:10px 12px;",
      "  border:1px solid rgba(16,31,41,.18);border-radius:9px;font:inherit;color:inherit}",
      ".tkedit-panel textarea{min-height:96px;resize:vertical}",
      ".tkedit-panel .row{display:flex;gap:8px;margin-top:12px;align-items:center}",
      ".tkedit-panel .msg{font-size:12px;color:#676E73;flex:1}",
      ".tkedit-panel .msg.bad{color:#A8243A}",
      ".tkedit-panel .warn{font-size:12px;color:#8a6d00;background:rgba(222,180,0,.12);",
      "  padding:8px 10px;border-radius:8px;margin-bottom:10px}",
      ".tkedit-panel button{font:inherit;border:0;cursor:pointer;padding:9px 15px;border-radius:100px}",
      ".tkedit-save{background:#7D4AB1;color:#fff}",
      ".tkedit-cancel{background:rgba(16,31,41,.07);color:#29373F}"
    ].join("");
    document.head.appendChild(css);

    var bar = document.createElement("div");
    bar.className = "tkedit-bar";
    bar.innerHTML =
      '<button class="tkedit-off" type="button" data-tkedit-toggle>Edit this page</button>' +
      '<span class="who">' + esc(session.name || "admin") + "</span>" +
      '<a href="/portal/admin/cms/page/' + esc(state.page) + '" style="color:#FCFAF6;opacity:.75;font-weight:400">All fields ↗</a>';
    document.body.appendChild(bar);

    bar.querySelector("[data-tkedit-toggle]").addEventListener("click", function () {
      var on = document.body.classList.toggle("tkedit");
      this.className = on ? "tkedit-on" : "tkedit-off";
      this.textContent = on ? "Done editing" : "Edit this page";
      if (!on) closePanel();
    });

    // Delegated: survives content.js rebuilding containers underneath us.
    document.addEventListener("click", function (e) {
      if (!document.body.classList.contains("tkedit")) return;
      if (e.target.closest(".tkedit-panel") || e.target.closest(".tkedit-bar")) return;
      var el = e.target.closest("[data-cms],[data-cms-video]");
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      openPanel(el);
    }, true);

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closePanel();
    });
  }

  /* ---- panel ------------------------------------------------------------- */

  function closePanel() {
    if (state.open && state.open.node) state.open.node.remove();
    state.open = null;
  }

  function openPanel(el) {
    closePanel();
    var videoId = el.getAttribute("data-cms-video");
    var id = videoId || el.getAttribute("data-cms");
    var field = state.fields[id];

    var panel = document.createElement("div");
    panel.className = "tkedit-panel";

    if (videoId) {
      // Video needs a mode choice and an upload; that belongs in the full editor.
      panel.innerHTML =
        "<h4>" + esc((field && field.label) || "Video") + "</h4>" +
        '<div class="k">' + esc(id) + "</div>" +
        '<p style="margin:0 0 12px">Videos are set up in the full editor — you need to pick a file or paste a link there.</p>' +
        '<div class="row"><a class="tkedit-save" style="text-decoration:none;display:inline-block" href="/portal/admin/cms/page/' +
          esc(state.page) + '">Open the editor ↗</a>' +
        '<button class="tkedit-cancel" type="button" data-tkedit-close>Close</button></div>';
      finish(panel, null);
      return;
    }

    if (!field) {
      panel.innerHTML = "<h4>Not editable</h4><div class=\"k\">" + esc(id) + "</div>" +
        "<p style=\"margin:0 0 12px\">This block is not in the content registry. Re-run <code>npm run cms:build</code> if you have just changed the HTML.</p>" +
        '<div class="row"><button class="tkedit-cancel" type="button" data-tkedit-close>Close</button></div>';
      finish(panel, null);
      return;
    }

    var isRich = field.type === "richtext";
    var current = isRich ? el.innerHTML.trim() : (field.type === "image" ? (el.getAttribute("alt") || "") : el.textContent.trim());
    var multiline = isRich || field.type === "textarea" || current.length > 90;

    var globalWarn = field.id.indexOf("global.") === 0
      ? '<div class="warn">This is in the header or footer — saving changes it on all nine pages.</div>' : "";
    var richHint = isRich
      ? '<p style="margin:6px 0 0;font-size:12px;color:#676E73">Contains formatting. Keep the tags and edit the words between them.</p>' : "";
    var imageHint = field.type === "image"
      ? '<p style="margin:6px 0 0;font-size:12px;color:#676E73">This edits the alt text. To swap the picture itself, use the full editor.</p>' : "";

    panel.innerHTML =
      "<h4>" + esc(field.label || field.role) + "</h4>" +
      '<div class="k">' + esc(id) + "</div>" +
      globalWarn +
      (multiline
        ? '<textarea data-tkedit-input>' + esc(current) + "</textarea>"
        : '<input type="text" data-tkedit-input value="' + escAttr(current) + '">') +
      richHint + imageHint +
      '<div class="row">' +
        '<button class="tkedit-save" type="button" data-tkedit-save>Save</button>' +
        '<button class="tkedit-cancel" type="button" data-tkedit-close>Cancel</button>' +
        '<span class="msg" data-tkedit-msg></span>' +
      "</div>";

    finish(panel, function () {
      var input = panel.querySelector("[data-tkedit-input]");
      var msg   = panel.querySelector("[data-tkedit-msg]");
      var value = input.value;

      msg.className = "msg";
      msg.textContent = "Saving…";

      var payload = field.type === "image"
        ? { src: el.getAttribute("src") || "", alt: value }
        : value;

      fetch(SAVE + (field.id.indexOf("global.") === 0 ? "global" : state.page), {
        method: "POST",
        credentials: "same-origin",
        redirect: "manual",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "X-CSRF-Token": state.csrf,
          "X-Requested-With": "fetch"
        },
        body: JSON.stringify({ id: field.id, value: payload })
      }).then(function (r) {
        var ct = r.headers.get("content-type") || "";
        if (ct.indexOf("application/json") === -1) throw new Error("signed_out");
        return r.json().then(function (d) { return { status: r.status, d: d }; });
      }).then(function (out) {
        if (!out.d.ok) {
          msg.className = "msg bad";
          msg.textContent = out.d.message || "Could not save that.";
          return;
        }
        // Reflect it on the page immediately so the admin sees the real result.
        if (field.type === "image") el.setAttribute("alt", value);
        else if (isRich) el.innerHTML = value;
        else el.textContent = value;
        msg.textContent = "Saved.";
        setTimeout(closePanel, 700);
      }).catch(function (err) {
        msg.className = "msg bad";
        msg.textContent = err && err.message === "signed_out"
          ? "Your session expired. Reload and sign in again."
          : "Could not reach the server.";
      });
    });

    var first = panel.querySelector("[data-tkedit-input]");
    if (first) { first.focus(); if (first.select) first.select(); }
  }

  function finish(panel, onSave) {
    document.body.appendChild(panel);
    state.open = { node: panel };
    panel.querySelectorAll("[data-tkedit-close]").forEach(function (b) {
      b.addEventListener("click", closePanel);
    });
    var save = panel.querySelector("[data-tkedit-save]");
    if (save && onSave) save.addEventListener("click", onSave);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escAttr(s) { return esc(s).replace(/"/g, "&quot;"); }

  /* ---- boot -------------------------------------------------------------- */

  probe().then(function (session) {
    if (!session || !session.admin) return;   // visitor: do nothing whatsoever
    start(session);
  });
})();
