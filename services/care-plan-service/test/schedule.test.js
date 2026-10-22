'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { validateTask, localNow, slotsOn, buildChecklist, adherence, addDays } = require('../src/schedule');
const { CATEGORIES, CATEGORY_CODES } = require('../src/catalog');

const task = (over) => ({ id: 't1', category: 'physical_medical', title: 'Give medicines', frequency: 'daily', times: ['08:00', '20:00'], daysOfWeek: [], dueDate: null, startDate: null, endDate: null, active: true, ...over });

test('catalogue covers the eight caregiver duty areas, each with suggestions that validate', () => {
  assert.deepStrictEqual(CATEGORY_CODES, ['personal_care', 'physical_medical', 'meals_household', 'transportation', 'emotional_social', 'home_safety', 'communication', 'records']);
  for (const c of CATEGORIES) {
    assert.ok(c.suggestions.length >= 3, c.code);
    for (const s of c.suggestions) {
      const body = { category: c.code, title: s.title, frequency: s.frequency, ...(s.times ? { times: s.times } : {}), ...(s.daysOfWeek ? { daysOfWeek: s.daysOfWeek } : {}), ...(s.frequency === 'once' ? { dueDate: '2026-12-01' } : {}) };
      assert.deepStrictEqual(validateTask(body).errors, [], `${c.code}: ${s.title}`);
    }
  }
});

test('task validation: required fields, formats and cross-field rules', () => {
  const bad = validateTask({ category: 'cooking', title: 'x', frequency: 'hourly', times: ['8am'], daysOfWeek: [7], dueDate: '2026-02-30', extra: true });
  const msg = bad.errors.join(' | ');
  for (const part of ['unknown field(s): extra', 'category must be', 'title must be', 'frequency must be', 'times must be', 'daysOfWeek must be', 'dueDate must be']) assert.ok(msg.includes(part), `${part} in ${msg}`);
  assert.match(validateTask({ category: 'personal_care', title: 'Bathing', frequency: 'daily' }).errors.join(), /at least one time/);
  assert.match(validateTask({ category: 'home_safety', title: 'Check floors', frequency: 'weekly' }).errors.join(), /daysOfWeek/);
  assert.match(validateTask({ category: 'transportation', title: 'Check-up', frequency: 'once' }).errors.join(), /dueDate/);
  assert.match(validateTask({ category: 'records', title: 'Update list', frequency: 'as_needed', startDate: '2026-05-02', endDate: '2026-05-01' }).errors.join(), /endDate/);
  assert.deepStrictEqual(validateTask({ category: 'personal_care', title: ' Bathing ', frequency: 'daily', times: ['20:00', '08:00', '08:00'] }).value.times, ['08:00', '20:00']);
});

test('PATCH validation merges with the stored task', () => {
  const existing = task({ frequency: 'daily', times: ['08:00'] });
  assert.deepStrictEqual(validateTask({ title: 'Give morning medicines' }, { partial: true, existing }).errors, []);
  assert.match(validateTask({ frequency: 'weekly' }, { partial: true, existing }).errors.join(), /daysOfWeek/);
  assert.deepStrictEqual(validateTask({ frequency: 'weekly', daysOfWeek: [1] }, { partial: true, existing }).errors, []);
  assert.match(validateTask({}, { partial: true, existing }).errors.join(), /nothing to update/);
});

test('local time uses the clinic offset (Manila is UTC+8)', () => {
  assert.deepStrictEqual(localNow('+08:00', new Date('2026-10-22T17:30:00Z')), { date: '2026-10-23', minutes: 90 });
  assert.deepStrictEqual(localNow('-05:00', new Date('2026-10-22T03:00:00Z')), { date: '2026-10-21', minutes: 22 * 60 });
  assert.strictEqual(addDays('2026-12-31', 1), '2027-01-01');
});

