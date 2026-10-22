-- Demo care plans (SEED_DEMO_DATA=true). Fixed ids keep re-runs idempotent.
INSERT INTO care_plans (patient_id, goals, notes, created_by, updated_by) VALUES
  ('P-1001', 'Keep blood pressure below 140/90, no missed medicines, prevent falls.', 'Lives with daughter; uses a cane. Low-salt diet.', 'U-CS-001', 'U-CS-001'),
  ('P-1002', 'Stable blood sugar, walk 15 minutes a day, stay socially active.', 'Diabetic; reading glasses; enjoys church activities.', 'U-CS-001', 'U-CS-001')
ON CONFLICT (patient_id) DO NOTHING;

INSERT INTO care_tasks (id, patient_id, category, title, instructions, frequency, times, days_of_week, due_date, created_by) VALUES
  ('a1000000-0000-4000-8000-000000000001', 'P-1001', 'physical_medical', 'Give morning medicines', 'Losartan 50 mg and Amlodipine 5 mg after breakfast.', 'daily', '{08:00}', '{}', NULL, 'U-CS-001'),
  ('a1000000-0000-4000-8000-000000000002', 'P-1001', 'physical_medical', 'Check blood pressure and record it (daily check-in)', 'Seated, after 5 minutes rest.', 'daily', '{07:30}', '{}', NULL, 'U-CS-001'),
  ('a1000000-0000-4000-8000-000000000003', 'P-1001', 'personal_care', 'Help with bathing', 'Use the shower chair; check skin for bruises.', 'daily', '{09:00}', '{}', NULL, 'U-CS-001'),
  ('a1000000-0000-4000-8000-000000000004', 'P-1001', 'meals_household', 'Prepare low-salt meals', 'No instant noodles, dried fish or soy sauce.', 'daily', '{07:00,12:00,18:00}', '{}', NULL, 'U-CS-001'),
  ('a1000000-0000-4000-8000-000000000005', 'P-1001', 'meals_household', 'Offer water', 'At least one glass each time; more on hot days.', 'daily', '{10:00,14:00,16:00}', '{}', NULL, 'U-CS-001'),
  ('a1000000-0000-4000-8000-000000000006', 'P-1001', 'home_safety', 'Check walkways and bathroom grab bars', NULL, 'weekly', '{}', '{1,4}', NULL, 'U-CS-001'),
  ('a1000000-0000-4000-8000-000000000007', 'P-1001', 'emotional_social', 'Video call with family', 'Daughter in Dubai, Sunday evenings.', 'weekly', '{19:00}', '{0}', NULL, 'U-CS-001'),
  ('a1000000-0000-4000-8000-000000000008', 'P-1001', 'transportation', 'Bring to health center BP check-up', 'Bring the BP log.', 'once', '{}', '{}', current_date + 7, 'U-CS-001'),
  ('a1000000-0000-4000-8000-000000000009', 'P-1001', 'communication', 'Tell the nurse about dizziness or swelling', NULL, 'as_needed', '{}', '{}', NULL, 'U-CS-001'),
  ('a1000000-0000-4000-8000-000000000010', 'P-1001', 'records', 'Update the medicine list after any change', NULL, 'as_needed', '{}', '{}', NULL, 'U-CS-001'),
  ('a2000000-0000-4000-8000-000000000001', 'P-1002', 'physical_medical', 'Check blood sugar before breakfast', 'Record it in the check-in.', 'daily', '{06:30}', '{}', NULL, 'U-CS-001'),
  ('a2000000-0000-4000-8000-000000000002', 'P-1002', 'physical_medical', 'Give metformin', 'With breakfast and dinner.', 'daily', '{07:30,18:30}', '{}', NULL, 'U-CS-001'),
  ('a2000000-0000-4000-8000-000000000003', 'P-1002', 'physical_medical', 'Walk 15 minutes', 'Morning, before it gets hot.', 'daily', '{07:00}', '{}', NULL, 'U-CS-001'),
  ('a2000000-0000-4000-8000-000000000004', 'P-1002', 'personal_care', 'Foot check and nail care', 'Look for cuts or sores (diabetes).', 'weekly', '{}', '{6}', NULL, 'U-CS-001'),
  ('a2000000-0000-4000-8000-000000000005', 'P-1002', 'emotional_social', 'Attend church / senior activities', NULL, 'weekly', '{08:00}', '{0}', NULL, 'U-CS-001'),
  ('a2000000-0000-4000-8000-000000000006', 'P-1002', 'meals_household', 'Buy groceries and refill medicines', NULL, 'weekly', '{}', '{6}', NULL, 'U-CS-001')
ON CONFLICT (id) DO NOTHING;
