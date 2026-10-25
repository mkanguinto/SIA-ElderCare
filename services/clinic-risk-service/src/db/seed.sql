-- Demo care teams (only loaded when SEED_DEMO_DATA=true; runs after the migrations). Nurse ids match
-- api-gateway/data/users.json. Inserted once: later changes made in the app are kept on restart.
INSERT INTO care_teams (id, name, clinic_id, created_by) VALUES
  ('CT-MNL-A', 'RHU Manila - Team A', 'RHU-MNL-01', 'seed'),
  ('CT-QC-B',  'RHU Quezon City - Team B', 'RHU-QC-03', 'seed')
ON CONFLICT (id) DO NOTHING;

INSERT INTO care_team_members (team_id, nurse_id, nurse_name, team_role, added_by)
SELECT v.team_id, v.nurse_id, v.nurse_name, v.team_role, 'seed'
FROM (VALUES
  ('CT-MNL-A', 'U-CS-001', 'Ana Cruz, RN', 'lead'),
  ('CT-MNL-A', 'U-CS-002', 'Ben Lim, RN', 'nurse'),
  ('CT-QC-B',  'U-CS-003', 'Carla Mendoza, RN', 'lead'),
  ('CT-QC-B',  'U-CS-001', 'Ana Cruz, RN', 'nurse')
) AS v(team_id, nurse_id, nurse_name, team_role)
WHERE NOT EXISTS (SELECT 1 FROM care_team_members m WHERE m.team_id = v.team_id AND m.nurse_id = v.nurse_id);

INSERT INTO patient_care (patient_id, patient_name, care_team_id, monitoring_plan_id, case_nurse_id, case_nurse_name, case_since, updated_by) VALUES
  ('P-1001', 'Lola Remedios Dela Cruz', 'CT-MNL-A', 'MP-BP-TWICE', 'U-CS-001', 'Ana Cruz, RN', now(), 'seed'),
  ('P-1002', 'Lolo Ernesto Villanueva', 'CT-QC-B',  'MP-DAILY',    'U-CS-003', 'Carla Mendoza, RN', now(), 'seed'),
  ('P-1003', 'Lola Felicidad Ramos',    'CT-MNL-A', 'MP-DAILY',    'U-CS-002', 'Ben Lim, RN', now(), 'seed')
ON CONFLICT (patient_id) DO NOTHING;

-- Existing open cases follow the elder's case nurse.
UPDATE risk_queue q SET assigned_to = pc.case_nurse_id
  FROM patient_care pc
 WHERE pc.patient_id = q.patient_id AND q.status IN ('open', 'in_review', 'scheduled') AND q.assigned_to IS NULL;
