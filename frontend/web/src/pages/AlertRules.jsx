import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useToast } from '../toast';
import { PageHeader, Empty, ErrorNote, Loading } from '../components/ui';
import Pager from '../components/Pager';
import { conditionLabel, relTime, SEVERITY_LABEL } from '../format';

const METRIC_LABEL = { heat_index_c: 'Heat index (°C)', temperature_c: 'Temperature (°C)', humidity: 'Humidity (%)', wind_ms: 'Wind (m/s)' };
const HAZARD_LABEL = { heat: 'Heat', storm: 'Storm / typhoon' };
const CONDITIONS = ['hypertension', 'cardiovascular', 'heart_disease', 'diabetes', 'kidney_disease', 'copd', 'dementia', 'arthritis'];
const EMPTY = {
  code: '', description: '', hazard: 'heat', enabled: true,
  metric: 'heat_index_c', operator: '>', value: '40', includeAdvisories: false,
  conditions: [], mobility: '',
  severity: 'high', sms: true, inApp: true, clinic: true, cooldown: '24',
};

function toForm(r) {
  const t = r.trigger_condition || {};
  const v = r.vulnerability_target || {};
  const a = r.action || {};
  return {
    code: r.code, description: r.description, hazard: r.hazard, enabled: r.enabled,
    metric: t.metric, operator: t.operator, value: String(t.value), includeAdvisories: Boolean(t.include_advisories),
    conditions: v.conditions || [], mobility: typeof v.mobility_restricted === 'boolean' ? String(v.mobility_restricted) : '',
    severity: a.severity || 'high', sms: (a.channels || []).includes('sms'), inApp: (a.channels || []).includes('in_app'),
    clinic: a.create_clinic_item !== false, cooldown: String(a.cooldown_hours || 24),
  };
}

function toBody(f, isNew) {
  const channels = [f.sms && 'sms', f.inApp && 'in_app'].filter(Boolean);
  return {
    ...(isNew ? { code: f.code.trim().toUpperCase() } : {}),
    description: f.description.trim(),
    enabled: f.enabled,
    hazard: f.hazard,
    trigger_condition: { metric: f.metric, operator: f.operator, value: Number(f.value), ...(f.hazard === 'storm' ? { include_advisories: f.includeAdvisories } : {}) },
    vulnerability_target: { conditions: f.conditions, ...(f.mobility ? { mobility_restricted: f.mobility === 'true' } : {}) },
    action: { severity: f.severity, channels, create_clinic_item: f.clinic, cooldown_hours: Number(f.cooldown) },
  };
}

function ruleSentence(r) {
  if (r.type === 'system') return 'Fired by check-in events';
  const t = r.trigger_condition;
  const v = r.vulnerability_target || {};
  const who = [
    v.conditions && v.conditions.length ? `patients with ${v.conditions.map(conditionLabel).join(', ')}` : 'all patients in the area',
    v.mobility_restricted === true ? 'who have limited mobility' : v.mobility_restricted === false ? 'who walk without help' : '',
  ].filter(Boolean).join(' ');
  return `${METRIC_LABEL[t.metric] || t.metric} ${t.operator} ${t.value}${t.include_advisories ? ' or an official storm advisory' : ''} → warn ${who}`;
}

