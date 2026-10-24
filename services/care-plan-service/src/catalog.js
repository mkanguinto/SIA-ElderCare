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
// Suggestions carry no times, days, diets or fluid amounts: those are agreed with the elder and the caregiver
// and, where clinical, come from a clinical source recorded in the plan. Medicines are not tasks here; the
// checklist takes them from the prescription records.
const CATEGORIES = [
  {
    code: 'personal_care',
    name: 'Personal care',
    description: 'Help with bathing, dressing, grooming, toileting and oral care while keeping the person\'s dignity.',
    suggestions: [
      { title: 'Help with bathing or sponge bath', frequency: 'daily' },
      { title: 'Help with dressing', frequency: 'daily' },
      { title: 'Oral care / denture cleaning', frequency: 'daily' },
      { title: 'Toileting / incontinence care', frequency: 'as_needed' },
      { title: 'Nail and skin care, check for pressure sores', frequency: 'weekly' },
    ],
  },
  {
    code: 'physical_medical',
    name: 'Physical and medical care',
    description: 'Take vital signs, help with prescribed exercises and watch for changes. Medicines come from the prescription records.',
    suggestions: [
      { title: 'Measure blood pressure as the plan says', frequency: 'daily', kind: 'measurement', measurement: 'bp' },
      { title: 'Assist with walking / range-of-motion exercises', frequency: 'daily' },
      { title: 'Help moving from bed to chair (transfer)', frequency: 'as_needed' },
      { title: 'Wound or catheter care (only with a clinical order and training)', frequency: 'as_needed', specialised: true },
    ],
  },
  {
    code: 'meals_household',
    name: 'Meals and household',
    description: "Prepare meals and drinks the way the plan describes, help with eating, and keep the home clean.",
    suggestions: [
      { title: "Prepare meals the elder likes, following the plan's diet instructions", frequency: 'daily' },
      { title: 'Help with eating', frequency: 'daily' },
      { title: "Offer drinks, following the plan's fluid instructions", frequency: 'daily' },
      { title: 'Laundry and change bed linen', frequency: 'weekly' },
      { title: 'Buy groceries and refill medicines', frequency: 'weekly' },
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
      { title: 'Spend time talking / reading together', frequency: 'daily' },
      { title: 'Video or phone call with family', frequency: 'weekly' },
      { title: 'Walk outside or attend church / senior activities', frequency: 'weekly' },
    ],
  },
  {
    code: 'home_safety',
    name: 'Home safety',
    description: 'Prevent falls and accidents: clear walkways, lighting, grab bars, safe medicine storage, emergency numbers.',
    suggestions: [
      { title: 'Check walkways are clear and floors are dry', frequency: 'daily' },
      { title: 'Check night lights and bathroom grab bars', frequency: 'weekly' },
      { title: 'Store medicines safely and check expiry dates', frequency: 'weekly' },
      { title: 'Prepare go-bag before typhoon season (medicines for 3+ days, documents, flashlight)', frequency: 'once' },
    ],
  },
  {
    code: 'communication',
    name: 'Communication',
    description: 'Keep family and the health center informed and use the tools that help the person communicate.',
    suggestions: [
      { title: 'Send daily update to family', frequency: 'daily' },
      { title: 'Charge phone and hearing aid batteries', frequency: 'daily' },
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
