// Read a blood-pressure monitor over Bluetooth (Web Bluetooth, standard GATT Blood Pressure Service 0x1810).
// Works in Chrome / Edge on Android, ChromeOS, Windows and macOS with monitors that follow the Bluetooth SIG
// profile (most Omron, A&D, Beurer, Microlife "Bluetooth Smart" models). iPhone browsers do not support it,
// so the button is hidden there and the caregiver types the numbers instead.

export const bluetoothSupported = () => typeof navigator !== 'undefined' && Boolean(navigator.bluetooth);

/** IEEE-11073 16-bit SFLOAT: 4-bit signed exponent, 12-bit signed mantissa. */
export function sfloat(raw) {
  let mantissa = raw & 0x0fff;
  let exponent = raw >> 12;
  if (mantissa === 0x07ff || mantissa === 0x0800 || mantissa === 0x07fe) return null; // NaN / NRes / +-INF
  if (mantissa >= 0x0800) mantissa -= 0x1000;
  if (exponent >= 0x8) exponent -= 0x10;
  return mantissa * 10 ** exponent;
}

/** Parses a Blood Pressure Measurement characteristic value (0x2A35). */
export function parseMeasurement(view) {
  const flags = view.getUint8(0);
  const kpa = flags & 0x01;
  const toMmHg = (v) => (v == null ? null : Math.round(kpa ? v * 7.50062 : v));
  let i = 1;
  const systolic = toMmHg(sfloat(view.getUint16(i, true))); i += 2;
  const diastolic = toMmHg(sfloat(view.getUint16(i, true))); i += 2;
  i += 2; // mean arterial pressure
  if (flags & 0x02) i += 7; // time stamp
  const pulse = flags & 0x04 ? sfloat(view.getUint16(i, true)) : null;
  return { systolic, diastolic, heartRate: pulse == null ? null : Math.round(pulse) };
}

/**
 * Pairs with a monitor and waits for its reading. Most monitors send their stored readings right after
 * connecting; the newest one (the last to arrive) is returned.
 * @returns {Promise<{systolic:number, diastolic:number, heartRate:number|null}>}
 */
export async function readBloodPressure({ waitMs = 20000 } = {}) {
  const device = await navigator.bluetooth.requestDevice({ filters: [{ services: ['blood_pressure'] }] });
  const server = await device.gatt.connect();
  try {
    const service = await server.getPrimaryService('blood_pressure');
    const ch = await service.getCharacteristic('blood_pressure_measurement');
    return await new Promise((resolve, reject) => {
      let latest = null;
      let settle;
      const finish = () => (latest ? resolve(latest) : reject(new Error('No reading came from the monitor. Take a measurement, then try again.')));
      const timer = setTimeout(finish, waitMs);
      ch.addEventListener('characteristicvaluechanged', (e) => {
        const r = parseMeasurement(e.target.value);
        if (r.systolic && r.diastolic) latest = r;
        clearTimeout(settle);
        settle = setTimeout(() => { clearTimeout(timer); finish(); }, 1500); // wait for the burst of stored readings to end
      });
      ch.startNotifications().catch(reject);
    });
  } finally {
    if (server.connected) server.disconnect();
  }
}
