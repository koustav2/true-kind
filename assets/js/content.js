/* ==========================================================================
   True Kind — public-site hydration from the admin CMS.
   Fetches admin-edited content and swaps it into the page. If the API is
   unreachable or a key is empty, the built-in content stays — the site can
   never look broken because of the backend.
   ========================================================================== */
(function () {
  "use strict";

  // Always same-origin. These pages are served by the same Express app that
  // serves /api, on our own VPS, so a relative path is correct by construction
  // and stays correct if the domain ever changes.
  //
  // This used to branch on location.hostname against a hardcoded allowlist and
  // fall back to a separate api host for anything it did not recognise. That
  // was wrong twice over: the fallback host does not serve this content, and
  // any hostname the list had not been told about — a staging domain, a new
  // subdomain, a bare IP during a migration — silently lost every piece of
  // admin-edited content, with no error visible anywhere.
  var API = "/api";

  function get(key) {
    return fetch(API + "/content/" + key, { signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .catch(function () { return {}; });
  }

  // "A | B | C" lines -> [[A,B,C], ...]
  function rows(data) {
    if (!data || !data.rows) return [];
    return String(data.rows).split("\n")
      .map(function (l) { return l.trim(); })
      .filter(Boolean)
      .map(function (l) { return l.split("|").map(function (c) { return c.trim(); }); });
  }

  function clearPending(el) {
    var section = el.closest("section");
    if (section) section.querySelectorAll(".pending").forEach(function (p) { p.style.display = "none"; });
  }

  // ---- banner: hero headline + sub-text -----------------------------------
  var bh = document.querySelector("[data-cms-banner-headline]");
  var bs = document.querySelector("[data-cms-banner-subtext]");
  if (bh || bs) get("banner").then(function (d) {
    if (d.headline && bh) { bh.textContent = d.headline; clearPending(bh); }
    if (d.subtext && bs) { bs.textContent = d.subtext; }
  });

  // ---- about: heading + body paragraphs ------------------------------------
  var ah = document.querySelector("[data-cms-about-heading]");
  var ab = document.querySelector("[data-cms-about-body]");
  if (ah || ab) get("about").then(function (d) {
    if (d.heading && ah) ah.textContent = d.heading;
    if (d.body && ab) {
      ab.textContent = "";
      String(d.body).split(/\n+/).filter(Boolean).forEach(function (para) {
        var p = document.createElement("p");
        p.textContent = para;
        ab.appendChild(p);
      });
      clearPending(ab);
    }
  });

  // ---- team: board/team cards (Name | Role | bio) --------------------------
  var team = document.querySelector("[data-cms-team]");
  if (team) get("team").then(function (d) {
    var list = rows(d);
    if (!list.length) return;
    team.textContent = "";
    list.forEach(function (r) {
      var name = r[0] || "", role = r[1] || "", bio = r[2] || "";
      var card = document.createElement("div"); card.className = "board-card";
      var av = document.createElement("div"); av.className = "board-avatar"; av.setAttribute("aria-hidden", "true");
      av.textContent = name.split(/\s+/).map(function (w) { return w[0] || ""; }).join("").slice(0, 2).toUpperCase();
      var h = document.createElement("h3"); h.textContent = name;
      var ro = document.createElement("p"); ro.className = "role"; ro.textContent = role;
      var b = document.createElement("p"); b.textContent = bio;
      card.append(av, h, ro, b);
      team.appendChild(card);
    });
    clearPending(team);
  });

  // ---- works: retitle the existing program cards by position ---------------
  var works = document.querySelector("[data-cms-works]");
  if (works) get("works").then(function (d) {
    var list = rows(d);
    if (!list.length) return;
    var cards = works.querySelectorAll(".work-card");
    list.forEach(function (r, i) {
      if (!cards[i]) return;
      var h = cards[i].querySelector("h3"), p = cards[i].querySelector(".work-body p");
      if (r[0] && h) h.textContent = r[0];
      if (r[1] && p) p.textContent = r[1];
    });
    clearPending(works);
  });

  // ---- press: rebuild the list (Date | Outlet | Headline | Link) -----------
  var press = document.querySelector("[data-cms-press]");
  if (press) get("press").then(function (d) {
    var list = rows(d);
    if (!list.length) return;
    press.textContent = "";
    list.forEach(function (r) {
      var date = r[0] || "", outlet = r[1] || "", headline = r[2] || "", link = r[3] || "";
      var card = document.createElement("article"); card.className = "press-card";
      var dt = document.createElement("div"); dt.className = "press-date"; dt.textContent = date;
      var body = document.createElement("div");
      var tag = document.createElement("span"); tag.className = "press-tag"; tag.textContent = outlet;
      var h = document.createElement("h3"); h.textContent = headline;
      body.append(tag, h);
      if (/^https?:\/\//i.test(link)) {
        var a = document.createElement("a"); a.className = "textlink";
        a.href = link; a.target = "_blank"; a.rel = "noopener";
        a.textContent = "Read the coverage →";
        body.appendChild(a);
      }
      card.append(dt, body);
      press.appendChild(card);
    });
    clearPending(press);
  });
})();
