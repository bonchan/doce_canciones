// Spectrogram of a pass recording, computed once per recording. Decoding doesn't play
// anything, so any display can show the signal without autoplay rules or its own sound.
import type { SpectrogramJob } from './spectrogram.worker.ts'

export interface Spectrogram {
  rows: Uint8Array // count rows of bins values
  bins: number
  count: number
  rowsPerSecond: number // per second of recording
  maxHz: number
}

const RATE = 12000 // APT sits at 2400 Hz +- 2 kHz: no need for more
const cache = new Map<string, Promise<Spectrogram>>()

export function loadSpectrogram(url: string): Promise<Spectrogram> {
  let p = cache.get(url)
  if (!p) {
    p = compute(url)
    cache.set(url, p)
    p.catch(() => cache.delete(url))
    while (cache.size > 3) cache.delete(cache.keys().next().value!)
  }
  return p
}

async function compute(url: string): Promise<Spectrogram> {
  const data = await (await fetch(url)).arrayBuffer()
  const audio = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(data)
  const samples = audio.getChannelData(0).slice()
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./spectrogram.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<Spectrogram>) => {
      resolve(e.data)
      worker.terminate()
    }
    worker.onerror = (e) => {
      reject(new Error(e.message))
      worker.terminate()
    }
    const job: SpectrogramJob = { samples, rate: RATE, rowsPerSecond: 25, size: 512, maxHz: 5000 }
    worker.postMessage(job, [samples.buffer])
  })
}
