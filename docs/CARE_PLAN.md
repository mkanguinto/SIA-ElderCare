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
