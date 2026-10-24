// Outdoor weather where the caregiver is (phone location -> GET /api/alerts/weather/current, OpenWeatherMap),
// falling back to the patient's address. A phone cannot measure body temperature, but outside heat explains a
// high reading, drives the heat advice, and is saved with each check-in (environment) for the nurse.
import React, { useEffect, useState } from 'react';
import { api } from '../api';
import Icon from './icons';
import { useT, usePrefs } from './kit';

const HEAT_ADVICE = {
  normal: null,
  caution: ['Warm outside. Offer water often.', 'Mainit sa labas. Painumin nang madalas.'],
  extreme_caution: ['Very hot outside. Keep them indoors, cool and drinking water.', 'Napakainit. Manatili sa loob, presko at umiinom ng tubig.'],
  danger: ['Dangerous heat. Keep them cool and watch for dizziness or confusion.', 'Mapanganib na init. Panatilihing presko at bantayan ang hilo o pagkalito.'],
  extreme_danger: ['Extreme heat. Call the clinic if they feel unwell.', 'Matinding init. Tumawag sa klinika kung masama ang pakiramdam.'],
};
const HEAT_TONE = { normal: 'ok', caution: 'moderate', extreme_caution: 'high', danger: 'critical', extreme_danger: 'critical' };
/** Heat levels worth a warning on the caregiver's Home screen. */
export const DANGEROUS_HEAT = ['extreme_caution', 'danger', 'extreme_danger'];

/** @param {{id:string, zipCode?:string, countryCode?:string}|null} place  patient whose address is the fallback */
export function useOutsideWeather(place) {
  const [state, setState] = useState({ status: 'locating', weather: null });
  const key = place ? place.id : null;
  useEffect(() => {
    if (!place) return undefined;
    let live = true;
    const load = (q, src) => api(`/api/alerts/weather/current?${q}`)
      .then((r) => live && setState({ status: 'ready', weather: { ...r, src } }))
      .catch(() => live && setState({ status: 'error', weather: null }));
    const byAddress = () => (place.zipCode
      ? load(`zip=${encodeURIComponent(place.zipCode)}&country=${place.countryCode || 'PH'}`, 'address')
      : setState({ status: 'error', weather: null }));
    if (!navigator.geolocation) byAddress();
    else {
      navigator.geolocation.getCurrentPosition(
        (pos) => { if (live) { setState((s) => ({ ...s, status: 'loading' })); load(`lat=${pos.coords.latitude.toFixed(4)}&lon=${pos.coords.longitude.toFixed(4)}`, 'device'); } },
        () => { if (live) { setState((s) => ({ ...s, status: 'loading' })); byAddress(); } },
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 10 * 60 * 1000 },
      );
    }
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

/** What gets saved with the check-in (checkin-service validates the same fields). */
export function toEnvironment(w) {
  if (!w) return undefined;
  return {
    outsideTempC: typeof w.temperatureC === 'number' ? w.temperatureC : undefined,
    heatIndexC: typeof w.heatIndexC === 'number' ? w.heatIndexC : undefined,
    humidity: typeof w.humidity === 'number' ? w.humidity : undefined,
    locationName: w.locationName ? String(w.locationName).slice(0, 80) : undefined,
    source: w.source,
  };
}

export function WeatherCard({ state, fallbackLabel, compact = false }) {
  const tr = useT();
  const { lang } = usePrefs();
  if (state.status === 'error') return null;
  if (state.status !== 'ready') {
    return compact ? null : <div className="m-weather is-loading" role="status"><Icon name="globe" size={18} />{tr('Checking the weather where you are…', 'Tinitingnan ang panahon sa lugar mo…')}</div>;
  }
  const w = state.weather;
  const advice = HEAT_ADVICE[w.heatLevel];
  const tone = HEAT_TONE[w.heatLevel] || 'ok';
  const feels = Math.round(w.heatIndexC ?? w.feelsLikeC);
  return (
    <section className={`m-weather tone-${tone}`} aria-label={tr('Weather outside', 'Panahon sa labas')}>
      <div className="m-between">
        <span className="m-caption" style={{ fontWeight: 700 }}>{tr('OUTSIDE NOW', 'SA LABAS NGAYON')} · {w.locationName || (w.src === 'device' ? tr('your location', 'lugar mo') : fallbackLabel)}</span>
        <span className="m-caption">{w.src === 'device' ? tr('from your phone', 'mula sa phone') : tr("from the patient's address", 'mula sa address ng pasyente')}</span>
      </div>
      <div className="m-row" style={{ marginTop: '.35rem', alignItems: 'baseline' }}>
        <strong style={{ fontSize: '1.75rem' }}>{Math.round(w.temperatureC)}°C</strong>
        <span className="m-muted">{tr(`feels like ${feels}°C`, `parang ${feels}°C`)} · {w.humidity}% {tr('humidity', 'halumigmig')}{w.conditions[0] ? ` · ${w.conditions[0]}` : ''}</span>
      </div>
      {advice && <p style={{ marginTop: '.35rem', fontWeight: 700 }}>{lang === 'fil' ? advice[1] : advice[0]}</p>}
    </section>
  );
}
