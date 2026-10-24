# Care Plan Service – caregiver duties (v2 · Batch 4)

`services/care-plan-service/` (port 4006, database `care_db`, login `care_svc`) turns the family
caregiver's daily work into a checklist that the caregiver ticks off. Family members and the health center
can see what was done.

## Duty categories

The eight categories follow the caregiver duties described by caringinfo.org (NHPCO). Each one comes
with suggested tasks (`GET /api/care/categories`, `src/catalog.js`):

| Code | Covers | Example tasks |
|---|---|---|
| `personal_care` | bathing, dressing, grooming, toileting, oral care | help with bathing; oral care twice a day |
| `physical_medical` | medicines, vital signs, exercises, transfers, wound care | give morning medicines; check blood pressure |
| `meals_household` | meals for the diet, hydration, laundry, shopping | low-salt meals; offer water every 2 hours |
| `transportation` | rides to check-ups, pharmacy, therapy | bring to health center check-up |
| `emotional_social` | company, hobbies, contact with family, church / senior activities | video call with family |
| `home_safety` | clear walkways, grab bars, lighting, safe medicine storage, typhoon go-bag | check walkways and grab bars |
| `communication` | updates to family and nurse, phone / hearing-aid batteries | tell the nurse about new symptoms |
| `records` | medicine list, appointment notes, PhilHealth / senior ID | update the medicine list |

## How a task repeats

| `frequency` | Needs | Appears on the checklist |
|---|---|---|
| `daily` | `times` (HH:MM, local time) | every day, once per time |
| `weekly` | `daysOfWeek` (0 = Sunday), optional `times` | on those days |
| `once` | `dueDate` | on the due date; if not done, it stays on today's list as overdue until it is done |
| `as_needed` | – | in a separate "as needed" list; can be logged any number of times |

`startDate` / `endDate` limit a task to a period, for example after a hospital stay. Clinic staff
**retire** a task instead of deleting it (`DELETE` sets `active=false`), so the history and the adherence
figures stay correct.

## Checklist and adherence

* `GET /api/patients/:id/care-plan/checklist?date=` lists each occurrence (slot) as `done`, `skipped`,
  `pending`, `overdue` (more than 2 h past its time, `CARE_OVERDUE_AFTER_MINUTES`) or `missed` (a past
  day). "Today" is the health center's time zone (`CARE_TZ_OFFSET`, default +08:00).
* The caregiver ticks a slot off with `POST /api/care/tasks/:taskId/completions`. Ticking the same slot
  again corrects it (for example from skipped to done) instead of adding a duplicate. Skipping needs a
  reason. Forgotten tasks can be logged up to 7 days late (`CARE_LATE_LOG_DAYS`), but never for a future
  date.
* `GET /api/patients/:id/care-plan/history` returns the completions (paged) and the **adherence** per
  category, which is done ÷ scheduled for up to 31 days. A task counts only from the day it was added.

## Access

| Who | Can |
|---|---|
| caregiver | read their patients' plans and checklists; tick off, skip or log duties |
| family member | read their relative's plan, checklist and adherence |
| clinic staff | build and change plans (goals, notes, tasks) for any patient |
| admin | read |

The gateway checks role and patient scope. The service checks them again, including the task's patient
on `/api/care/tasks/:taskId/completions`, where the URL does not name the patient.

Pure logic (validation, slots, checklist, adherence) is in `src/schedule.js`, tested in `test/schedule.test.js`.

---

# v3 · Nurse-led care plan, verified instructions and caregiver reports

The same service and screens, extended. Nothing is generated: no diet, fluid target, medicine time,
monitoring requirement or clinical threshold is filled in by the app.

## The plan and its versions (`care_plan_versions`, `care_plan_events`)

A nurse on the elder's care team (checked with the clinic service) writes the plan with the elder and the
caregiver: preferences, goals, assistance needs, allergies (none known / listed / not assessed - never assumed),
clinical instructions and restrictions, the caregiver's responsibilities and training, follow-up, the clinic
contact and monitoring hours, and the approved after-hours and emergency instructions.

