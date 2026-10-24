// Desktop shell of the nurse console (/clinic) and the admin console (/admin), Figma page "All" (Nurse · and
// Admin · frames): an inset sidebar card with section headings, pill nav items and a profile card with the
// log-out button. Nurse: dark sidebar on a white page. Admin: white sidebar on the dark green page.
import React from 'react';
import { requestSignOut } from '../api';
import { Link } from '../router';
import { initials } from '../format';
import Icon from '../mobile/icons';
import logo from '../assets/figma/eldercare-logo.png';

/** The heart mark of the ElderCare logo (the Figma crop of the full logo image). */
export function Logo() {
  return <span className="ad-logo" aria-hidden="true"><img src={logo} alt="" /></span>;
}

/**
 * sections: [{ title, items: [{ to, label, icon, exact, badge }] }]
 * user: the signed-in user; userSub: the line under their name.
 */
export default function DesktopShell({ variant, label, role, sections, user, userSub, children }) {
  return (
    <div className={`ad-app is-${variant} ${variant === 'nurse' ? 'ad-clinic' : ''}`}>
      <aside className="ad-side">
        <div className="ad-brand"><Logo /><strong>ElderCare</strong>{role && <span className="ad-role">{role}</span>}</div>
        <nav aria-label={label} className="ad-nav">
          {sections.map((s) => (
            <div key={s.title} className="ad-nav-group">
              <span className="ad-sep">{s.title}</span>
              {s.items.map((n) => (
                <Link key={n.to} to={n.to} exact={n.exact !== false} activeClassName="is-active">
                  <Icon name={n.icon} size={20} />{n.label}
                  {n.badge > 0 && <span className="ad-badge" aria-label={`${n.badge} new`}>{n.badge}</span>}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="ad-profile">
          <span className="ad-avatar" aria-hidden="true">{initials(user.name)}</span>
          <span className="ad-profile-name"><strong>{user.name}</strong><span>{userSub}</span></span>
          <button type="button" onClick={requestSignOut} aria-label="Log out" title="Log out"><Icon name="logout" size={20} /></button>
        </div>
      </aside>
      <main className="ad-main" id="main">{children}</main>
    </div>
  );
}
