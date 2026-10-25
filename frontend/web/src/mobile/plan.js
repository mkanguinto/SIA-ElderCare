// "Today's plan": the caregiver's day in one timeline - each elder's check-in, every medicine dose and every
// scheduled care duty, in time order with its status. Also feeds the reminders (mobile/reminders.js).
import { useEffect, useState } from 'react';
import { api } from '../api';
import { todaysDoses } from './data';
import { isToday, manilaDay } from './kit';

const nowHm = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit' }).format(new Date());
const DOSE_STATUS = { taken: 'done', missed: 'missed', due: 'due', unknown: 'overdue' };

/**
 * @param {Array} elders  from useElders (patient + checkins + meds)
 * @param {Object} checklists  patientId -> care-plan checklist for today
 * @returns {Array<{id,time,kind,title,detail,patientId,who,status}>} sorted by time
 */
export function buildPlan(elders = [], checklists = {}) {
  const now = nowHm();
  const items = [];
  for (const e of elders) {
    const who = e.fullName.split(' ').slice(0, 2).join(' ');
    const todayCheckin = e.checkins.find((c) => isToday(c.recordedAt));
    const checkinTime = e.meds.flatMap((m) => m.times).sort()[0] || '08:00';
    items.push({
      id: `checkin-${e.id}`, time: checkinTime, kind: 'checkin', patientId: e.id, who,
      title: 'Daily check-in', titleFil: 'Check-in ngayon', detail: null,
      status: todayCheckin ? 'done' : checkinTime <= now ? 'overdue' : 'due',
    });
    for (const d of todaysDoses(e.meds, e.checkins)) {
      items.push({
        id: `dose-${e.id}-${d.id}`, time: d.time, kind: 'dose', patientId: e.id, who,
        title: `Give ${d.med.name} ${d.med.dosage}`, titleFil: `Ibigay ang ${d.med.name} ${d.med.dosage}`, detail: d.med.instructions,
        status: DOSE_STATUS[d.status],
      });
    }
    const list = checklists[e.id];
    for (const it of (list && list.items) || []) {
      if (!it.slot || it.slot === 'any') continue;
      items.push({
        id: `duty-${e.id}-${it.taskId}-${it.slot}`, time: it.slot, kind: 'duty', patientId: e.id, who, taskId: it.taskId,
        title: it.title, titleFil: it.title, detail: it.instructions,
        status: it.status === 'pending' ? (it.slot <= now ? 'overdue' : 'due') : it.status,
      });
    }
  }
  const order = { checkin: 0, dose: 1, duty: 2 };
  return items.sort((a, b) => a.time.localeCompare(b.time) || order[a.kind] - order[b.kind]);
}

/** Today's care-plan checklists for every elder, refreshed every 5 minutes. */
export function useChecklists(elders) {
  const [lists, setLists] = useState({});
  const ids = (elders || []).map((e) => e.id).join(',');
  useEffect(() => {
    if (!ids) return undefined;
    let live = true;
    const load = () => Promise.all(ids.split(',').map((id) => api(`/api/patients/${encodeURIComponent(id)}/care-plan/checklist`)
      .then((c) => [id, c]).catch(() => [id, null])))
      .then((pairs) => live && setLists(Object.fromEntries(pairs)));
    load();
    const t = setInterval(load, 5 * 60 * 1000);
    return () => { live = false; clearInterval(t); };
  }, [ids]);
  return lists;
}

/** Days with at least one check-in in the last 7 days (today included), oldest first. */
export function weekDays(checkins = []) {
  const days = new Set(checkins.map((c) => manilaDay(c.recordedAt)));
  return Array.from({ length: 7 }, (_, i) => {
    const d = manilaDay(Date.now() - (6 - i) * 86400000);
    return { day: d, done: days.has(d) };
  });
}
