// What this browser window is: /?view=globe&id=left&audio=1&camera=follow
const q = new URLSearchParams(location.search)

export const VIEW = q.get('view') ?? ''
export const DISPLAY_ID = q.get('id') ?? (VIEW || 'menu')
export const AUDIO = q.get('audio') === '1' // this display plays the sound
export const CAMERA: 'station' | 'follow' = q.get('camera') === 'follow' ? 'follow' : 'station'
export const SHOW_CURSOR = q.get('cursor') === 'show' // e.g. inside the grid page
