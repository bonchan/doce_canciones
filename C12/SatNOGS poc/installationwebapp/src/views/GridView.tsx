import { useState } from 'react'

// what a cell can show (the same queries as the main menu)
const OPTIONS: [string, string][] = [
  ['globe', 'orbit'],
  ['globe&camera=follow', 'tracking'],
  ['image', 'reception'],
  ['image&audio=1', 'reception + sound'],
  ['schedule', 'passes'],
  ['telemetry', 'telemetry'],
  ['signal', 'signal'],
  ['control', 'control'],
]

const CELLS = 6
const KEY = 'satnogs-installation-grid'

// "reception" with or without sound is the same view
const viewOf = (query: string) => query.replace('&audio=1', '')

// the saved cells, without repeated views (a grid saved before they were blocked)
function load(): (string | null)[] {
  const cells: (string | null)[] = Array(CELLS).fill(null)
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    if (!Array.isArray(saved)) return cells
    const seen = new Set<string>()
    for (let i = 0; i < CELLS; i++) {
      const query = saved[i]
      if (typeof query !== 'string' || seen.has(viewOf(query))) continue
      seen.add(viewOf(query))
      cells[i] = query
    }
  } catch {
    // nothing saved yet
  }
  return cells
}

// Six views on one screen, 2 columns × 3 rows. Each cell is the view's own page in a frame,
// so it behaves like a small monitor (own top bar, sizing, clock sync, sound).
export function GridView() {
  const [cells, setCells] = useState(load)
  // views already on screen are grayed out in the other cells' lists, and can't be picked again
  const used = new Set(cells.filter((c): c is string => !!c).map(viewOf))

  const set = (i: number, query: string | null) => {
    if (query && cells.some((c, k) => k !== i && c && viewOf(c) === viewOf(query))) return
    const next = cells.map((c, k) => (k === i ? query : c))
    setCells(next)
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      // not remembered after a reload
    }
  }

  return (
    <div className="grid-page">
      {cells.map((query, i) => (
        <div key={i} className="grid-cell">
          {query ? (
            <>
              <iframe key={query} src={`/?view=${query}&id=grid-${i + 1}&cursor=show`} title={query} allow="autoplay; fullscreen" />
              <button className="grid-close" title="close" onClick={() => set(i, null)}>
                ×
              </button>
            </>
          ) : (
            <ul className="grid-menu">
              {OPTIONS.map(([option, label]) => (
                <li key={option}>
                  <button
                    disabled={used.has(viewOf(option))}
                    title={used.has(viewOf(option)) ? 'already in another cell' : undefined}
                    onClick={() => set(i, option)}
                  >
                    {label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}
