import { createElement } from 'react';
import PolargraphPage from './PolargraphPage';
import VoicePage from './VoicePage';
import WindWorldPage from './WindWorldPage';
import ServosPage from './ServosPage';
import BreathePage from './BreathePage';
import PlantLightPage from './PlantLightPage';
import NotImplementedPage from '../NotImplementedPage';

// Per-type page registry — add an entry here when a device type gets its
// own page. Used by both the single-device page (/devices?id=...) and the
// type-filtered list (/devices?type=...), so both show the same full page.
const DEVICE_PAGES = {
  polargraph: PolargraphPage,
  voice: VoicePage,
  servos: ServosPage,
  breathe: BreathePage,
  plant_light: PlantLightPage,
  // If the Godot piece is ever given a type of its own, this is the key it
  // would use, and the "display" special case below stops being needed.
  'display.wind_world': WindWorldPage,
};

// The page component for one device; NotImplementedPage (generic telemetry
// + commands) when its type has no dedicated page.
//
// Two different devices announce type "display" on this bus: BichitoPantallas
// and the Godot wind world. They can't be told apart by type (and the
// backend drops "sn" from the announce), but the wind world advertises its
// preset list in the announce, which lands in node.meta. This is a
// workaround for two devices sharing one type, not a pattern to copy.
function pageForNode(node) {
  if (node.type === 'display') {
    return (node.meta || {}).presets ? WindWorldPage : NotImplementedPage;
  }
  return DEVICE_PAGES[node.type] || NotImplementedPage;
}

// Renders the right particular page for props.node, passing every prop on.
export default function DevicePage(props) {
  return createElement(pageForNode(props.node), props);
}
