/* ==========================================================================
   True Kind Foundation — shared behaviour
   ==========================================================================
   Forms post to the True Kind portal API — volunteer registrations and
   contact enquiries land in the portal database and show up in the admin
   (Volunteers / Enquiries tabs).

   The site is served by our own Express server, so the API is ALWAYS
   same-origin. The previous build also shipped to Vercel and fell back to a
   separate api.truehr.co.in gateway whenever the hostname was unrecognised.
   That path is gone: it failed silently on any host not in the allowlist (a
   staging domain, a bare IP, a preview URL) by posting to a gateway that was
   never configured, and it made cookie-authenticated requests impossible,
   which is what blocked click-to-edit.

   FORM_ENDPOINT is an optional override — set it to a Formspree-style URL
   and ALL forms post there instead. Leave it "" to use the portal API.
   ========================================================================== */

var FORM_ENDPOINT = "";
var FALLBACK_EMAIL = "info@truekindfoundation.org";

var API_BASE = "/api";

// Which public form posts to which portal endpoint
var API_FORMS = { volunteerForm: "/volunteer", contactForm: "/contact" };

(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ----------------------------------------------------------------------
     Mobile navigation
     ---------------------------------------------------------------------- */
  (function nav() {
    var btn = document.getElementById("menubtn");
    var links = document.getElementById("navlinks");
    if (!btn || !links) return;

    var scrim = document.createElement("div");
    scrim.className = "nav-scrim";
    document.body.appendChild(scrim);

    function setOpen(open) {
      links.classList.toggle("open", open);
      scrim.classList.toggle("show", open);
      document.body.classList.toggle("nav-open", open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) {
        var first = links.querySelector("a");
        if (first) first.focus({ preventScroll: true });
      }
    }

    btn.addEventListener("click", function () {
      setOpen(!links.classList.contains("open"));
    });
    scrim.addEventListener("click", function () { setOpen(false); });
    links.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () { setOpen(false); });
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && links.classList.contains("open")) {
        setOpen(false);
        btn.focus();
      }
    });
    window.addEventListener("resize", function () {
      if (window.innerWidth > 960 && links.classList.contains("open")) setOpen(false);
    });
  })();

  /* ----------------------------------------------------------------------
     Sticky header shadow
     ---------------------------------------------------------------------- */
  (function headerShadow() {
    var header = document.querySelector("header.site");
    if (!header) return;
    var ticking = false;
    function update() {
      header.classList.toggle("scrolled", window.scrollY > 8);
      ticking = false;
    }
    window.addEventListener("scroll", function () {
      if (!ticking) { window.requestAnimationFrame(update); ticking = true; }
    }, { passive: true });
    update();
  })();

  /* ----------------------------------------------------------------------
     Portal links on a host that has no portal

     /portal/* is served by our Express app. Open the same HTML from anywhere
     else — the old Vercel deployment, a file:// copy, a preview host — and a
     relative /portal/donate resolves against that host and 404s. That is the
     bug the client reported: the Donate button dead-ending on
     true-kind-psi.vercel.app.

     vercel.json now redirects that host wholesale, which fixes it without any
     JavaScript. This is the belt to that braces: on ANY origin that is not the
     app and not a local dev server, portal links are rewritten to the canonical
     origin so the button still works. Same-origin is left completely alone, so
     on the real site this code changes nothing.
     ---------------------------------------------------------------------- */
  (function portalLinks() {
    var CANONICAL = "https://truekind.truehr.co.in";
    var host = location.hostname;

    // The app itself, and the usual local development hosts.
    if (/(^|\.)truehr\.co\.in$/i.test(host)) return;
    if (host === "localhost" || host === "[::1]" || host === "0.0.0.0") return;
    if (/^127\./.test(host)) return;
    if (/^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) return;
    // A bare file:// copy has no hostname at all — that one DOES need rewriting,
    // so an empty host deliberately falls through.

    document.querySelectorAll('a[href^="/portal"]').forEach(function (a) {
      a.setAttribute("href", CANONICAL + a.getAttribute("href"));
    });
  })();

  /* ----------------------------------------------------------------------
     Header donate button — the attention pulse

     Fires once per page view, 1.4s after load so it does not compete with the
     page painting, and runs a FIXED three times. The class is removed on
     animationend, which is what guarantees it can never become an endless loop:
     even if something re-adds it, each run is finite.

     Skipped entirely under prefers-reduced-motion, and skipped on the donation
     pages themselves — pulsing a button at someone who is already on their way
     to donating is noise, not encouragement.
     ---------------------------------------------------------------------- */
  (function donatePulse() {
    var btn = document.querySelector("[data-nav-donate]");
    if (!btn || reduceMotion) return;

    var here = (location.pathname.split("/").pop() || "index.html").replace(/\.html$/, "");
    if (here === "donate") return;

    var fired = false;
    function pulse() {
      if (fired) return;
      fired = true;
      btn.classList.add("pulse");
      btn.addEventListener("animationend", function () {
        btn.classList.remove("pulse");
      }, { once: true });
    }
    setTimeout(pulse, 1400);
  })();

  /* ----------------------------------------------------------------------
     Homepage slider

     Reveals itself ONLY if the CMS has put a photograph in at least one slide;
     otherwise the section stays hidden and the page is exactly as it was. That
     is why this waits for cms:hydrated rather than running at load — at load
     every slide is still empty.

     Movement is scroll-snap, not a transform: swipe, arrow buttons, dots and
     the keyboard all end up calling the same scrollTo, so there is one source of
     truth for "which slide are we on" and no state to drift.

     Auto-advance runs only when the user has not asked for reduced motion, and
     pauses on hover, on focus, and whenever the tab is in the background.
     ---------------------------------------------------------------------- */
  (function slider() {
    var root = document.querySelector("[data-slider]");
    if (!root) return;

    var track = root.querySelector("[data-slider-track]");
    var dotsBox = root.querySelector("[data-slider-dots]");
    var prev = root.querySelector("[data-slider-prev]");
    var next = root.querySelector("[data-slider-next]");
    var timer = null, index = 0, slides = [];

    function build() {
      var all = [].slice.call(track.querySelectorAll(".slide"));
      // A slide counts only once its photograph has arrived.
      slides = all.filter(function (li) {
        var img = li.querySelector("img.cms-photo");
        return img && img.getAttribute("src") && !img.hidden;
      });
      all.forEach(function (li) { li.hidden = slides.indexOf(li) === -1; });

      if (!slides.length) { root.hidden = true; stop(); return; }
      root.hidden = false;

      var many = slides.length > 1;
      prev.hidden = next.hidden = !many;
      dotsBox.innerHTML = "";
      if (many) {
        slides.forEach(function (li, i) {
          var d = document.createElement("button");
          d.type = "button";
          d.setAttribute("role", "tab");
          d.setAttribute("aria-label", "Photograph " + (i + 1) + " of " + slides.length);
          d.addEventListener("click", function () { go(i); restart(); });
          dotsBox.appendChild(d);
        });
      }
      index = Math.min(index, slides.length - 1);
      mark();
      if (many) start();
    }

    function go(i) {
      if (!slides.length) return;
      index = (i + slides.length) % slides.length;
      var li = slides[index];
      track.scrollTo({ left: li.offsetLeft - track.offsetLeft, behavior: reduceMotion ? "auto" : "smooth" });
      mark();
    }
    function mark() {
      [].slice.call(dotsBox.children).forEach(function (d, i) {
        d.setAttribute("aria-selected", i === index ? "true" : "false");
      });
      slides.forEach(function (li, i) {
        // Hide the off-screen slides from assistive tech, so a screen reader is
        // not read four captions for one visible photograph.
        li.setAttribute("aria-hidden", i === index ? "false" : "true");
      });
    }

    function start() {
      if (reduceMotion || timer || slides.length < 2) return;
      timer = setInterval(function () { go(index + 1); }, 6000);
    }
    function stop() { if (timer) { clearInterval(timer); timer = null; } }
    function restart() { stop(); start(); }

    prev.addEventListener("click", function () { go(index - 1); restart(); });
    next.addEventListener("click", function () { go(index + 1); restart(); });

    root.addEventListener("mouseenter", stop);
    root.addEventListener("mouseleave", start);
    root.addEventListener("focusin", stop);
    root.addEventListener("focusout", start);
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) stop(); else start();
    });
    root.addEventListener("keydown", function (e) {
      if (e.key === "ArrowLeft") { go(index - 1); restart(); }
      if (e.key === "ArrowRight") { go(index + 1); restart(); }
    });
    // A manual swipe should win over the timer.
    track.addEventListener("touchstart", stop, { passive: true });
    track.addEventListener("touchend", restart, { passive: true });

    // Slides arrive with the CMS bundle, so build after it lands. The timeout is
    // the case where cms.js is absent or its request never resolves.
    document.addEventListener("cms:hydrated", build);
    setTimeout(build, 1200);
  })();

  /* ----------------------------------------------------------------------
     Our Board (About page)

     The board is admin-managed data now (the BoardMember table, edited at
     /portal/admin/board), because "add another trustee" is not something a
     fixed set of CMS fields can express.

     Three rules, in this order:

     1. The four cards already in about.html are the fallback and they are NEVER
        removed speculatively. They are replaced only once we hold at least one
        real person. A failed request, an empty list, a server that is down — all
        leave the page exactly as it shipped.
     2. Everything the admin typed is written with textContent, and every link is
        re-checked for an http(s) scheme here even though the server already
        validated it. An admin is trusted, an admin's typo is not.
     3. Photograph optional: without one the card shows initials in the ring,
        which is what the placeholder cards do, so a half-filled board still
        looks deliberate.
     ---------------------------------------------------------------------- */
  (function board() {
    var grid = document.querySelector(".board-grid");
    if (!grid) return;

    var ICONS = {
      facebook:  '<svg viewBox="0 0 24 24" stroke-width="1.6" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"></rect><path d="M15 8h-1.5A1.5 1.5 0 0012 9.5V21M9.5 13h5"></path></svg>',
      linkedin:  '<svg viewBox="0 0 24 24" stroke-width="1.6" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"></rect><path d="M7 10v7M7 7v.01M11 17v-4.5a2 2 0 014 0V17"></path></svg>',
      // The X mark sits in a rounded square like the other three: on its own, a
      // bare diagonal cross in a circle reads as a "close" button.
      twitter:   '<svg viewBox="0 0 24 24" stroke-width="1.6" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"></rect><path d="M8.5 8.5l7 7M15.5 8.5l-7 7"></path></svg>',
      instagram: '<svg viewBox="0 0 24 24" stroke-width="1.6" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"></rect><circle cx="12" cy="12" r="4"></circle><circle cx="17.5" cy="6.5" r="1"></circle></svg>'
    };
    var LABEL = { facebook: "Facebook", linkedin: "LinkedIn", twitter: "X", instagram: "Instagram" };

    function initials(name) {
      return String(name || "").trim().split(/\s+/).slice(0, 2)
        .map(function (w) { return w.charAt(0).toUpperCase(); }).join("") || "?";
    }

    /* Only http(s) may become an href. Anything else is dropped silently — a
       link that does not work is better than a javascript: URL that does. */
    function safeHref(url) {
      if (!url) return null;
      try {
        var u = new URL(url, location.href);
        return (u.protocol === "http:" || u.protocol === "https:") ? u.href : null;
      } catch (e) { return null; }
    }

    function card(m) {
      var el = document.createElement("div");
      el.className = "board-card";

      var ring = document.createElement("div");
      ring.className = "board-avatar cms-photo-slot cms-photo-round";
      if (m.photo) {
        var img = document.createElement("img");
        img.className = "cms-photo";
        img.src = m.photo;
        img.alt = m.name ? m.name + " — photograph" : "";
        img.loading = "lazy";
        ring.classList.add("has-photo");
        ring.appendChild(img);
      } else {
        ring.textContent = initials(m.name);
        ring.setAttribute("aria-hidden", "true");
      }
      el.appendChild(ring);

      var h = document.createElement("h3");
      h.textContent = m.name || "";
      el.appendChild(h);

      if (m.designation) {
        var role = document.createElement("p");
        role.className = "role";
        role.textContent = m.designation;
        el.appendChild(role);
      }

      if (m.email) {
        var mail = document.createElement("p");
        mail.className = "board-mail";
        var a = document.createElement("a");
        // encodeURIComponent, not the raw string: an address with a space or a
        // stray quote must not be able to shape the mailto: URL.
        a.href = "mailto:" + encodeURIComponent(m.email).replace(/%40/g, "@");
        a.textContent = m.email;
        mail.appendChild(a);
        el.appendChild(mail);
      }

      if (m.bio) {
        var bio = document.createElement("p");
        bio.className = "board-bio";
        bio.textContent = m.bio;
        el.appendChild(bio);
      }

      var links = [];
      Object.keys(ICONS).forEach(function (k) {
        var href = safeHref(m.social && m.social[k]);
        if (!href) return;
        var s = document.createElement("a");
        s.href = href;
        s.target = "_blank";
        s.rel = "noopener";
        s.setAttribute("aria-label", (m.name ? m.name + " on " : "") + LABEL[k]);
        s.innerHTML = ICONS[k];      // a literal from this file, never user data
        links.push(s);
      });
      if (links.length) {
        var row = document.createElement("div");
        row.className = "board-social";
        links.forEach(function (s) { row.appendChild(s); });
        el.appendChild(row);
      }
      return el;
    }

    fetch(API_BASE + "/board", { headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var list = data && data.members;
        if (!list || !list.length) return;          // keep the shipped cards
        var frag = document.createDocumentFragment();
        list.forEach(function (m) { if (m && m.name) frag.appendChild(card(m)); });
        if (!frag.childNodes.length) return;
        grid.textContent = "";
        grid.appendChild(frag);
        /* These cards did not exist when the scroll-reveal observer bound, so
           they would otherwise be the only section on the page that appears
           without the fade-and-lift everything else has. reveal() below listens
           for this and registers them. */
        document.dispatchEvent(new CustomEvent("board:rendered"));
      })
      .catch(function () { /* the shipped cards stay */ });
  })();

  /* ----------------------------------------------------------------------
     Impact dials

     The percentage lives in the visible .ring-num text, not in a data
     attribute, so it is the single source of truth: the CMS can edit it and the
     arc follows. Nothing to keep in sync, nothing to get out of step.

     On scroll into view each dial sweeps its arc, travels its head dot to the
     value, and counts the number up — all on one shared clock so the number
     and the arc land together. Cards stagger by 110ms so the row reads left to
     right instead of flashing at once.

     Respects prefers-reduced-motion: final value, drawn instantly.
     ---------------------------------------------------------------------- */
  (function dials() {
    var cards = [].slice.call(document.querySelectorAll(".ring-card"));
    if (!cards.length) return;

    var R = 56;                          // must match the r in the markup
    var CIRC = 2 * Math.PI * R;          // 351.86

    /* Read the authored percentage out of the visible text — "82", "82%", " 82 ".
       Called ONCE per card, at snapshot time, never again while animating. */
    function readPct(card) {
      var el = card.querySelector(".ring-num");
      if (!el) return 0;
      var v = parseFloat(String(el.textContent).replace(/[^\d.\-]/g, ""));
      if (!isFinite(v)) return 0;
      return Math.max(0, Math.min(100, v));
    }

    /* The value every draw uses. It is snapshotted into data-pct rather than
       re-read from the DOM, because the count-up OWNS that text while it runs —
       it starts at "0" and climbs. Re-reading mid-count made the first dial draw
       itself at 0%: the arc froze empty while the number finished at 82. */
    function pctOf(card) {
      var v = parseFloat(card.dataset.pct);
      return isFinite(v) ? v : 0;
    }

    function prepare(card) {
      card.dataset.pct = readPct(card);
      var arc = card.querySelector(".ring-progress");
      var halo = card.querySelector(".ring-halo");
      [arc, halo].forEach(function (el) {
        if (!el) return;
        el.style.setProperty("--circ", CIRC);
        el.style.strokeDasharray = CIRC;
        el.style.strokeDashoffset = CIRC;
      });
    }

    /* Land on the final state with no animation. */
    function settle(card) {
      var pct = pctOf(card);
      var arc = card.querySelector(".ring-progress");
      var halo = card.querySelector(".ring-halo");
      var head = card.querySelector(".ring-head");
      var num = card.querySelector(".ring-num");
      var off = CIRC - (CIRC * pct) / 100;
      if (arc) arc.style.strokeDashoffset = off;
      if (halo) halo.style.strokeDashoffset = off;
      if (head) head.style.transform = "rotate(" + pct * 3.6 + "deg)";
      if (num) num.textContent = String(Math.round(pct));
      card.classList.add("is-filled");
    }

    /* Animate. The CSS transition drives the arc, the halo and the head; this
       only has to drive the number, on the same duration and the same easing so
       the digits arrive with the stroke. */
    function run(card, delay) {
      var pct = pctOf(card);
      var num = card.querySelector(".ring-num");

      setTimeout(function () {
        var arc = card.querySelector(".ring-progress");
        var halo = card.querySelector(".ring-halo");
        var head = card.querySelector(".ring-head");
        var off = CIRC - (CIRC * pct) / 100;
        if (arc) arc.style.strokeDashoffset = off;
        if (halo) halo.style.strokeDashoffset = off;
        if (head) head.style.transform = "rotate(" + pct * 3.6 + "deg)";
        card.classList.add("is-filled");

        if (!num) return;
        var DUR = 1250;
        var t0 = null;
        // ease-out-cubic. The analytic twin of --ease-dial's
        // cubic-bezier(0.33, 1, 0.68, 1), so the number and the arc land together.
        function ease(t) { return 1 - Math.pow(1 - t, 3); }
        function tick(ts) {
          if (t0 === null) t0 = ts;
          var t = Math.min(1, (ts - t0) / DUR);
          num.textContent = String(Math.round(pct * ease(t)));
          if (t < 1) requestAnimationFrame(tick);
          else num.textContent = String(Math.round(pct));
        }
        num.textContent = "0";
        requestAnimationFrame(tick);
      }, delay);
    }

    /* An aria-label on the card carries the value for screen readers, since the
       number animates and the svg is aria-hidden. */
    function label(card) {
      var h = card.querySelector("h3");
      card.setAttribute("role", "img");
      card.setAttribute("aria-label",
        (h ? h.textContent.trim() + ": " : "") + Math.round(pctOf(card)) + " percent");
    }

    /* Nothing is snapshotted or animated until the CMS has had its say.
       cms.js may rewrite .ring-num with an admin-edited percentage, and it does
       so from an async fetch that can land at any point — including in the
       middle of a count-up. Rather than trying to reconcile a value that is
       changing underneath us, we simply wait: read the text once it is final,
       then the count-up can own it for good.

       cms.js dispatches cms:hydrated whether the request succeeded, failed or
       returned nothing, so this fires on a broken backend too. The timeout is
       the belt-and-braces case where cms.js is absent from the page entirely. */
    var started = false;
    function start() {
      if (started) return;
      started = true;

      cards.forEach(prepare);
      cards.forEach(label);

      if (!("IntersectionObserver" in window) || reduceMotion) {
        cards.forEach(settle);
        return;
      }
      var seen = [];
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var card = entry.target;
          io.unobserve(card);
          // Stagger by position among the dials that have fired this pass.
          run(card, seen.length * 110);
          seen.push(card);
        });
      }, { threshold: 0.35 });
      cards.forEach(function (c) { io.observe(c); });
    }
    document.addEventListener("cms:hydrated", start);
    setTimeout(start, 1200);
  })();

  /* ----------------------------------------------------------------------
     Scroll reveal
     ---------------------------------------------------------------------- */
  (function reveal() {
    if (reduceMotion || !("IntersectionObserver" in window)) return;

    var lift = ".mvv-card, .ring-card, .press-card, .voice-card, .commit-card, " +
               ".hstat, .form-card, .trust-panel, .contact-info-card, .section-head, " +
               ".tier-card, .board-card, .story-grid > div, .contact-grid > div, " +
               ".cp-wrap > div, .hero-grid > div, .bank-details, .footprint-wrap > div";
    var fade = ".work-card";

    var i = 0;
    function markLift(el) {
      el.classList.add("reveal");
      el.style.transitionDelay = Math.min(i % 4, 3) * 0.07 + "s";
      i++;
    }
    document.querySelectorAll(lift).forEach(markLift);
    document.querySelectorAll(fade).forEach(function (el) {
      el.classList.add("reveal-fade");
    });

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: "0px 0px -40px 0px" });

    document.querySelectorAll(".reveal, .reveal-fade").forEach(function (el) { io.observe(el); });

    /* The board cards are built from the API after this ran, so they have to be
       enrolled when they arrive or they would be the one section that appears
       with no animation. Note this only fires when reveal() got this far — under
       prefers-reduced-motion the function returned at the top and the new cards
       simply stay visible, which is the correct behaviour, not a missed case. */
    document.addEventListener("board:rendered", function () {
      var fresh = document.querySelectorAll(".board-card:not(.reveal)");
      i = 0;                                   // restart the stagger for the row
      fresh.forEach(function (el) { markLift(el); io.observe(el); });
    });
  })();

  /* ----------------------------------------------------------------------
     Volunteer login modal (placeholder until a portal exists)
     ---------------------------------------------------------------------- */
  (function modal() {
    var overlay = document.getElementById("loginModal");
    var open = document.getElementById("openLogin");
    var close = document.getElementById("closeLogin");
    if (!overlay || !open) return;

    var lastFocus = null;

    function setOpen(state) {
      overlay.classList.toggle("open", state);
      document.body.classList.toggle("nav-open", state);
      if (state) {
        lastFocus = document.activeElement;
        var field = overlay.querySelector("input");
        if (field) field.focus();
      } else if (lastFocus) {
        lastFocus.focus();
      }
    }

    open.addEventListener("click", function () { setOpen(true); });
    if (close) close.addEventListener("click", function () { setOpen(false); });
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) setOpen(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && overlay.classList.contains("open")) setOpen(false);
    });

    var form = document.getElementById("loginForm");
    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var note = overlay.querySelector(".modal-note");
        if (note) {
          note.textContent =
            "The volunteer portal isn't connected yet, so this login can't sign you in. " +
            "Use the registration form below and our team will be in touch.";
          note.style.color = "var(--red-dark)";
        }
      });
    }
  })();

  /* ----------------------------------------------------------------------
     Forms — validation, POST submission, graceful mailto fallback
     ---------------------------------------------------------------------- */
  var OVERRIDE = /^https?:\/\//i.test(FORM_ENDPOINT);

  // The portal endpoint for a form, or the override URL, or null (→ mailto)
  function endpointFor(form) {
    if (OVERRIDE) return FORM_ENDPOINT;
    if (form.id && API_FORMS[form.id]) return API_BASE + API_FORMS[form.id];
    return null;
  }

  function showError(field, message) {
    field.classList.add("invalid");
    var slot = field.querySelector(".field-error");
    if (slot) slot.textContent = message;
    var input = field.querySelector("input, select, textarea");
    if (input) input.setAttribute("aria-invalid", "true");
  }

  function clearError(field) {
    field.classList.remove("invalid");
    var input = field.querySelector("input, select, textarea");
    if (input) input.removeAttribute("aria-invalid");
  }

  function validate(form) {
    var ok = true;
    var firstBad = null;

    form.querySelectorAll(".field").forEach(function (field) {
      var input = field.querySelector("input, select, textarea");
      if (!input || input.type === "checkbox" || input.classList.contains("hp-input")) return;

      clearError(field);
      var value = (input.value || "").trim();

      if (input.required && !value) {
        showError(field, "This field is required.");
        ok = false;
        firstBad = firstBad || input;
        return;
      }
      if (value && input.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
        showError(field, "Enter a valid email address, e.g. name@example.com");
        ok = false;
        firstBad = firstBad || input;
        return;
      }
      if (value && input.type === "tel" && value.replace(/[^0-9]/g, "").length < 7) {
        showError(field, "Enter a valid phone number.");
        ok = false;
        firstBad = firstBad || input;
      }
    });

    if (firstBad) {
      firstBad.focus();
      firstBad.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    }
    return ok;
  }

  function collect(form) {
    var data = {};
    var fd = new FormData(form);
    fd.forEach(function (value, key) {
      if (key === "_hp") return;
      if (data[key] !== undefined) {
        data[key] = [].concat(data[key], value).join(", ");
      } else {
        data[key] = value;
      }
    });
    return data;
  }

  function mailtoFallback(form, data) {
    var subject = form.dataset.subject || "Website enquiry";
    var body = Object.keys(data)
      .map(function (k) { return k.replace(/^\w/, function (c) { return c.toUpperCase(); }) + ": " + data[k]; })
      .join("\n");
    window.location.href =
      "mailto:" + FALLBACK_EMAIL +
      "?subject=" + encodeURIComponent(subject) +
      "&body=" + encodeURIComponent(body);
  }

  function alertBox(form, type, message) {
    var box = form.querySelector(".form-alert");
    if (!box) return;
    box.className = "form-alert show " + type;
    box.textContent = message;
    box.setAttribute("role", type === "error" ? "alert" : "status");
    box.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "nearest" });
  }

  document.querySelectorAll("form[data-form]").forEach(function (form) {
    // Clear the error state as soon as the visitor starts fixing it
    form.querySelectorAll("input, select, textarea").forEach(function (input) {
      input.addEventListener("input", function () {
        var field = input.closest(".field");
        if (field && field.classList.contains("invalid")) clearError(field);
      });
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();

      // Honeypot — bots fill hidden fields, humans don't
      var hp = form.querySelector('[name="_hp"]');
      if (hp && hp.value) return;

      if (!validate(form)) return;

      var data = collect(form);
      var button = form.querySelector('button[type="submit"]');
      var box = form.querySelector(".form-alert");
      if (box) box.className = "form-alert";

      var endpoint = endpointFor(form);
      if (!endpoint) {
        mailtoFallback(form, data);
        alertBox(form, "success", form.dataset.fallbackMessage ||
          "Your email app should now be open with these details filled in — send it and we'll reply shortly.");
        form.reset();
        return;
      }

      if (button) { button.setAttribute("aria-busy", "true"); button.disabled = true; }

      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(data)
      })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (body) {
            if (!res.ok) throw new Error(body && body.error ? body.error : "Request failed with status " + res.status);
            alertBox(form, "success", form.dataset.successMessage ||
              "Thanks — we've received your message and will get back to you within a few working days.");
            form.reset();
          });
        })
        .catch(function (err) {
          var specific = err && err.message && !/^Request failed|Failed to fetch|NetworkError|Load failed/i.test(err.message);
          alertBox(form, "error", specific ? err.message :
            "Something went wrong sending that. Please try again in a moment, or call +91 73700 67005.");
        })
        .finally(function () {
          if (button) { button.removeAttribute("aria-busy"); button.disabled = false; }
        });
    });
  });

  /* ----------------------------------------------------------------------
     Footer year
     ---------------------------------------------------------------------- */
  document.querySelectorAll("[data-year]").forEach(function (el) {
    el.textContent = new Date().getFullYear();
  });
})();
