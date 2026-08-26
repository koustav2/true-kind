const { DataTypes } = require('sequelize');
const { sequelize } = require('../db');

// NOTE: every model exposes a virtual `_id` (= id) so the EJS views written
// against the earlier MongoDB version keep working unchanged.

const User = sequelize.define('User', {
  _id:   { type: DataTypes.VIRTUAL, get() { return this.id; } },
  name:  { type: DataTypes.STRING, allowNull: false },
  email: { type: DataTypes.STRING, allowNull: false, unique: true, set(v) { this.setDataValue('email', String(v).toLowerCase().trim()); } },
  phone: { type: DataTypes.STRING, allowNull: false },
  passwordHash: { type: DataTypes.STRING, allowNull: false },
  role:   { type: DataTypes.ENUM('member', 'admin'), defaultValue: 'member' },
  status: { type: DataTypes.ENUM('guest', 'active'), defaultValue: 'guest' },
  memberId: { type: DataTypes.STRING, unique: true, allowNull: true },
  membershipPlan:      { type: DataTypes.ENUM('monthly', 'annual'), allowNull: true },
  membershipPaidAt:    DataTypes.DATE,
  membershipValidTill: DataTypes.DATE,
  membershipTxn:       DataTypes.STRING,
  address: DataTypes.STRING,
  city:    DataTypes.STRING,
  pan:     DataTypes.STRING,
  // Views/PDFs use user.membership.plan / .validTill and user.membershipValid
  membership: { type: DataTypes.VIRTUAL, get() {
    return this.membershipPlan ? {
      plan: this.membershipPlan, paidAt: this.membershipPaidAt,
      validTill: this.membershipValidTill, txnId: this.membershipTxn
    } : null;
  }},
  membershipValid: { type: DataTypes.VIRTUAL, get() {
    return this.status === 'active' && this.membershipValidTill && this.membershipValidTill > new Date();
  }}
});

const Donation = sequelize.define('Donation', {
  _id:  { type: DataTypes.VIRTUAL, get() { return this.id; } },
  kind: { type: DataTypes.ENUM('member', 'guest'), allowNull: false },
  guest: { type: DataTypes.JSON, allowNull: true },  // {name,email,phone,address,city,pan,bankName,branchName}
  category: { type: DataTypes.STRING, allowNull: false },
  amount:   { type: DataTypes.INTEGER, allowNull: false },   // paise
  status:   { type: DataTypes.ENUM('initiated', 'paid', 'failed'), defaultValue: 'initiated' },
  txnId:    { type: DataTypes.STRING, unique: true },
  gatewayRef: DataTypes.STRING,
  receiptNo:  { type: DataTypes.STRING, unique: true, allowNull: true },
  extra:  { type: DataTypes.JSON, defaultValue: {} },        // admin-configured fields
  paidAt: DataTypes.DATE
});

const Certificate = sequelize.define('Certificate', {
  _id:   { type: DataTypes.VIRTUAL, get() { return this.id; } },
  title: { type: DataTypes.STRING, allowNull: false },
  description: DataTypes.TEXT
});

// Proper relational issuance table (was an embedded array in Mongo)
const CertificateIssue = sequelize.define('CertificateIssue', {
  _id:    { type: DataTypes.VIRTUAL, get() { return this.id; } },
  serial: { type: DataTypes.STRING, allowNull: false, unique: true },
  issuedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
});

const SiteContent = sequelize.define('SiteContent', {
  key:  { type: DataTypes.STRING, allowNull: false, unique: true },
  data: { type: DataTypes.JSON, defaultValue: {} }
});

const FormConfig = sequelize.define('FormConfig', {
  formKey: { type: DataTypes.STRING, allowNull: false, unique: true },
  fields:  { type: DataTypes.JSON, defaultValue: [] }
});