test('slots: daily, weekly by weekday, start/end dates, inactive', () => {
  assert.deepStrictEqual(slotsOn(task(), '2026-10-22'), ['08:00', '20:00']);
  const weekly = task({ frequency: 'weekly', times: [], daysOfWeek: [4] }); // Thursday
  assert.deepStrictEqual(slotsOn(weekly, '2026-10-22'), ['any']);
  assert.deepStrictEqual(slotsOn(weekly, '2026-10-23'), []);
  assert.deepStrictEqual(slotsOn(task({ startDate: '2026-10-23' }), '2026-10-22'), []);
  assert.deepStrictEqual(slotsOn(task({ endDate: '2026-10-21' }), '2026-10-22'), []);
  assert.deepStrictEqual(slotsOn(task({ active: false }), '2026-10-22'), []);
});

test('checklist: done, pending, overdue after 2 h, missed on past days', () => {
  const now = { date: '2026-10-22', minutes: 10 * 60 + 30 }; // 10:30
  const tasks = [task(), task({ id: 't2', title: 'Water', category: 'meals_household', times: ['10:00'] })];
  const today = buildChecklist(tasks, [{ taskId: 't1', slot: '08:00', status: 'done' }], '2026-10-22', now);
  const by = Object.fromEntries(today.items.map((i) => [`${i.taskId}@${i.slot}`, i.status]));
  assert.deepStrictEqual(by, { 't1@08:00': 'done', 't2@10:00': 'pending', 't1@20:00': 'pending' });
  assert.deepStrictEqual(today.items.map((i) => i.slot), ['08:00', '10:00', '20:00'], 'sorted by time');
  const later = buildChecklist(tasks, [], '2026-10-22', { date: '2026-10-22', minutes: 12 * 60 + 1 });
  assert.strictEqual(later.items.find((i) => i.taskId === 't2').status, 'overdue');
  const yesterday = buildChecklist(tasks, [], '2026-10-21', now);
  assert.strictEqual(yesterday.summary.missed, 3);
  const tomorrow = buildChecklist(tasks, [], '2026-10-23', now);
  assert.strictEqual(tomorrow.summary.pending, 3);
});

test('checklist: one-time tasks carry over until done; as-needed tasks are listed with today\'s count', () => {
  const now = { date: '2026-10-22', minutes: 600 };
  const once = task({ id: 'o1', frequency: 'once', times: [], dueDate: '2026-10-20', category: 'transportation', title: 'Check-up' });
  const prn = task({ id: 'p1', frequency: 'as_needed', times: [], category: 'communication', title: 'Call the nurse' });
  const list = buildChecklist([once, prn], [{ taskId: 'p1', slot: 'log', status: 'done' }], '2026-10-22', now);
  assert.strictEqual(list.items[0].carriedOver, true);
  assert.deepStrictEqual(list.asNeeded, [{ taskId: 'p1', category: 'communication', title: 'Call the nurse', instructions: null, loggedToday: 1 }]);
  assert.strictEqual(buildChecklist([once], [], '2026-10-22', now, new Set(['o1'])).items.length, 0, 'gone once done');
  assert.strictEqual(buildChecklist([once], [], '2026-10-21', now).items.length, 0, 'not carried into other past days');
});

test('adherence per category; skipped counts as not done', () => {
  const tasks = [task({ times: ['08:00'] }), task({ id: 't2', category: 'personal_care', title: 'Bath', times: ['09:00'] })];
  const comps = [
    { taskId: 't1', date: '2026-10-20', slot: '08:00', status: 'done' },
    { taskId: 't1', date: '2026-10-21', slot: '08:00', status: 'skipped' },
    { taskId: 't2', date: '2026-10-20', slot: '09:00', status: 'done' },
    { taskId: 't2', date: '2026-10-21', slot: '09:00', status: 'done' },
  ];
  const a = adherence(tasks, comps, '2026-10-20', '2026-10-22');
  assert.strictEqual(a.scheduled, 6);
  assert.strictEqual(a.done, 3);
  assert.strictEqual(a.rate, 50);
  assert.deepStrictEqual(a.categories.find((c) => c.category === 'physical_medical'), { category: 'physical_medical', scheduled: 3, done: 1, rate: 33 });
});
