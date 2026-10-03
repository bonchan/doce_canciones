// FFT of a decoded recording, row by row: Hann window, power in dB, scaled to 0..255
export interface SpectrogramJob {
  samples: Float32Array
  rate: number
  rowsPerSecond: number
  size: number // FFT size, power of two
  maxHz: number
}

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<SpectrogramJob>) => void) | null
  postMessage(msg: unknown, transfer: Transferable[]): void
}

scope.onmessage = (e) => {
  const { samples, rate, rowsPerSecond, size, maxHz } = e.data
  const hop = Math.max(1, Math.round(rate / rowsPerSecond))
  const bins = Math.min(size / 2, Math.floor(maxHz / (rate / size)))
  const count = Math.max(0, Math.floor((samples.length - size) / hop) + 1)

  const hann = new Float32Array(size)
  for (let i = 0; i < size; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1))
  const levels = Math.log2(size)
  const rev = new Uint32Array(size)
  for (let i = 0; i < size; i++) {
    let r = 0
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b)
    rev[i] = r
  }
  const cos = new Float32Array(size / 2)
  const sin = new Float32Array(size / 2)
  for (let k = 0; k < size / 2; k++) {
    cos[k] = Math.cos((2 * Math.PI * k) / size)
    sin[k] = Math.sin((2 * Math.PI * k) / size)
  }

  const re = new Float32Array(size)
  const im = new Float32Array(size)
  const db = new Float32Array(count * bins)
  for (let row = 0; row < count; row++) {
    const off = row * hop
    for (let i = 0; i < size; i++) {
      re[rev[i]] = samples[off + i] * hann[i]
      im[rev[i]] = 0
    }
    for (let len = 2; len <= size; len <<= 1) {
      const half = len >> 1
      const step = size / len
      for (let i = 0; i < size; i += len) {
        for (let j = 0; j < half; j++) {
          const wr = cos[j * step]
          const wi = -sin[j * step]
          const a = i + j
          const b = a + half
          const tr = re[b] * wr - im[b] * wi
          const ti = re[b] * wi + im[b] * wr
          re[b] = re[a] - tr
          im[b] = im[a] - ti
          re[a] += tr
          im[a] += ti
        }
      }
    }
    for (let k = 0; k < bins; k++) db[row * bins + k] = 10 * Math.log10(re[k] * re[k] + im[k] * im[k] + 1e-12)
  }

  // contrast from a sample of the values: 2nd percentile = black, 99.7th = full
  const sample: number[] = []
  for (let i = 0; i < db.length; i += 97) sample.push(db[i])
  sample.sort((a, b) => a - b)
  const lo = sample[Math.floor(sample.length * 0.02)] ?? 0
  const hi = sample[Math.floor(sample.length * 0.997)] ?? 1
  const scale = 255 / Math.max(1e-6, hi - lo)
  const rows = new Uint8Array(db.length)
  for (let i = 0; i < db.length; i++) rows[i] = Math.max(0, Math.min(255, (db[i] - lo) * scale))

  scope.postMessage({ rows, bins, count, rowsPerSecond: rate / hop, maxHz: bins * (rate / size) }, [rows.buffer])
}
