-- Carry the plans that existed before versions over as version 1 (active, marked legacy so a nurse reviews
-- them). Nothing in the old plan or its tasks is changed apart from linking the tasks to that version.
INSERT INTO care_plan_versions (patient_id, version, status, content, legacy, change_summary, created_by, created_at,
                                activated_by, activated_at, effective_date)
SELECT p.patient_id, 1, 'active',
       jsonb_strip_nulls(jsonb_build_object('goals', p.goals, 'notes', p.notes)),
       TRUE, 'Carried over from the plan in use before plan versions. Not yet reviewed or verified.',
       coalesce(p.created_by, 'system'), p.created_at, coalesce(p.updated_by, p.created_by, 'system'), p.updated_at, p.created_at::date
  FROM care_plans p
 WHERE NOT EXISTS (SELECT 1 FROM care_plan_versions v WHERE v.patient_id = p.patient_id);
UPDATE care_tasks t SET plan_version_id = v.id
  FROM care_plan_versions v
 WHERE t.plan_version_id IS NULL AND v.patient_id = t.patient_id AND v.version = 1 AND v.legacy;
