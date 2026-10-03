"""
NOAA APT decoder: SatNOGS .ogg audio recording -> grayscale PNG.

APT in a nutshell:
    - the FM-demodulated audio carries a 2400 Hz tone, AM-modulated by pixel brightness
    - 4160 pixels ("words") per second, 2 lines per second -> 2080 words per line
    - each line = sync A | space A | image A (909) | telemetry A |
                  sync B | space B | image B (909) | telemetry B
    - sync A is 7 cycles of a 1040 Hz square wave, used to find where lines start

Pipeline:
    audio -> resample to 20800 Hz -> AM envelope -> downsample to 4160 words/s
          -> find sync A in every line -> stack lines -> normalize -> PNG

Usage:
    python apt_decode.py recording.ogg            -> recording.png
    python apt_decode.py recording.ogg -o out.png --rotate
    python apt_decode.py downloads                -> every APT .ogg in the folder
"""

import argparse
import json
import math
from pathlib import Path

import numpy as np
import soundfile as sf
from PIL import Image
from scipy.signal import correlate, resample_poly

FS = 20800          # working sample rate: 5 samples per APT word
WORD_RATE = 4160    # APT words (pixels) per second
LINE = 2080         # words per line
CARRIER = 2400      # Hz, AM subcarrier
DRIFT = 5           # max words a line start may move from one line to the next

# sync A at word rate: 7 cycles of 1040 Hz (2 words high, 2 low), then low
SYNC_A = np.array([-1, -1, 1, 1] * 7 + [-1] * 7, dtype=np.float32)


def load_audio(path):
    x, fs = sf.read(path, dtype="float32", always_2d=True)
    x = x.mean(axis=1)  # mono
    g = math.gcd(FS, fs)
    return resample_poly(x, FS // g, fs // g).astype(np.float32)


def am_demod(x):
    """Envelope of a sine at CARRIER Hz using two consecutive samples.

    With x[n] = A cos(t) and x[n-1] = A cos(t - phi):
        x[n]^2 + x[n-1]^2 - 2 x[n] x[n-1] cos(phi) = A^2 sin(phi)^2
    """
    phi = 2 * np.pi * CARRIER / FS
    prev = np.concatenate(([0.0], x[:-1])).astype(np.float32)
    a2 = x * x + prev * prev - 2 * x * prev * np.cos(phi)
    return np.sqrt(np.maximum(a2, 0)) / np.sin(phi)


def find_line_starts(words):
    corr = correlate(words - words.mean(), SYNC_A, mode="valid", method="fft")

    # line phase: fold the correlation into rows of one line and pick the column
    # where sync A shows up most consistently over the whole pass
    n = len(corr) // LINE
    folded = corr[: n * LINE].reshape(n, LINE)
    phase = int(np.argmax(folded.sum(axis=0)))
    threshold = 0.5 * np.median(folded[:, phase])

    # follow the sync line by line, allowing slow drift; in noisy parts
    # (low elevation) a weak peak is ignored and the expected position is kept
    starts = [phase]
    while True:
        expected = starts[-1] + LINE
        lo, hi = expected - DRIFT, expected + DRIFT + 1
        if hi > len(corr):
            break
        best = lo + int(np.argmax(corr[lo:hi]))
        starts.append(best if corr[best] > threshold else expected)
    return starts


def decode(path):
    x = load_audio(path)
    envelope = am_demod(x)
    words = resample_poly(envelope, 1, FS // WORD_RATE).astype(np.float32)
    starts = find_line_starts(words)
    lines = np.stack([words[s : s + LINE] for s in starts if s + LINE <= len(words)])

    lo, hi = np.percentile(lines, [0.5, 99.5])
    img = np.clip((lines - lo) / (hi - lo), 0, 1) * 255
    return img.astype(np.uint8)


def decode_file(ogg, out=None, rotate=False):
    img = decode(ogg)
    if rotate:  # northbound passes come out upside down
        img = img[::-1, ::-1]
    out = Path(out) if out else Path(ogg).with_suffix(".png")
    Image.fromarray(img).save(out)
    print(f"[decoded] {out}  ({img.shape[0]} lines)")


def is_apt(ogg):
    """In a listener.py folder, only decode recordings of APT transmitters."""
    meta = ogg.parent / "observation.json"
    if not meta.exists():
        return True
    return json.loads(meta.read_text(encoding="utf-8")).get("mode") == "APT"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("path", help=".ogg/.wav file, or a folder to scan for APT .ogg files")
    ap.add_argument("-o", "--out", help="output PNG (single file only)")
    ap.add_argument("--rotate", action="store_true", help="rotate 180 deg (northbound passes)")
    args = ap.parse_args()

    path = Path(args.path)
    if path.is_file():
        decode_file(path, args.out, args.rotate)
        return

    for ogg in sorted(path.rglob("*.ogg")):
        if ogg.with_suffix(".png").exists() or not is_apt(ogg):
            continue
        try:
            decode_file(ogg, rotate=args.rotate)
        except Exception as e:
            print(f"[error] {ogg}: {e}")


if __name__ == "__main__":
    main()
