// Line icons matching the Figma "Icons" frame (24px grid, 2px stroke). Inline SVG: no icon library.
import React from 'react';

const P = {
  home: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h5v-6h4v6h5V9.5" /></>,
  clipboard: <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V3h6v1" /><path d="M9 10h6M9 14h6M9 18h4" /></>,
  pill: <><rect x="2.5" y="8.5" width="19" height="7" rx="3.5" transform="rotate(-45 12 12)" /><path d="m8.5 8.5 7 7" /></>,
  bell: <><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z" /><path d="M10 21h4" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /></>,
  users: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c1-3.5 3.5-5.5 6.5-5.5s5.5 2 6.5 5.5" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.7.8 2.9 2.5 3.5 5.2" /></>,
  smartphone: <><rect x="7" y="2.5" width="10" height="19" rx="2" /><path d="M11 18.5h2" /></>,
  phone: <path d="M5 4h3.5l1.5 4.5-2 1.5a11 11 0 0 0 6 6l1.5-2 4.5 1.5V19a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />,
  alert: <><path d="M12 3 2 20h20z" /><path d="M12 10v4M12 17.5v.01" /></>,
  arrowRight: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
  back: <path d="m15 5-7 7 7 7" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  x: <><path d="M6 6l12 12M18 6 6 18" /></>,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  checkCircle: <><circle cx="12" cy="12" r="9" /><path d="m8 12.5 3 3 5.5-6" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  refresh: <><path d="M20 11a8 8 0 0 0-14.5-4.5L4 8" /><path d="M4 3v5h5" /><path d="M4 13a8 8 0 0 0 14.5 4.5L20 16" /><path d="M20 21v-5h-5" /></>,
  wifiOff: <><path d="M2 8.5a15 15 0 0 1 5-3M22 8.5a15 15 0 0 0-11-3.4M5 12a10 10 0 0 1 4-2.3M19 12a10 10 0 0 0-3-1.9M8.5 15.5a5 5 0 0 1 7 0" /><path d="M12 19h.01M3 3l18 18" /></>,
  heart: <path d="M12 20s-8-4.9-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 9c0 6.1-8 11-8 11z" />,
  heartPulse: <><path d="M12 20s-8-4.9-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 9c0 6.1-8 11-8 11z" /><path d="M5 12h4l1.5-2.5 2 5 1.5-2.5H19" /></>,
  thermometer: <><path d="M10 14V5a2 2 0 1 1 4 0v9a4 4 0 1 1-4 0z" /><path d="M12 10v6" /></>,
  droplet: <path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" />,
  lungs: <><path d="M12 4v7M12 11c-1.5 1-3 1-3 1M12 11c1.5 1 3 1 3 1" /><path d="M8.5 7C5 7 3 13 3 17c0 2 1 3 3 3 2.5 0 3.5-2 3.5-4V9.5A2.5 2.5 0 0 0 8.5 7zM15.5 7C19 7 21 13 21 17c0 2-1 3-3 3-2.5 0-3.5-2-3.5-4V9.5A2.5 2.5 0 0 1 15.5 7z" /></>,
  pulse: <path d="M3 12h4l2-5 4 10 2-5h6" />,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  calendar: <><rect x="4" y="5" width="16" height="16" rx="2" /><path d="M4 10h16M9 3v4M15 3v4" /></>,
  zap: <path d="M13 2 4 14h7l-1 8 9-12h-7z" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
  shield: <><path d="M12 3 5 6v5c0 4.5 3 8.5 7 10 4-1.5 7-5.5 7-10V6z" /><path d="m9 12 2 2 4-4" /></>,
  server: <><rect x="4" y="4" width="16" height="7" rx="2" /><rect x="4" y="13" width="16" height="7" rx="2" /><path d="M8 7.5h.01M8 16.5h.01" /></>,
  file: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 12h6M9 16h6" /></>,
  flow: <><circle cx="6" cy="5" r="2.5" /><circle cx="18" cy="5" r="2.5" /><circle cx="12" cy="19" r="2.5" /><path d="M7.5 7 11 17M16.5 7 13 17M8.5 5h7" /></>,
  inbox: <><path d="M3 13h5l1.5 3h5l1.5-3h5" /><path d="M5 5h14l2 8v6H3v-6z" /></>,
  logout: <><path d="M14 4h5v16h-5" /><path d="M10 8l-4 4 4 4M6 12h10" /></>,
  textSize: <><path d="M4 7V5h9v2M8.5 5v14M6.5 19h4" /><path d="M14 12v-1.5h7V12M17.5 10.5V19M16 19h3" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z" /></>,
  message: <><path d="M4 5h16v11H9l-5 4z" /><path d="M8 9h8M8 12h5" /></>,
  fall: <><circle cx="15" cy="5" r="2" /><path d="M4 21h16M6 17l4-2 3 2 4-6M10 15l1-5 4 1" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  swap: <><path d="M4 8h14l-3.5-3.5" /><path d="M20 16H6l3.5 3.5" /></>,
  monitor: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  sliders: <><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></>,
};

export default function Icon({ name, size = 22, className, title, strokeWidth = 2 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : 'true'} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      {P[name]}
    </svg>
  );
}
