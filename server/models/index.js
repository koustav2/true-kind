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

// Associations
Donation.belongsTo(User, { as: 'user', foreignKey: 'userId' });
User.hasMany(Donation, { as: 'donations', foreignKey: 'userId' });
Certificate.hasMany(CertificateIssue, { as: 'issued', foreignKey: 'certificateId' });
CertificateIssue.belongsTo(Certificate, { as: 'certificate', foreignKey: 'certificateId' });
CertificateIssue.belongsTo(User, { as: 'user', foreignKey: 'userId' });
CertificateIssue.belongsTo(Donation, { as: 'donation', foreignKey: 'donationId' });

module.exports = {
  sequelize, User, Donation, Certificate, CertificateIssue, SiteContent, FormConfig,
  Volunteer, Enquiry, MediaAsset, UserAccess, VolunteerLogin, CertificateFile
};
