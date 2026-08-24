/* ==========================================================================
   RETIRED — kept only because this deployment target cannot delete files.

   This used to be a second, older content editor: `/portal/admin/content`
   ("Text content" in the nav) wrote five SiteContent rows — banner, about,
   team, works, press — and this file fetched them and wrote them into
   `data-cms-banner-headline`, `data-cms-about-heading`, `data-cms-team` and
   similar attributes on the public pages.

   The trouble is those attributes sat on the SAME elements the real,
   registry-driven CMS also edits — the homepage hero heading carried both
   `data-cms-banner-headline` (this file) and `data-cms="index.h1.1"`
   (assets/js/cms.js) at once. Both scripts ran on every page load, both
   fetched from a different endpoint, and whichever request happened to
   resolve first silently won — so an edit made in one editor could vanish the
   next time the page loaded, with no error anywhere. Nobody could tell the two
   editors apart from the admin nav; they looked like equally valid ways to
   change the same text.

   The fix was to delete the behaviour, not paper over it: the
   `data-cms-banner-*` / `data-cms-about-*` / `data-cms-team` / `data-cms-works`
   / `data-cms-press` attributes are gone from every page's HTML, the
   <script> tag that loaded this file is gone too, and `/portal/admin/content`
   now redirects to the real editor instead of rendering a form that saved into
   a dead end. See server/routes/admin.js and server/cms/ for what replaced it.

   This file is never loaded by any page any more. It is left here, empty, so a
   future reader who finds a stray reference knows what happened instead of
   finding nothing.
   ========================================================================== */
