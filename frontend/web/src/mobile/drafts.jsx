// Unsent form entries survive the inactivity lock, a time-out and a session ended on another device (see the
// drafts notes in api.js). A form reads its draft once, keeps it up to date while there is something to keep,
// and drops it when the entry is sent or discarded.
import React, { useEffect, useState } from 'react';
import { clearDraft, loadDraft, saveDraft } from '../api';
import { Banner, clock, isToday, useT } from './kit';
import { relTime } from '../format';

/** This form's saved draft, read once when the form opens (null when there is none). */
export function useRestoredDraft(key) {
  const [draft] = useState(() => loadDraft(key));
  return draft;
}

/** Saves `data` as the draft while `keep` is true; removes the draft once `keep` turns false. */
export function useKeepDraft(key, data, keep) {
  const json = JSON.stringify(data);
  useEffect(() => {
    if (keep) saveDraft(key, JSON.parse(json));
    else clearDraft(key);
  }, [key, json, keep]);
}

/** "Unsent entry restored" with a Discard button. */
export function DraftNotice({ draft, onDiscard }) {
  const tr = useT();
  const [hidden, setHidden] = useState(false);
  if (!draft || hidden) return null;
  const at = isToday(draft.savedAt) ? clock(draft.savedAt) : relTime(draft.savedAt);
  return (
    <Banner tone="info" icon="clipboard" role="status">
      {tr(`Your unsent entry from ${at} was kept. It has not been sent yet.`, `Naitabi ang hindi pa naipadalang entry mula ${at}.`)}{' '}
      <button type="button" className="m-link" style={{ padding: 0, minHeight: 0 }} onClick={() => { setHidden(true); onDiscard(); }}>{tr('Discard it', 'Itapon')}</button>
    </Banner>
  );
}
