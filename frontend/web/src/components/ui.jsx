import React from 'react';
import { PRIORITY_LABEL, SEVERITY_LABEL, STATUS_LABEL } from '../format';

export function SeverityBadge({ value }) {
  const v = value || 'none';
  return <span className={`badge sev-${v}`}>{SEVERITY_LABEL[v] || v}</span>;
}

export function PriorityTag({ value, long = false }) {
  return (
    <span className={`badge pri-${value}`} title={PRIORITY_LABEL[value]}>
      {value}{long ? ` ${PRIORITY_LABEL[value]}` : ''}
    </span>
  );
}

export function StatusPill({ value }) {
  return <span className={`pill status-${value}`}>{STATUS_LABEL[value] || value}</span>;
}

export function StatusDot({ state }) {
  return <span className={`dot dot-${state}`} aria-hidden="true" />;
}

export function Chip({ children, tone = '' }) {
  return <span className={`chip ${tone}`}>{children}</span>;
}

export function Empty({ title, children }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Loading({ label = 'Loading' }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

export function ErrorNote({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="note note-error" role="alert">
      <span>{error}</span>
      {onRetry && <button type="button" className="btn btn-quiet btn-sm" onClick={onRetry}>Try again</button>}
    </div>
  );
}

/** Single-choice button group (accessible radio group). */
export function Segmented({ label, value, options, onChange, name }) {
  return (
    <fieldset className="segmented">
      <legend>{label}</legend>
      <div className="segmented-options">
        {options.map((o) => (
          <label key={o.value} className={`seg ${value === o.value ? 'is-on' : ''} ${o.tone ? `seg-${o.tone}` : ''}`}>
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function PageHeader({ title, subtitle, children }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </header>
  );
}

/**
 * A dropdown that ends with "Other (type it)". Choosing it opens a text box for the person's own words, so nobody
 * has to pick a wrong answer because theirs is not listed. options: [[value, label]]; `other` / `onOther` hold the
 * typed text (sent as "<field>Other" next to the value "other").
 */
export function SelectOther({ value, onChange, other, onOther, options, placeholder, label, otherPlaceholder = 'Type it here', otherLabel = 'Other (type it)', ...rest }) {
  return (
    <>
      <select value={value || ''} onChange={(e) => onChange(e.target.value)} {...rest}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.filter(([k]) => k !== 'other').map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        <option value="other">{otherLabel}</option>
      </select>
      {value === 'other' && (
        <input className="select-other-input" value={other || ''} onChange={(e) => onOther(e.target.value)} placeholder={otherPlaceholder} maxLength={80}
          aria-label={`${label || 'Other'}: type it`} />
      )}
    </>
  );
}

/** How a nurse confirmed that someone is the elder's family (family verification, recorded with the link). */
export const FAMILY_VERIFY = [['elder_in_person', 'The elder confirmed it in person'], ['elder_by_phone', 'The elder confirmed it by phone'], ['id_and_document', 'ID and a document checked']];
export const familyVerificationBody = (v) => ({ method: v.method, ...(v.method === 'other' ? { methodOther: (v.methodOther || '').trim() } : {}) });

/** The label of a listed value, or the typed words when it is "other". */
export const listLabel = (labels, value, otherText) => (value === 'other' ? otherText || 'Other' : labels[value] || value);
