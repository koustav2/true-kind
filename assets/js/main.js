/* ==========================================================================
   True Kind Foundation — shared behaviour
   ==========================================================================
   CONFIGURE ME: paste your form endpoint below, then the contact and
   volunteer forms will POST submissions straight to your inbox/dashboard.

   Works out of the box with Formspree, Formsubmit, Basin, Getform, Web3Forms
   or any endpoint that accepts a JSON or FormData POST.

     Formspree  →  https://formspree.io/f/xxxxxxxx
     Getform    →  https://getform.io/f/xxxxxxxx
     Basin      →  https://usebasin.com/f/xxxxxxxx
     Formsubmit →  https://formsubmit.co/info@truekindfoundation.org

   Leave it as "" and the forms fall back to opening the visitor's email
   app (the old behaviour), so nothing breaks before you set this up.
   ========================================================================== */

var FORM_ENDPOINT = "";
var FALLBACK_EMAIL = "info@truekindfoundation.org";

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
     Impact rings — animate to their percentage when scrolled into view
     ---------------------------------------------------------------------- */
  (function rings() {
    var els = document.querySelectorAll(".ring-progress");
    if (!els.length) return;
    var CIRC = 339; // 2πr, r = 54

    function fill(el) {
      var pct = parseFloat(el.dataset.pct) || 0;
      el.style.strokeDashoffset = CIRC - (CIRC * pct) / 100;
    }
    if (!("IntersectionObserver" in window) || reduceMotion) {
      els.forEach(fill);
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { fill(entry.target); io.unobserve(entry.target); }
      });
    }, { threshold: 0.4 });
    els.forEach(function (el) { io.observe(el); });
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
    document.querySelectorAll(lift).forEach(function (el) {
      el.classList.add("reveal");
      el.style.transitionDelay = Math.min(i % 4, 3) * 0.07 + "s";
      i++;
    });
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
  var CONFIGURED = /^https?:\/\//i.test(FORM_ENDPOINT);

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

      if (!CONFIGURED) {
        mailtoFallback(form, data);
        alertBox(form, "success", form.dataset.fallbackMessage ||
          "Your email app should now be open with these details filled in — send it and we'll reply shortly.");
        form.reset();
        return;
      }

      if (button) { button.setAttribute("aria-busy", "true"); button.disabled = true; }

      fetch(FORM_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(data)
      })
        .then(function (res) {
          if (!res.ok) throw new Error("Request failed with status " + res.status);
          alertBox(form, "success", form.dataset.successMessage ||
            "Thanks — we've received your message and will get back to you within a few working days.");
          form.reset();
        })
        .catch(function () {
          alertBox(form, "error",
            "Something went wrong sending that. Please email us directly at " + FALLBACK_EMAIL +
            " or call +91 73700 67005.");
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
