import { NavLink } from 'react-router-dom';

// Tabs across the top of every page. The dot on System means an update is waiting.
export default function NavBar({ wsStatus, updateAvailable }) {
  const tab = ({ isActive }) => `nav-tab${isActive ? ' active' : ''}`;
  return (
    <nav className="navbar">
      <span className="nav-brand">Doce Canciones</span>
      <NavLink to="/devices" className={tab}>Devices</NavLink>
      <NavLink to="/system" className={tab}>
        System
        {updateAvailable && <span className="nav-dot" title="Update available" />}
      </NavLink>
      <span
        className={`nav-conn ${wsStatus === 'Connected' ? 'ok' : 'bad'}`}
        title={`Live connection to the backend: ${wsStatus}`}
      />
    </nav>
  );
}