export default function AlertRules({ user }) {
  const toast = useToast();
  const canEdit = user.role === 'system_admin';
  const [type, setType] = useState('weather');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState(null);
  const [problems, setProblems] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api(`/api/alerts/rules?type=${type}&page=${page}&pageSize=20`)
    .then((r) => { setData(r); setError(''); }).catch((e) => setError(e.message)), [type, page]);
  useEffect(() => { load(); }, [load]);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setProblems([]);
    try {
      const isNew = !form.existing;
      const body = form.system ? { description: form.description.trim(), enabled: form.enabled } : toBody(form, isNew);
      if (isNew) await api('/api/alerts/rules', { method: 'POST', body });
      else await api(`/api/alerts/rules/${form.code}`, { method: 'PATCH', body });
      toast({ title: isNew ? `Rule ${body.code} created` : `Rule ${form.code} saved`, tone: 'success' });
      setForm(null);
      load();
    } catch (err) {
      setProblems(err.details || [err.message]);
    } finally {
      setBusy(false);
    }
  }

  async function toggle(r) {
    try {
      await api(`/api/alerts/rules/${r.code}`, { method: 'PATCH', body: { enabled: !r.enabled } });
      toast({ title: `${r.code} ${r.enabled ? 'disabled' : 'enabled'}`, tone: 'success' });
      load();
    } catch (err) {
      toast({ title: err.message, tone: 'error' });
    }
  }

  async function remove(r) {
    if (!window.confirm(`Delete rule ${r.code}? Past alerts keep their history.`)) return;
    try {
      await api(`/api/alerts/rules/${r.code}`, { method: 'DELETE' });
      toast({ title: `Rule ${r.code} deleted`, tone: 'success' });
      load();
    } catch (err) {
      toast({ title: err.message, tone: 'error' });
    }
  }

  return (
    <>
      <PageHeader title="Alert rules" subtitle="The weather check warns families and opens triage items using these rules. For each hazard a patient gets only the most severe rule that matches.">
        {canEdit && type === 'weather' && !form && <button type="button" className="btn btn-primary" onClick={() => { setForm({ ...EMPTY }); setProblems([]); }}>New weather rule</button>}
      </PageHeader>
      <div className="tabs" role="tablist" aria-label="Rule type">
        {[['weather', 'Weather rules'], ['system', 'System rules']].map(([v, l]) => (
          <button key={v} type="button" role="tab" aria-selected={type === v} className={`tab ${type === v ? 'is-on' : ''}`} onClick={() => { setType(v); setPage(1); setForm(null); }}>{l}</button>
        ))}
      </div>
      <ErrorNote error={error} onRetry={load} />

      {form && (
        <form className="panel inline-form rule-form" onSubmit={save} noValidate>
          <h2 className="panel-title">{form.existing ? `Edit ${form.code}` : 'New weather rule'}</h2>
          {problems.length > 0 && <div className="note note-error" role="alert"><ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>}
          <div className="form-grid">
            <label className="field"><span>Code</span><input value={form.code} onChange={set('code')} disabled={form.existing} placeholder="HEAT_SENIOR_CENTER" maxLength={40} /></label>
            <label className="field"><span>Description</span><input value={form.description} onChange={set('description')} maxLength={200} /></label>
          </div>
          {!form.system && (
            <>
              <fieldset className="rule-part"><legend>When (trigger condition)</legend>
                <div className="form-grid four">
                  <label className="field"><span>Hazard</span><select value={form.hazard} onChange={set('hazard')}>{Object.entries(HAZARD_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
                  <label className="field"><span>Measure</span><select value={form.metric} onChange={set('metric')}>{Object.entries(METRIC_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
                  <label className="field"><span>Is</span><select value={form.operator} onChange={set('operator')}>{['>', '>=', '<', '<='].map((o) => <option key={o}>{o}</option>)}</select></label>
                  <label className="field"><span>Value</span><input type="number" step="0.1" value={form.value} onChange={set('value')} /></label>
                </div>
                {form.hazard === 'storm' && <label className="check"><input type="checkbox" checked={form.includeAdvisories} onChange={set('includeAdvisories')} /> Also when there is an official typhoon / storm advisory</label>}
              </fieldset>
              <fieldset className="rule-part"><legend>Who (vulnerability target) – empty means everyone in the area</legend>
                <div className="checks">
                  {CONDITIONS.map((c) => (
                    <label key={c} className={`check ${form.conditions.includes(c) ? 'is-on' : ''}`}>
                      <input type="checkbox" checked={form.conditions.includes(c)} onChange={(e) => setForm({ ...form, conditions: e.target.checked ? [...form.conditions, c] : form.conditions.filter((x) => x !== c) })} />
                      {conditionLabel(c)}
                    </label>
                  ))}
                </div>
                <label className="field"><span>Mobility</span>
                  <select value={form.mobility} onChange={set('mobility')}><option value="">Any</option><option value="true">Limited mobility only</option><option value="false">Walks without help only</option></select>
                </label>
              </fieldset>
              <fieldset className="rule-part"><legend>Then (action)</legend>
                <div className="form-grid three">
                  <label className="field"><span>Severity</span><select value={form.severity} onChange={set('severity')}>{['low', 'moderate', 'high', 'critical'].map((s) => <option key={s} value={s}>{SEVERITY_LABEL[s]}</option>)}</select></label>
                  <label className="field"><span>Warn again after (hours)</span><input type="number" min="1" max="168" value={form.cooldown} onChange={set('cooldown')} /></label>
                </div>
                <div className="checks">
                  <label className={`check ${form.sms ? 'is-on' : ''}`}><input type="checkbox" checked={form.sms} onChange={set('sms')} /> SMS to family</label>
                  <label className={`check ${form.inApp ? 'is-on' : ''}`}><input type="checkbox" checked={form.inApp} onChange={set('inApp')} /> In-app alert</label>
                  <label className={`check ${form.clinic ? 'is-on' : ''}`}><input type="checkbox" checked={form.clinic} onChange={set('clinic')} /> Add to clinic risk queue</label>
                </div>
              </fieldset>
            </>
          )}
          <label className={`check ${form.enabled ? 'is-on' : ''}`}><input type="checkbox" checked={form.enabled} onChange={set('enabled')} /> Enabled</label>
          <div className="btn-row form-actions">
            <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save rule'}</button>
            <button type="button" className="btn btn-quiet" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </form>
      )}

      {!data && !error && <Loading label="Loading rules" />}
      {data && data.rules.length === 0 && <Empty title="No rules">Weather warnings are off until a rule is added.</Empty>}
      {data && data.rules.length > 0 && (
        <section className="panel panel-flush">
          <table className="table">
            <thead><tr><th>Rule</th><th>Condition</th><th>Severity</th><th>Status</th>{canEdit && <th />}</tr></thead>
            <tbody>
              {data.rules.map((r) => (
                <tr key={r.code}>
                  <td><strong>{r.code}</strong><br /><span className="muted small">{r.description}</span></td>
                  <td className="small">{ruleSentence(r)}{r.updated_by && <><br /><span className="muted">changed by {r.updated_by} {relTime(r.updated_at)}</span></>}</td>
                  <td>{r.action && r.action.severity ? SEVERITY_LABEL[r.action.severity] : `from ${r.action.min_severity}`}</td>
                  <td><span className={`pill ${r.enabled ? 'status-resolved' : ''}`}>{r.enabled ? 'On' : 'Off'}</span></td>
                  {canEdit && (
                    <td>
                      <div className="btn-row">
                        <button type="button" className="btn btn-quiet btn-sm" onClick={() => { setForm({ ...toForm(r), existing: true, system: r.type === 'system' }); setProblems([]); }}>Edit</button>
                        <button type="button" className="btn btn-quiet btn-sm" onClick={() => toggle(r)}>{r.enabled ? 'Disable' : 'Enable'}</button>
                        {r.type === 'weather' && <button type="button" className="btn btn-quiet btn-sm" onClick={() => remove(r)}>Delete</button>}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <Pager pagination={data.pagination} onPage={setPage} label="rules" />
        </section>
      )}
    </>
  );
}
