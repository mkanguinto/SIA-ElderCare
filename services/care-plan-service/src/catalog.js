'use strict';

/**
 * Caregiver duty categories and suggested tasks.
 * Based on the family-caregiver duties described by caringinfo.org (NHPCO): personal care,
 * physical / medical care, meals and household, transportation, emotional and social support,
 * home safety, communication, and keeping records.
 *
 * GET /api/care/categories returns this catalogue so clinic staff can build a plan from suggestions
 * instead of typing every task.
 */
const CATEGORIES = [
  {
    code: 'personal_care',
    name: 'Personal care',
    description: 'Help with bathing, dressing, grooming, toileting and oral care while keeping the person\'s dignity.',
    suggestions: [
      { title: 'Help with bathing or sponge bath', frequency: 'daily', times: ['08:00'] },
      { title: 'Help with dressing', frequency: 'daily', times: ['07:30'] },
      { title: 'Oral care / denture cleaning', frequency: 'daily', times: ['08:00', '20:00'] },
      { title: 'Toileting / incontinence care', frequency: 'as_needed' },
      { title: 'Nail and skin care, check for pressure sores', frequency: 'weekly', daysOfWeek: [6] },
    ],
  },
  {
    code: 'physical_medical',
    name: 'Physical and medical care',
    description: 'Give medicines as prescribed, take vital signs, do prescribed exercises and wound care, and watch for changes.',
    suggestions: [
      { title: 'Give morning medicines', frequency: 'daily', times: ['08:00'] },
      { title: 'Give evening medicines', frequency: 'daily', times: ['20:00'] },
      { title: 'Check blood pressure and record it (daily check-in)', frequency: 'daily', times: ['07:30'] },
      { title: 'Assist with walking / range-of-motion exercises', frequency: 'daily', times: ['10:00'] },
      { title: 'Help moving from bed to chair (transfer)', frequency: 'as_needed' },
      { title: 'Wound or catheter care as instructed by the nurse', frequency: 'as_needed' },
    ],
  },
  {
    code: 'meals_household',
    name: 'Meals and household',
    description: 'Plan and prepare meals for the diet, make sure the person drinks enough, and keep the home clean.',
    suggestions: [
      { title: 'Prepare breakfast (low-salt diet)', frequency: 'daily', times: ['07:00'] },
      { title: 'Prepare lunch', frequency: 'daily', times: ['12:00'] },
      { title: 'Prepare dinner', frequency: 'daily', times: ['18:00'] },
      { title: 'Offer water every 2 hours (hydration)', frequency: 'daily', times: ['10:00', '14:00', '16:00'] },
      { title: 'Laundry and change bed linen', frequency: 'weekly', daysOfWeek: [3, 6] },
      { title: 'Buy groceries and refill medicines', frequency: 'weekly', daysOfWeek: [6] },
    ],
  },
  {
    code: 'transportation',
    name: 'Transportation',
    description: 'Arrange or provide rides to check-ups, the pharmacy, therapy and errands.',
    suggestions: [
      { title: 'Bring to health center check-up', frequency: 'once' },
      { title: 'Pick up medicines at the pharmacy', frequency: 'once' },
      { title: 'Arrange transport for therapy session', frequency: 'once' },
    ],
  },
  {
    code: 'emotional_social',
    name: 'Emotional and social support',
    description: 'Keep the person company, encourage hobbies and contact with family and friends, notice signs of depression.',
    suggestions: [
      { title: 'Spend time talking / reading together', frequency: 'daily', times: ['15:00'] },
      { title: 'Video or phone call with family', frequency: 'weekly', daysOfWeek: [0] },
      { title: 'Walk outside or attend church / senior activities', frequency: 'weekly', daysOfWeek: [0, 3] },
    ],
  },
  {
    code: 'home_safety',
    name: 'Home safety',
    description: 'Prevent falls and accidents: clear walkways, lighting, grab bars, safe medicine storage, emergency numbers.',
    suggestions: [
      { title: 'Check walkways are clear and floors are dry', frequency: 'daily', times: ['07:00'] },
      { title: 'Check night lights and bathroom grab bars', frequency: 'weekly', daysOfWeek: [1] },
      { title: 'Store medicines safely and check expiry dates', frequency: 'weekly', daysOfWeek: [1] },
      { title: 'Prepare go-bag before typhoon season (medicines for 3+ days, documents, flashlight)', frequency: 'once' },
    ],
  },
  {
    code: 'communication',
    name: 'Communication',
    description: 'Keep family and the health center informed and use the tools that help the person communicate.',
    suggestions: [
      { title: 'Send daily update to family', frequency: 'daily', times: ['19:00'] },
      { title: 'Charge phone and hearing aid batteries', frequency: 'daily', times: ['21:00'] },
      { title: 'Tell the nurse about new symptoms or medicine side effects', frequency: 'as_needed' },
    ],
  },
  {
    code: 'records',
    name: 'Records',
    description: 'Keep medical records, the medicine list, appointment notes, insurance (PhilHealth) and legal documents up to date.',
    suggestions: [
      { title: 'Update the medicine list after any change', frequency: 'as_needed' },
      { title: 'Write appointment notes and questions for the doctor', frequency: 'as_needed' },
      { title: 'Check PhilHealth / senior citizen ID and documents are up to date', frequency: 'once' },
    ],
  },
];

const CATEGORY_CODES = CATEGORIES.map((c) => c.code);

module.exports = { CATEGORIES, CATEGORY_CODES };