* `draft -> active -> superseded` (or a draft is discarded). One draft and one active version per elder.
* An active or superseded version never changes (database trigger). A change is a new draft; activating it
  supersedes the version in use. Tasks belong to a version, so a past day shows the tasks of that day's version.
* Every step is in the append-only history: draft started, edited, task added / changed / removed, verified,
  activated, superseded, discarded - with who and when.
* Plans that existed before versions were carried over as version 1, marked "carried over, not yet reviewed".
  Their content, tasks and completions were not changed.

## Sources and partner-clinic approval

| Instruction | Source needed | Partner-clinic approval |
|---|---|---|
| diet, fluids, swallowing, skin / wound care | a clinical source (physician's order, partner clinic, hospital discharge, clinic protocol) | always |
| restriction, other | any source, including the nurse's assessment | the nurse chooses |
| after-hours and emergency instructions | a clinical source | always |
| specialised tasks (e.g. wound care) | a clinical source | - |

A draft with anything that needs approval can be activated only after the nurse records the clinician's
verification (who, role, how, when, reference). Changing a verified instruction clears the verification.
Activation also needs: goals, preferences, allergies recorded, caregiver responsibilities, clinic phone and
hours, emergency instructions, the responsible nurse, whether the elder and the caregiver took part (or why
not), an effective date that is not in the future, and a review date within a year.

## Medicines (check-in service, `patient_medications`, migration 0004)

The existing prescription records are reused. A nurse records a prescription from its source (prescriber, type,
reference, date) with strength, dose, route, schedule, food instructions and start / end dates, and may record
how it was verified. Missed / refused-dose instructions are accepted only with their own clinical source. A
change is a new record (`POST .../revisions`, with the reason) that supersedes the old one; stopping needs the
reason and who ordered it (`POST .../stop`). A record is never edited in place (database trigger). Older records
show "source not recorded".

## Caregiver reports

* Medicines: Taken / Not taken / Unknown per prescribed dose, with the actual time (taken) or a reason. It is what
  the caregiver reported, not proof the dose was given. A dose without a report stays "no report yet".
* Tasks: Done / Not done / Not applicable, with an optional reason. Measurements: a reading, Not measured or
  No device. A reading is also sent as a check-in so the usual alert rules see it.
* Each report carries the plan version the phone showed and when it was recorded. A report for a version that
  has since changed is kept as reported and flagged; a correction keeps the earlier report (`report_revisions`).

## Review, concerns and handover - kept separate

* Report review (care-plan service): a nurse records what they assessed and did, once per report.
* Check-in review (check-in service): unchanged.
* Concerns (clinic service, `care_concerns`, migration 0003): reported by the caregiver ("Report a concern") or
  a nurse; open until a nurse resolves it with an assessment and the action taken. Reviews, completed tasks and
  normal readings never close a concern.
* A handover carries the elder's open concerns; the incoming nurse must acknowledge them to accept. Changing the
  nurse does not change the caregiver's access or any history.

## Who can do what (gateway and services)

| Role | Care plan | Reports | Concerns |
|---|---|---|---|
| nurse (care team) | draft, verify, activate, discard; prescriptions | review | acknowledge, note, resolve |
| caregiver (own elder) | read the active version | submit and correct | report, see their own |
| family (own elder) | a summary of the active version | read-only checklist | - |
| admin | none (accounts and access only) | - | - |

## Not yet verified

* Clinical content: which instructions a partner clinic must approve, and the wording of emergency and
  after-hours instructions, need the partner clinic's sign-off.
* The phone checklist sends reports when online; reports made offline elsewhere in the app are flagged on
  arrival, but the checklist itself does not queue reports.
* The check-in alert rules (anomaly thresholds) predate this work and are universal, not per elder.
