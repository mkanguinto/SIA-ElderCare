// Check-in monitoring status shown to caregivers, family and nurses:
// Received -> Awaiting review -> Reviewed -> Action recorded, each step with who and when.
import React, { useEffect, useState } from 'react';
import { api } from '../api';
import Icon from './icons';
import { Chip, useT, clock, isToday } from './kit';
import { relTime } from '../format';

export const STATUS = {
  received: ['info', 'checkCircle', 'Received', 'Natanggap'],
  awaiting_review: ['moderate', 'clock', 'Awaiting review', 'Hinihintay ang nars'],
  reviewed: ['ok', 'eye', 'Reviewed', 'Nasuri na'],
  action_recorded: ['ok', 'check', 'Action recorded', 'May aksyon na'],
};
const ORDER = ['received', 'awaiting_review', 'reviewed', 'action_recorded'];
const when = (ts) => (isToday(ts) ? clock(ts) : relTime(ts));

export function StatusChip({ status }) {
  const tr = useT();
  const [tone, icon, en, fil] = STATUS[status] || STATUS.received;
  return <Chip tone={tone} icon={icon}>{tr(en, fil)}</Chip>;
}

/** One line for lists: "Reviewed by Ana Cruz, RN · 4:10 PM". */
export function statusLine(c, tr) {
  if (c.action) return tr(`${c.action.byName || 'Nurse'}: ${c.action.text}`, `${c.action.byName || 'Nars'}: ${c.action.text}`);
  if (c.review) return tr(`Reviewed by ${c.review.byName || 'the nurse'} · ${when(c.review.at)}`, `Nasuri ni ${c.review.byName || 'nars'} · ${when(c.review.at)}`);
  if (c.status === 'awaiting_review') return tr('In the nurse\'s queue, not reviewed yet', 'Nasa pila ng nars, hindi pa nasusuri');
  return tr('Saved, sending to the clinic', 'Naka-save, ipinapadala sa klinika');
}

/** Step-by-step timeline from GET /api/checkins/:id. Polls while the nurse has not reviewed it yet. */
export function StatusTimeline({ checkinId, pollMs = 15000 }) {
  const tr = useT();
  const [data, setData] = useState(null);
  useEffect(() => {
    let live = true;
    let t;
    const load = () => api(`/api/checkins/${checkinId}`).then((d) => {
      if (!live) return;
      setData(d);
      if (!['reviewed', 'action_recorded'].includes(d.checkin.status)) t = setTimeout(load, pollMs);
    }).catch(() => { if (live) t = setTimeout(load, pollMs * 2); });
    load();
    return () => { live = false; clearTimeout(t); };
  }, [checkinId, pollMs]);
  if (!data) return null;
  const reached = new Map();
  for (const l of data.statusLog) if (!reached.has(l.status) || l.status === 'action_recorded') reached.set(l.status, l);
  const current = ORDER.indexOf(data.checkin.status);
  return (
    <ol className="m-status-steps" aria-label={tr('Check-in status', 'Status ng check-in')}>
      {ORDER.map((s, i) => {
        const l = reached.get(s);
        const [, icon, en, fil] = STATUS[s];
        const done = i <= current;
        return (
          <li key={s} className={done ? 'is-done' : ''} aria-current={i === current ? 'step' : undefined}>
            <span className="m-status-dot" aria-hidden="true">{done ? <Icon name={icon} size={16} strokeWidth={2.4} /> : null}</span>
            <div>
              <strong>{tr(en, fil)}</strong>
              {l && <span className="m-sub">{l.changedBy === 'system' ? tr('Automatic', 'Awtomatiko') : l.changedByName || l.changedBy} · {when(l.changedAt)}</span>}
              {l && l.note && <span className="m-sub">“{l.note}”</span>}
              {!l && s === 'awaiting_review' && <span className="m-sub">{tr('Sent to the nurse when the signal allows', 'Ipapadala sa nars')}</span>}
              {!l && s === 'reviewed' && <span className="m-sub">{tr('A nurse will look at it', 'Titingnan ito ng nars')}</span>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
