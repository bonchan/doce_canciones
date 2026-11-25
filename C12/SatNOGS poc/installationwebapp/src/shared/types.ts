// A pass of the downloads library (listener.py output), as server/manifest.ts reads it
export interface PassImage {
  kind: string // "normal", "decoded", "mcir", "msa", "mcir_map" (METEOR), ...
  label: string // kind as shown, e.g. "MCIR map"
  file: string
  url: string
  bytes: number
}

export interface StationInfo {
  name: string
  lat: number
  lon: number
}

export interface Pass {
  id: number
  folder: string
  satellite: string
  norad_cat_id: number | null
  mode: string | null // transmitter mode: APT (NOAA), FSK (METEOR LRPT recordings), ...
  start: string
  end: string | null
  max_altitude: number | null
  rise_azimuth: number | null
  set_azimuth: number | null
  station_id: number | null
  station_name: string | null
  station: StationInfo | null // where it was recorded
  url: string | null
  images: PassImage[]
  audio: string | null // APT recordings only
  audio_seconds: number | null // length of the recording, read from the .ogg
  live?: boolean // a pass the real receiver (raspberry_sat) is about to receive: real times, no images yet
  signal?: string | null // a real pass imported from the receiver: its signal.json (LiveSample[], ms)
  ours?: boolean // received by the installation's own receiver (imported, server/importer.ts)
}
