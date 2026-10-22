import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { PageHeader, Loading } from '../components/ui';
import { CareToday } from '../components/care';
import { conditionLabel, age, todayManila } from '../format';

// Caregivers may tick off forgotten duties up to 7 days late (CARE_LATE_LOG_DAYS on the service).
const DAYS_BACK = 7;

export default function CareDuties({ user }) {
  const [patients, setPatients] = useState(null);
  const [patientId, setPatientId] = useState(user.patients[0] || '');
  const [date, setDate] = useState(todayManila());
  const [plan, setPlan] = useState(null);

  useEffect(() => {
    Promise.all(user.patients.map((id) => api(`/api/patients/${id}`).catch(() => ({ id, fullName: id, conditions: [] })))).then(setPatients);
  }, [user.patients]);
  useEffect(() => {
    setPlan(null);
    if (patientId) api(`/api/patients/${patientId}/care-plan`).then(setPlan).catch(() => setPlan({ plan: null }));
  }, [patientId]);

  const days = Array.from({ length: DAYS_BACK + 1 }, (_, i) => todayManila(-i));
  return (
    <>
      <PageHeader title="Care duties" subtitle="Tick off each duty when it is done. If you could not do one, skip it and say why." />

      {patients && patients.length > 1 && (
        <div className="patient-switch" role="radiogroup" aria-label="Patient">
          {patients.map((p) => (
            <button key={p.id} type="button" role="radio" aria-checked={p.id === patientId} className={`patient-card ${p.id === patientId ? 'is-on' : ''}`} onClick={() => setPatientId(p.id)}>
              <strong>{p.fullName}</strong>
              <span>{[age(p.birthDate) && `${age(p.birthDate)} years`, ...(p.conditions || []).map(conditionLabel)].filter(Boolean).join(', ')}</span>
            </button>
          ))}
        </div>
      )}

      <section className="panel care-panel">
        <div className="panel-head">
          <h2 className="panel-title">{date === days[0] ? 'Today' : date}</h2>
          <label className="field field-inline">
            <span>Day</span>
            <select value={date} onChange={(e) => setDate(e.target.value)}>
              {days.map((d, i) => <option key={d} value={d}>{i === 0 ? `Today (${d})` : i === 1 ? `Yesterday (${d})` : d}</option>)}
            </select>
          </label>
        </div>
        {!plan && <Loading />}
        {plan && plan.plan && (plan.plan.goals || plan.plan.notes) && (
          <div className="note note-info">
            <span>{plan.plan.goals && <><strong>Goals:</strong> {plan.plan.goals} </>}{plan.plan.notes && <><br /><strong>Notes:</strong> {plan.plan.notes}</>}</span>
          </div>
        )}
        {patientId && <CareToday patientId={patientId} date={date} editable />}
      </section>
    </>
  );
}
