/* ==========================================================================
   Document verification.

   WHAT WAS WRONG
   --------------
   Every card, certificate and receipt already carried a QR code and a Code128
   barcode. Both encoded the bare serial string — "TKF-M-2026-1E9EFF" — and
   nothing anywhere could resolve it. Scanning a membership card with a phone
   produced a line of text. The printed caption underneath said "Verify this
   document by quoting the serial above", which was accurate and also an
   admission: verification meant ringing the office.

   WHAT IT DOES NOW
   ----------------
   The QR encodes a URL. Scanning it with any phone camera opens a public page
   that says, in words, whether the document is valid, expired, revoked or
   unknown — resolved against the database, live. That is the difference between
   a decorative QR and a verification system.

   FOUR THINGS WORTH KNOWING, because each is a decision rather than an accident:

   1. The barcode still carries the bare serial. A Code128 scanner at a desk is
      a keyboard-emulating device; it types what it reads into a field. A URL
      there is noise. The QR is for phones, the barcode is for scanners, and
      they carry different payloads on purpose.

   2. The signature in the URL is ADVISORY, never a gate. `?k=` is a short HMAC
      over the code. It lets the verification page report whether a scanned link
      was one we issued, and it makes guessing complete URLs impractical. But the
      DATABASE is the authority: a valid code with a wrong signature still
      verifies, and is flagged for review.

      This matters operationally. If the signature were a gate, rotating
      SESSION_SECRET — something you are actively supposed to do, and something
      the deployment notes tell the client to do — would silently invalidate
      every card, certificate and receipt already in people's hands. A security
      control that turns thousands of printed documents into forgeries on a key
      rotation is not a security control.

   3. Enumeration is bounded by the code space and the rate limiter, not by the
      signature. A serial is PREFIX-YEAR-6HEX: 16.7 million per prefix per year.
      With the /verify rate limit that is not a realistic attack, and it is the
      same exposure any verifiable-credential scheme accepts.

   4. Codes are looked up by PREFIX, so an unknown prefix is rejected before it
      reaches the database at all.
   ========================================================================== */
'use strict';

const crypto = require('crypto');

/* The prefixes serial() issues, and what each one is.
   Order matters only for readability; lookup is exact-prefix. */
const KINDS = {
  'TKF-M':  { kind: 'member',      label: 'Membership card' },
  'TKF-MR': { kind: 'membership',  label: 'Membership fee receipt' },
  'TKF-C':  { kind: 'certificate', label: 'Certificate' },
  // A certificate issued to somebody with no account. Same label on the public
  // page — a certificate is a certificate to whoever is holding it — but a
  // different table behind it.
  'TKF-VC': { kind: 'visitorcert', label: 'Certificate' },
  'TKF-R':  { kind: 'receipt',     label: 'Donation receipt' },
  /* Registered HERE, in the same change as the table and the route — not
     afterwards. TKF-VC went out for a while with no line in this object, and
     every visitor certificate issued in that window scanned as "not recognised"
     by a verifier that had never been told the prefix existed. A serial the
     verifier does not know is worse than no QR at all: it invites a check and
     then fails it. */
  'TKF-AL': { kind: 'appointment', label: 'Appointment letter' }
};

/* Longest prefix first, so TKF-MR is never mistaken for TKF-M. */
const PREFIXES = Object.keys(KINDS).sort((a, b) => b.length - a.length);

/** Normalise whatever a human typed or a scanner read. */
function normalise(raw) {
  return String(raw == null ? '' : raw).trim().toUpperCase().replace(/\s+/g, '');
}

/** Which sort of document a code refers to, or null if the prefix is unknown. */
function kindOf(raw) {
  const code = normalise(raw);
  for (const p of PREFIXES) {
    if (code.startsWith(p + '-')) return { prefix: p, ...KINDS[p] };
  }
  return null;
}

/* The signing key. VERIFY_SECRET if it is set, otherwise derived from
   SESSION_SECRET so this works on an existing deployment with no new
   configuration. Derived, not used directly, so the session key never appears
   in a printed URL even indirectly. */
function key() {
  const base = process.env.VERIFY_SECRET || process.env.SESSION_SECRET || 'truekind-dev-only';
  return crypto.createHmac('sha256', 'truekind/verify/v1').update(base).digest();
}

/** Short tag over a code. 10 base32-ish chars — enough to be unguessable,
    short enough to keep the QR low-density and readable off a small card. */
function tag(raw) {
  const code = normalise(raw);
  return crypto.createHmac('sha256', key()).update(code).digest('base64')
    .replace(/[^A-Za-z0-9]/g, '').slice(0, 10);
}

/** 'ok' | 'missing' | 'mismatch' — reported, never enforced. See note 2. */
function checkTag(raw, supplied) {
  if (!supplied) return 'missing';
  const expected = Buffer.from(tag(raw));
  const got = Buffer.from(String(supplied));
  if (expected.length !== got.length) return 'mismatch';
  return crypto.timingSafeEqual(expected, got) ? 'ok' : 'mismatch';
}

/* The origin printed into the QR. APP_BASE_URL is already required for the
   payment gateway's return URL, so it is always set in a real deployment. The
   fallback is the live site rather than localhost: a QR printed onto a physical
   card with "localhost" in it is a card that has to be reprinted. */
