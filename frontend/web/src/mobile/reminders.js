// Reminders: a phone notification when a check-in, medicine or duty in today's plan is overdue.
// They run while the app is open or in the background (installed app or a browser tab); each item is
// announced once per day. Reminders that arrive with the app fully closed would need Web Push (a push
// server and stored subscriptions), which this prototype does not have.
import { useEffect } from 'react';
import { manilaDay } from './kit';

const PREF = 'eldercare.reminders';
const SENT = 'eldercare.reminded';
const CHECK_EVERY_MS = 60 * 1000;
const GRACE_MIN = 15; // remind once an item is 15 minutes late

export const remindersSupported = () => typeof window !== 'undefined' && 'Notification' in window;
export function remindersOn() {
  try { return remindersSupported() && Notification.permission === 'granted' && localStorage.getItem(PREF) === 'on'; } catch { return false; }
}
export async function enableReminders() {
  if (!remindersSupported()) return 'unsupported';
  const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  try { localStorage.setItem(PREF, p === 'granted' ? 'on' : 'off'); } catch { /* keep in memory */ }
  return p;
}
export function disableReminders() {
  try { localStorage.setItem(PREF, 'off'); } catch { /* ignore */ }
}

function sentToday() {
  try {
    const v = JSON.parse(localStorage.getItem(SENT)) || {};
    return v.day === manilaDay() ? v : { day: manilaDay(), ids: [] };
  } catch { return { day: manilaDay(), ids: [] }; }
}
async function notify(title, body, url, tag) {
  const opts = { body, tag, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url } };
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (reg) return reg.showNotification(title, opts);
  } catch { /* fall back to a page notification */ }
  return new Notification(title, opts);
}

const minutesLate = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  const now = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit' }).format(new Date()).split(':').map(Number);
  return now[0] * 60 + now[1] - (h * 60 + m);
};

/** Watches the plan and notifies about overdue items (only when the caregiver turned reminders on). */
export function useReminders(plan, base, lang = 'en') {
  useEffect(() => {
    if (!plan) return undefined;
    const tick = () => {
      if (!remindersOn()) return;
      const sent = sentToday();
      const due = plan.filter((i) => i.status === 'overdue' && minutesLate(i.time) >= GRACE_MIN && !sent.ids.includes(i.id));
      for (const i of due.slice(0, 3)) {
        const fil = lang === 'fil';
        const title = i.kind === 'checkin' ? (fil ? `Check-in para kay ${i.who}` : `Check-in due for ${i.who}`)
          : i.kind === 'dose' ? (fil ? `Gamot ni ${i.who}` : `Medicine for ${i.who}`) : (fil ? `Gawain para kay ${i.who}` : `Care duty for ${i.who}`);
        const body = `${fil ? i.titleFil : i.title} · ${i.time}`;
        const url = i.kind === 'duty' ? `${base}/duties` : `${base}/check-in?patient=${i.patientId}`;
        notify(title, body, url, i.id);
        sent.ids.push(i.id);
      }
      try { localStorage.setItem(SENT, JSON.stringify(sent)); } catch { /* ignore */ }
    };
    tick();
    const t = setInterval(tick, CHECK_EVERY_MS);
    return () => clearInterval(t);
  }, [plan, base, lang]);
}