// CMS media library. Deliberately a NEW table: the app runs a bare
// sequelize.sync(), which creates tables but never adds a column to an existing
// one — extending a current model would define a column the live database does
// not have and then fail at query time. A new table is safe on every deployment.
const MediaAsset = sequelize.define('MediaAsset', {
  _id:      { type: DataTypes.VIRTUAL, get() { return this.id; } },
  kind:     { type: DataTypes.ENUM('image', 'video'), allowNull: false },
  filename: { type: DataTypes.STRING, allowNull: false, unique: true },  // on-disk name (uuid.ext)
  original: { type: DataTypes.STRING },                                  // what the admin called it
  url:      { type: DataTypes.STRING, allowNull: false },                // /uploads/<filename>
  mimetype: { type: DataTypes.STRING },
  bytes:    { type: DataTypes.INTEGER },
  alt:      { type: DataTypes.STRING },
  uploadedBy: { type: DataTypes.INTEGER }
});

// Public-site volunteer registrations (no login — an application the admin
// follows up on by phone/email, then tracks with a status).
const Volunteer = sequelize.define('Volunteer', {
  _id:   { type: DataTypes.VIRTUAL, get() { return this.id; } },
  name:  { type: DataTypes.STRING, allowNull: false },
  email: { type: DataTypes.STRING, allowNull: false },
  phone: { type: DataTypes.STRING, allowNull: false },
  city:  DataTypes.STRING,
  type:  DataTypes.STRING,          // "I am a" — student / professional / ...
  availability: DataTypes.STRING,
  interests:    DataTypes.STRING,   // comma-joined program areas
  message:      DataTypes.TEXT,
  status: { type: DataTypes.ENUM('new', 'contacted', 'active', 'inactive'), defaultValue: 'new' }
});

// Public-site contact form enquiries.
const Enquiry = sequelize.define('Enquiry', {
  _id:   { type: DataTypes.VIRTUAL, get() { return this.id; } },
  name:  { type: DataTypes.STRING, allowNull: false },
  email: { type: DataTypes.STRING, allowNull: false },
  subject: DataTypes.STRING,
  message: { type: DataTypes.TEXT, allowNull: false },
  status: { type: DataTypes.ENUM('new', 'replied', 'closed'), defaultValue: 'new' }
});

/* ---------------------------------------------------------------------------
   The three tables below are all NEW, and that is a deliberate constraint, not
   a preference. The app runs a bare `sequelize.sync()` with no migration tool:
   it creates missing tables, but it never adds a column to an existing one and
   never extends an ENUM. Anything added to a current model would exist in the
   model and be absent from the live Postgres, failing at query time.

   So specifically:
     - blocking a user does NOT reuse User.status. That column is a MEMBERSHIP
       state — routes/payment.js sets it to 'active' when someone pays — so a
       blocked user would be indistinguishable from an unpaid guest, and paying
       again would silently unblock them.
     - certificate files do NOT go in MediaAsset. Its `kind` is ENUM('image',
       'video') and that table is already live, so 'document' cannot be added.
   --------------------------------------------------------------------------- */

/* Access control, separate from membership. One row per user, created lazily. */
const UserAccess = sequelize.define('UserAccess', {
  _id:    { type: DataTypes.VIRTUAL, get() { return this.id; } },
  userId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
  blocked:   { type: DataTypes.BOOLEAN, defaultValue: false },
  blockedAt: DataTypes.DATE,
  blockedBy: DataTypes.INTEGER,     // admin user id, for the audit trail
  note:      DataTypes.STRING,
  // Set when an admin issues a temporary password. The holder must change it at
  // next sign-in; until then they can reach nothing but the change-password page.
  mustChangePassword: { type: DataTypes.BOOLEAN, defaultValue: false },
  passwordIssuedAt:   DataTypes.DATE
});

/* Links a public volunteer registration to a real login account. Volunteers
   arrive as form submissions with no credentials; an admin turns one into an
   account explicitly. */
