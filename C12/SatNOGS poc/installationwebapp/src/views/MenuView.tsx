const VIEWS: [string, string][] = [
  ['globe', 'Orbit: the station seen from space, the satellite and its track'],
  ['globe&camera=follow', 'Tracking: the camera rides along with the satellite'],
  ['image&audio=1', 'Reception: the image arriving line by line, plays the sound'],
  ['schedule', 'Passes: received, on air, upcoming'],
  ['telemetry', 'Sky plot, Doppler, live numbers'],
  ['signal', 'APT spectrum waterfall, or the digital constellation'],
  ['grid', 'Grid: six views on one screen, 2 columns × 3 rows'],
  ['control', 'Operator: skip, restart, identify displays, play a pass next'],
]

// What opens without ?view=: links to every view, to try them in normal tabs
export function MenuView() {
  return (
    <div className="page">
      <h1>SatNOGS installation</h1>
      <p className="dim">
        Every display is one of these views; launch.ps1 opens them full screen, one per monitor (installation.json).
      </p>
      <ul className="menu">
        {VIEWS.map(([query, text]) => (
          <li key={query}>
            <a href={`/?view=${query}`} target="_blank" rel="noreferrer">
              {query}
            </a>
            <span className="dim"> {text}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
