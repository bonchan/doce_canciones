import { Suspense, lazy, type ComponentType } from 'react'
import { Recover } from './components/Recover.tsx'
import { VIEW } from './params.ts'
import { ControlView } from './views/ControlView.tsx'
import { GridView } from './views/GridView.tsx'
import { ImageView } from './views/ImageView.tsx'
import { MenuView } from './views/MenuView.tsx'
import { ScheduleView } from './views/ScheduleView.tsx'
import { SignalView } from './views/SignalView.tsx'
import { TelemetryView } from './views/TelemetryView.tsx'

// only the globe displays load Cesium
const GlobeView = lazy(() => import('./views/GlobeView.tsx').then((m) => ({ default: m.GlobeView })))

const VIEWS: Record<string, ComponentType> = {
  globe: GlobeView,
  image: ImageView,
  schedule: ScheduleView,
  telemetry: TelemetryView,
  signal: SignalView,
  control: ControlView,
  grid: GridView,
}

export function App() {
  const View = VIEWS[VIEW] ?? MenuView
  return (
    <Recover>
      <Suspense fallback={null}>
        <View />
      </Suspense>
    </Recover>
  )
}