function origin() {
  const base = process.env.APP_BASE_URL || 'https://truekind.truehr.co.in';
  return base.replace(/\/+$/, '');
}

/** The URL to encode in a QR code. */
function verifyUrl(raw) {
  const code = normalise(raw);
  return `${origin()}/verify/${encodeURIComponent(code)}?k=${tag(code)}`;
}

/* One salted hash per address, for the scan log. Salted with the same derived
   key, so the log cannot be turned back into a list of addresses. */
function hashIp(ip) {
  if (!ip) return null;
  return crypto.createHmac('sha256', key()).update(String(ip)).digest('hex').slice(0, 32);
}

/* ---- resolution ---------------------------------------------------------
   Given a code, find the document and decide its status. Returns a plain
   object shaped for both the HTML page and the JSON API.

   Deliberately narrow on what it exposes: the holder's name, the type, the
   dates and the status — the things already printed on the document in the
   scanner's hand. No email, no phone, no address. A receipt shows its amount,
   because confirming the figure is the entire reason to verify a receipt.
   --------------------------------------------------------------------------- */
async function resolve(models, raw) {
  const code = normalise(raw);
  const info = kindOf(code);
  if (!info) return { code, found: false, status: 'not_found', kind: null };

  const { User, CertificateIssue, Certificate, Donation, MembershipPayment,
          VisitorCertificate, AppointmentLetter, Revocation } = models;
  const now = new Date();
  const out = { code, kind: info.kind, label: info.label, found: false, status: 'not_found' };

  if (info.kind === 'member') {
    const u = await User.findOne({ where: { memberId: code } });
    if (u) {
      Object.assign(out, {
        found: true,
        holder: u.name,
        issuedOn: u.membershipPaidAt || u.createdAt,
        validUntil: u.membershipValidTill,
        status: u.membershipValid ? 'valid' : 'expired'
      });
    }
  } else if (info.kind === 'certificate') {
    const i = await CertificateIssue.findOne({
      where: { serial: code },
      include: [
        { model: Certificate, as: 'certificate', attributes: ['title'] },
        { model: User, as: 'user', attributes: ['name'] }
      ]
    });
    if (i) {
      Object.assign(out, {
        found: true,
        holder: i.user ? i.user.name : null,
        title: i.certificate ? i.certificate.title : null,
        issuedOn: i.issuedAt,
        // A certificate does not expire. It is valid until it is revoked.
        status: 'valid'
      });
    }
  } else if (info.kind === 'visitorcert') {
    const v = await VisitorCertificate.findOne({ where: { serial: code } });
    if (v) {
      Object.assign(out, {
        found: true,
        holder: v.name,
        title: v.programme || null,
        issuedOn: v.issuedOn ? new Date(v.issuedOn) : v.createdAt,
        // Like a member certificate: valid until withdrawn.
        status: 'valid'
      });
    }
  } else if (info.kind === 'appointment') {
    /* NOTHING ABOUT THE TERMS IS PUBLISHED HERE. /verify is a public page — no
       login — so it answers only the question a stranger holding the document is
       entitled to ask: is this letter genuine and does it still stand. Salary,
       department and reporting line are none of their business, and a
       verification page that leaks a person's pay is worse than no verification
       page. The designation goes out because it is what the letter is FOR: the
       holder is showing you the letter to prove they hold that post. */
    const l = AppointmentLetter && await AppointmentLetter.findOne({ where: { serial: code } });
    if (l) {
      Object.assign(out, {
        found: true,
        holder: l.name,
        title: l.designation || null,
        issuedOn: l.letterDate ? new Date(l.letterDate) : l.createdAt,
        // An appointment letter does not carry its own expiry. It stands until
        // it is withdrawn — which the Revocations check below reports.
        status: 'valid'
      });
    }
  } else if (info.kind === 'receipt') {
    const d = await Donation.findOne({ where: { receiptNo: code } });
    if (d) {
      Object.assign(out, {
        found: true,
        holder: (d.guest && d.guest.name) || null,
        title: d.category,
        amount: d.amount,
        issuedOn: d.paidAt || d.createdAt,
        status: d.status === 'paid' ? 'valid' : 'expired'
      });
      if (!out.holder && d.userId && User) {
        const u = await User.findByPk(d.userId);
        if (u) out.holder = u.name;
      }
    }
  } else if (info.kind === 'membership') {
    const p = await MembershipPayment.findOne({ where: { receiptNo: code } });
    if (p) {
      const u = await User.findByPk(p.userId);
      Object.assign(out, {
        found: true,
        holder: u ? u.name : null,
        amount: p.amount,
        issuedOn: p.paidAt || p.createdAt,
        validUntil: p.validTill,
        status: 'valid'
      });
    }
  }

  /* Revocation overrides everything. A revoked document is not "expired" and it
     is certainly not "not found" — it is withdrawn, and the page has to say so,
     because the holder may be standing there with it. */
  if (out.found) {
    const rev = await Revocation.findOne({ where: { code } });
    if (rev) {
      out.status = 'revoked';
      out.revokedAt = rev.revokedAt;
      out.revokedReason = rev.reason || null;
    }
  }

  return out;
}

module.exports = {
  KINDS, normalise, kindOf, tag, checkTag, verifyUrl, hashIp, resolve, origin
};
