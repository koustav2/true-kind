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

// Associations
Donation.belongsTo(User, { as: 'user', foreignKey: 'userId' });
User.hasMany(Donation, { as: 'donations', foreignKey: 'userId' });
Certificate.hasMany(CertificateIssue, { as: 'issued', foreignKey: 'certificateId' });
CertificateIssue.belongsTo(Certificate, { as: 'certificate', foreignKey: 'certificateId' });
CertificateIssue.belongsTo(User, { as: 'user', foreignKey: 'userId' });
CertificateIssue.belongsTo(Donation, { as: 'donation', foreignKey: 'donationId' });

module.exports = { sequelize, User, Donation, Certificate, CertificateIssue, SiteContent, FormConfig };