const VolunteerLogin = sequelize.define('VolunteerLogin', {
  _id:         { type: DataTypes.VIRTUAL, get() { return this.id; } },
  volunteerId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
  userId:      { type: DataTypes.INTEGER, allowNull: false },
  issuedAt:    { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
});

/* An uploaded certificate template or scan — image or PDF. */
const CertificateFile = sequelize.define('CertificateFile', {
  _id:           { type: DataTypes.VIRTUAL, get() { return this.id; } },
  certificateId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
  url:           { type: DataTypes.STRING, allowNull: false },
  filename:      { type: DataTypes.STRING, allowNull: false },
  original:      DataTypes.STRING,
  mimetype:      DataTypes.STRING,
  bytes:         DataTypes.INTEGER,
  uploadedBy:    DataTypes.INTEGER
});

/* ---------------------------------------------------------------------------
   One row per membership fee actually received.

   Until now a membership payment left no record of its own: routes/payment.js
   wrote the plan, the paid-at date and the gateway reference onto the User row
   and that was it. Three things followed from that, all of them problems:

     - No receipt. Donations get a receiptNo; memberships got nothing, so there
       was no membership receipt to hand anyone and no list to reconcile
       against.
     - Only one payment could ever be remembered. A renewal overwrote the
       previous one, so a member's payment history was always exactly one row
       deep.
     - Cash and bank transfers were impossible to record at all. Membership
       could ONLY be granted by completing a PhonePe checkout, which is not how
       most of these fees are actually collected.

   A table fixes all three. It is a NEW table because the app runs a bare
   sequelize.sync(): columns can never be added to User, but a new table is
   created safely on every deployment.

   `recordedBy` is null when the member paid online themselves, and the admin's
   user id when an admin entered a payment taken offline — that distinction is
   the audit trail, so a fee marked paid by hand is always identifiable as such.
   --------------------------------------------------------------------------- */
const MembershipPayment = sequelize.define('MembershipPayment', {
  _id:    { type: DataTypes.VIRTUAL, get() { return this.id; } },
  userId: { type: DataTypes.INTEGER, allowNull: false },
  plan:   { type: DataTypes.STRING },                        // monthly | annual
  amount: { type: DataTypes.INTEGER, allowNull: false },      // paise, like Donation
  // Free-form rather than an ENUM on purpose: adding a payment method later
  // must not need a schema change, and an ENUM cannot be extended by sync().
  mode:      { type: DataTypes.STRING, defaultValue: 'online' },
  reference: { type: DataTypes.STRING },                     // gateway ref, UTR, cheque no
  receiptNo: { type: DataTypes.STRING, unique: true },
  paidAt:    { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  validTill: { type: DataTypes.DATE },
  recordedBy: { type: DataTypes.INTEGER },                   // null = paid online by the member
  note:       { type: DataTypes.STRING }
});

/* ---------------------------------------------------------------------------
   Certificate design.

   The client's reference admin lets you pick one of three certificate designs
   when you issue. `Certificate` is an existing table so it cannot gain a
   `template` column under a bare sync(), and the choice belongs to the
   certificate TYPE rather than to each issue — so it is one row per certificate
   type, created the first time somebody picks a design.
   --------------------------------------------------------------------------- */
const CertificateStyle = sequelize.define('CertificateStyle', {
  _id: { type: DataTypes.VIRTUAL, get() { return this.id; } },
  certificateId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
  template: { type: DataTypes.STRING, defaultValue: 'navy' }   // navy | purple | green
});

/* ---------------------------------------------------------------------------
   Visitor certificates.

   A certificate for somebody with no account — a visitor, a camp attendee, a
   guest speaker. CertificateIssue requires a userId, so issuing one of these
   through it would mean creating a login for a person who never asked for one,
   with a password nobody knows.

   Own table, own serial prefix (TKF-VC), verifiable through /verify like
   everything else.
   --------------------------------------------------------------------------- */
const VisitorCertificate = sequelize.define('VisitorCertificate', {
  _id:    { type: DataTypes.VIRTUAL, get() { return this.id; } },
  serial: { type: DataTypes.STRING, allowNull: false, unique: true },
  name:   { type: DataTypes.STRING, allowNull: false },
  fatherName: { type: DataTypes.STRING },
  mobile:     { type: DataTypes.STRING },
  email:      { type: DataTypes.STRING },
  programme:  { type: DataTypes.STRING },
  template:   { type: DataTypes.STRING, defaultValue: 'navy' },
  issuedOn:   { type: DataTypes.DATEONLY },
  issuedBy:   { type: DataTypes.INTEGER }
});

/* ---------------------------------------------------------------------------
   Appointment letters.

   Another new table, for the usual reason: sync() cannot add a column to a
   live one.

   THE RECIPIENT IS SNAPSHOTTED, NOT JOINED. userId records who it went to, but
   name / address / phone / email / designation are COPIED IN at the moment of
   issue and read back from here when the PDF is generated. That is deliberate.
   A letter is a historical document: it said what it said on the day it was
   signed. Rendering it from a live join means somebody moving house in 2028
   silently rewrites the address on a letter dated 2026, and the copy in the
   filing cabinet stops matching the copy the portal prints.

   `kind` is a STRING, not an ENUM, and that is also deliberate. Staff today;
   volunteer and board letters are the obvious next ask, and sync() cannot
   extend an ENUM on a live table — so an ENUM here would mean the second
   variant needs a hand-written migration on a running database. A string costs
   nothing and is validated in the route.

   Terms are stored per letter rather than read from config, because probation
   and notice are negotiated per person, and because a letter must keep printing
   the terms it was issued under even after the organisation's standard changes.

   No `revoked` column: withdrawal goes in the shared Revocations table, keyed
   by serial, same as cards and certificates. One place answers "is this
   document still good", which is the only way /verify can stay honest.
   --------------------------------------------------------------------------- */
const AppointmentLetter = sequelize.define('AppointmentLetter', {
  _id:    { type: DataTypes.VIRTUAL, get() { return this.id; } },
  serial: { type: DataTypes.STRING, allowNull: false, unique: true },
  userId: { type: DataTypes.INTEGER },              // who it went to
  kind:   { type: DataTypes.STRING, defaultValue: 'staff' },

  // Recipient, as printed.
  name:    { type: DataTypes.STRING, allowNull: false },
  address: { type: DataTypes.STRING },
  phone:   { type: DataTypes.STRING },
  email:   { type: DataTypes.STRING },

  // Terms, as agreed.
  designation:    { type: DataTypes.STRING },
  department:     { type: DataTypes.STRING },
  reportsTo:      { type: DataTypes.STRING },
  location:       { type: DataTypes.STRING },
  joiningDate:    { type: DataTypes.DATEONLY },
  employmentType: { type: DataTypes.STRING },
  probation:      { type: DataTypes.STRING },
  grossMonthly:   { type: DataTypes.INTEGER },      // rupees, not paise — this
                                                    // is a typed-in salary, not
                                                    // a gateway amount
  annualCtc:      { type: DataTypes.INTEGER },
  hours:          { type: DataTypes.STRING },
  notice:         { type: DataTypes.STRING },

  signatoryName: { type: DataTypes.STRING },
  signatoryRole: { type: DataTypes.STRING },

  letterDate: { type: DataTypes.DATEONLY },
  issuedBy:   { type: DataTypes.INTEGER }
});

/* ---------------------------------------------------------------------------
   Donations taken offline.

   Donation.kind is ENUM('member','guest') and that table is live, so 'cash'
   cannot be added to it. A cash or bank donation is therefore stored as an
   ordinary Donation — so it appears in the lists, the totals and the reporting
   like any other — with a row here recording HOW it arrived and who entered it.

   Same reasoning as MembershipPayment.recordedBy: a payment entered by hand has
   to stay distinguishable from one the gateway confirmed, or the accounts cannot
   be reconciled.
   --------------------------------------------------------------------------- */
const OfflineDonation = sequelize.define('OfflineDonation', {
  _id: { type: DataTypes.VIRTUAL, get() { return this.id; } },
  donationId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
  mode:       { type: DataTypes.STRING },        // cash | bank | upi | cheque
  reference:  { type: DataTypes.STRING },
  recordedBy: { type: DataTypes.INTEGER },
  note:       { type: DataTypes.STRING }
});

/* ---------------------------------------------------------------------------
   Notices.

   IMPORTANT: these are shown INSIDE the portal, on the member's dashboard.
   They are not emailed and not sent by SMS, because this application has no
   mail sender and no SMS gateway — there is no nodemailer, no SMTP config, no
   provider credential anywhere in it.

   That constraint is written here because the obvious next request is "send it
   to everyone", and the honest answer is that it would need a mail provider
   first. A "Send Notice" screen that quietly only posts to a dashboard, while
   letting an admin believe it emailed 508 members, is worse than no feature.
   The screen says so plainly.
   --------------------------------------------------------------------------- */
const Notice = sequelize.define('Notice', {
  _id:   { type: DataTypes.VIRTUAL, get() { return this.id; } },
  title: { type: DataTypes.STRING, allowNull: false },
  body:  { type: DataTypes.TEXT, allowNull: false },
  // all = everyone who signs in; members = paid members only; guests = unpaid
  audience:  { type: DataTypes.STRING, defaultValue: 'all' },
  pinned:    { type: DataTypes.BOOLEAN, defaultValue: false },
  active:    { type: DataTypes.BOOLEAN, defaultValue: true },
  expiresOn: { type: DataTypes.DATEONLY },
  createdBy: { type: DataTypes.INTEGER }
});

/* ---------------------------------------------------------------------------
   Manager accounts.

   A manager works the queues — records payments, issues certificates, answers
   enquiries — without full admin rights. User.role is ENUM('member','admin')
   and cannot gain a third value under a bare sync(), so a manager is a member
   row with a grant here.

   `sections` is an ALLOWLIST, and the guard that reads it is default-deny: a
   route not explicitly mapped to a section is admin-only. That direction
   matters. If it were default-allow, every route added later would silently
   become manager-accessible, and the person adding it would have no reason to
   think about who should see it.

   Deliberately NOT grantable: account deactivation, volunteer logins, password
   issuing, the CMS, the media library, the board, deletion of anything, and
   this table itself. A manager who can create managers is an admin.
   --------------------------------------------------------------------------- */
const ManagerAccess = sequelize.define('ManagerAccess', {
  _id:    { type: DataTypes.VIRTUAL, get() { return this.id; } },
  userId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
  sections: { type: DataTypes.JSON, defaultValue: [] },
  note:      { type: DataTypes.STRING },
  grantedBy: { type: DataTypes.INTEGER },
  active:    { type: DataTypes.BOOLEAN, defaultValue: true }
});

/* ---------------------------------------------------------------------------
   ID card details.

   The printed card carries a designation, a department, a blood group, a date
   of joining and a photograph. None of those are columns on User and none can
   become columns on User: the app runs a bare sequelize.sync(), which never
   adds a column to a table that already exists. So they live here, one row per
   person, created the first time somebody fills the card in.

   `cardType` decides the wording on the card itself — MEMBER / STAFF /
   VOLUNTEER ID CARD — because the same layout serves all three and the only
   real difference is the label and which id number is printed.
   --------------------------------------------------------------------------- */
const IdCardProfile = sequelize.define('IdCardProfile', {
  _id:    { type: DataTypes.VIRTUAL, get() { return this.id; } },
  userId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
  cardType:    { type: DataTypes.STRING, defaultValue: 'member' },  // member | staff | volunteer
  // A staff card prints this instead of the Member ID. Free-form so the client
  // can keep whatever numbering they already use on paper.
  employeeCode: { type: DataTypes.STRING },
  designation:  { type: DataTypes.STRING },
  department:   { type: DataTypes.STRING },
  bloodGroup:   { type: DataTypes.STRING },
  joinedOn:     { type: DataTypes.DATEONLY },
  photoUrl:     { type: DataTypes.STRING },
  photoFile:    { type: DataTypes.STRING },      // on-disk name, so a replace can unlink
  issuedOn:     { type: DataTypes.DATEONLY },
  validUntil:   { type: DataTypes.DATEONLY },
  updatedBy:    { type: DataTypes.INTEGER }
});

/* ---------------------------------------------------------------------------
   Revocation.

   A card, certificate or receipt that has been withdrawn. Kept as its own
   table rather than a flag for two reasons: the flag cannot be added to the
   existing tables, and — more importantly — revocation needs a reason, a date
   and a name against it. "Revoke" used to mean DELETE the certificate issue
   row, which destroyed the evidence that the certificate had ever existed and
   left an already-printed certificate verifying as simply "not found".

   Now the row survives, and its serial verifies as REVOKED with a date. That is
   the difference between a verification system and a lookup table.
   --------------------------------------------------------------------------- */
const Revocation = sequelize.define('Revocation', {
  _id:  { type: DataTypes.VIRTUAL, get() { return this.id; } },
  code: { type: DataTypes.STRING, allowNull: false, unique: true },  // the serial/receipt/member id
  kind: { type: DataTypes.STRING },                                  // member | certificate | receipt | membership
  reason:     { type: DataTypes.STRING },
  revokedBy:  { type: DataTypes.INTEGER },
  revokedAt:  { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
});

/* ---------------------------------------------------------------------------
   Verification scans.

   Every hit on /verify/<code>, whether it resolved or not. Two uses: the client
   can see that a card was checked at the gate, and a run of `not_found` results
   from one address is what someone trying codes at random looks like.

   No raw IP is stored — a salted hash, which is enough to spot repetition
   without keeping a log of who looked at what.
   --------------------------------------------------------------------------- */
const VerificationScan = sequelize.define('VerificationScan', {
  _id:  { type: DataTypes.VIRTUAL, get() { return this.id; } },
  code: { type: DataTypes.STRING, allowNull: false },
  kind: { type: DataTypes.STRING },
  result: { type: DataTypes.STRING },        // valid | expired | revoked | not_found
  signature: { type: DataTypes.STRING },     // ok | missing | mismatch
  ipHash:    { type: DataTypes.STRING },
  userAgent: { type: DataTypes.STRING }
});

/* ---------------------------------------------------------------------------
   The board of trustees, as data.

   about.html used to carry four hardcoded cards — Chairperson, Vice
   Chairperson, Secretary, Treasurer — with four matching photo slots in the
   CMS registry. That could never satisfy "add more people": the registry is a
   fixed list of fields generated from the HTML, so a fifth trustee meant a code
   change and a redeploy.

   A table can hold any number of rows, so this is a table. The four cards stay
   in the HTML as the fallback: if this list is empty, or the request for it
   fails, the page shows the original four rather than an empty section.

   `visible` rather than deleting: a trustee who steps down usually comes off the
   website before the paperwork is settled, and an accidental delete of someone's
   photograph and details is not recoverable.
   --------------------------------------------------------------------------- */
const BoardMember = sequelize.define('BoardMember', {
  _id:  { type: DataTypes.VIRTUAL, get() { return this.id; } },
  name: { type: DataTypes.STRING, allowNull: false },
  designation: { type: DataTypes.STRING },        // Chairperson, Treasurer, ...
  email:    { type: DataTypes.STRING },
  photoUrl: { type: DataTypes.STRING },           // /uploads/<file>
  photoFile:{ type: DataTypes.STRING },           // on-disk name, so a replace can unlink
  bio:      { type: DataTypes.TEXT },
  facebook: { type: DataTypes.STRING },
  linkedin: { type: DataTypes.STRING },
  twitter:  { type: DataTypes.STRING },           // X / Twitter
  instagram:{ type: DataTypes.STRING },
  sortOrder:{ type: DataTypes.INTEGER, defaultValue: 0 },
  visible:  { type: DataTypes.BOOLEAN, defaultValue: true }
});

/* ---------------------------------------------------------------------------
   Press & media coverage, as data.

   press-release.html shipped with a static "coverage will be listed here"
   placeholder and no way to add real items — press mentions arrive on no
   fixed schedule and in no fixed number, so a handful of named CMS fields
   could never express "add one more clipping". Same reasoning as BoardMember:
   a table that can hold any number of rows, admin-managed, with an image per
   row via the same upload pattern.

   `visible` rather than deleting, for the same reason as everywhere else on
   this site: taking a mention down is common (an outlet's link rots, a
   client asks for it to come off), losing its photograph and details to an
   accidental delete is not recoverable.
   --------------------------------------------------------------------------- */
/* Gallery — photographs from events the team has run.

   A LIST with no fixed length, so it is a table rather than a set of CMS
   fields, for the same reason the board and the press list are: a registry of
   fixed slots cannot express "add one more photograph from Saturday".

   A new table is also the one schema change that is safe here. sequelize.sync()
   creates tables it has never seen; what it cannot do is add a column to a
   table that already exists. So a new feature gets its own table and nothing
   about the existing ones moves. */
const GalleryItem = sequelize.define('GalleryItem', {
  _id:   { type: DataTypes.VIRTUAL, get() { return this.id; } },
  title: { type: DataTypes.STRING, allowNull: false },
  photoUrl:  { type: DataTypes.STRING },          // /uploads/<file>
  photoFile: { type: DataTypes.STRING },          // on-disk name, so a replace can unlink
  sortOrder: { type: DataTypes.INTEGER, defaultValue: 0 },
  visible:   { type: DataTypes.BOOLEAN, defaultValue: true }
});

const PressItem = sequelize.define('PressItem', {
  _id:   { type: DataTypes.VIRTUAL, get() { return this.id; } },
  title: { type: DataTypes.STRING, allowNull: false },
  source:   { type: DataTypes.STRING },           // publication / outlet name
  url:      { type: DataTypes.STRING },           // link to the original coverage
  date:     { type: DataTypes.DATEONLY },
  excerpt:  { type: DataTypes.TEXT },
  photoUrl: { type: DataTypes.STRING },           // /uploads/<file>
  photoFile:{ type: DataTypes.STRING },           // on-disk name, so a replace can unlink
  sortOrder:{ type: DataTypes.INTEGER, defaultValue: 0 },
  visible:  { type: DataTypes.BOOLEAN, defaultValue: true }
});

// Associations
Donation.belongsTo(User, { as: 'user', foreignKey: 'userId' });
User.hasMany(Donation, { as: 'donations', foreignKey: 'userId' });
Certificate.hasMany(CertificateIssue, { as: 'issued', foreignKey: 'certificateId' });
CertificateIssue.belongsTo(Certificate, { as: 'certificate', foreignKey: 'certificateId' });
CertificateIssue.belongsTo(User, { as: 'user', foreignKey: 'userId' });
CertificateIssue.belongsTo(Donation, { as: 'donation', foreignKey: 'donationId' });
MembershipPayment.belongsTo(User, { as: 'user', foreignKey: 'userId' });
User.hasMany(MembershipPayment, { as: 'membershipPayments', foreignKey: 'userId' });
IdCardProfile.belongsTo(User, { as: 'user', foreignKey: 'userId' });
OfflineDonation.belongsTo(Donation, { as: 'donation', foreignKey: 'donationId' });
ManagerAccess.belongsTo(User, { as: 'user', foreignKey: 'userId' });

module.exports = {
  sequelize, User, Donation, Certificate, CertificateIssue, SiteContent, FormConfig,
  Volunteer, Enquiry, MediaAsset, UserAccess, VolunteerLogin, CertificateFile,
  BoardMember, MembershipPayment, IdCardProfile, Revocation, VerificationScan,
  CertificateStyle, VisitorCertificate, OfflineDonation, Notice, ManagerAccess,
  AppointmentLetter, PressItem, GalleryItem
};
