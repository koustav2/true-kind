module.exports = {
  org: {
    name: 'True Kind Foundation',
    email: 'info@truekindfoundation.org',
    phone: '+91 73700 67005',
    address: 'Plot No 221-245, NH-16, Gelpur, Gopabandhupur, Bhadrak, Odisha - 756181',
    regNo: '40232603192',
    darpan: 'OR/2026/1126881',
    pan: 'AAFTT5651D'
  },
  // Membership plans (paise). Annual is the recommended plan.
  plans: {
    monthly: { label: 'Monthly', amount: 100 * 100, months: 1 },
    annual:  { label: 'Annual (recommended)', amount: 1000 * 100, months: 12 }
  },
  // Preset amounts offered as one-tap chips on the donation form. These mirror
  // the three cost tiers published on donate.html, plus a low entry point.
  donationPresets: [500, 1500, 3000, 6000, 25000],

  donationCategories: [
    'Skill Development', "Women's Empowerment", 'Digital Education',
    'Health & Safety', 'Environment', 'Where it is needed most'
  ],

  /* One line per category, shown on the cause cards of the donation page so the
     donor picks a programme rather than a word off a dropdown. Keyed by the
     exact category string above — a category with no entry here simply renders
     without a description, so adding to the list above can never break the
     page. */
  donationCategoryBlurbs: {
    'Skill Development':       'Trade and digital-skills training for young people, through to a first job.',
    "Women's Empowerment":     'Savings-and-enterprise collectives: training, materials and market access.',
    'Digital Education':       'Devices, connectivity and teaching time for students without either.',
    'Health & Safety':         'Preventive-care camps, screening and follow-up for the cases that need it.',
    'Environment':             'Plantation drives, waste segregation and water-body restoration.',
    'Where it is needed most': 'We assign it to whichever programme is furthest from its budget this quarter.'
  },

  /* What each preset amount is costed against. INDICATIVE: these mirror the
     three published tiers on donate.html and are budget figures, not a promise
     that one specific donation bought one specific thing. The page says exactly
     that under the chips. A preset with no entry renders as a plain chip. */
  donationImpact: {
    500:   'Learning materials for one participant',
    1500:  'One trainee, one month of skills training',
    3000:  'A week of digital-literacy classes for a batch',
    6000:  'One full community health camp',
    25000: 'Seed support for a women’s enterprise collective'
  }
};
