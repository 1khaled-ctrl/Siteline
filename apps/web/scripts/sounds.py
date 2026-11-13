"""Builds the app's two sound files in apps/web/src/assets/sound, both synthesised here, so there is no source to credit:

- chime.mp3: a small, soft two-note chime for a copilot reply.
- tick.wav: a very quiet tick for each click of the phone's dial.

Every other sound in the app is made live by Tone.js (see apps/web/src/sound). Needs ffmpeg on the PATH for the MP3 and
nothing outside the standard library.

    python apps/web/scripts/sounds.py apps/web/src/assets/sound
"""

import math
import pathlib
import random
import struct
import subprocess
import sys
import wave

RATE = 44100


def write_wav(path: pathlib.Path, samples: list[float]) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", round(max(-1.0, min(1.0, s)) * 32767)) for s in samples))


def bell(freq: float, seconds: float, start: float, level: float, total: int, out: list[float]) -> None:
    """A soft mallet bell: a sine with two quiet overtones (one slightly inharmonic) and an exponential decay."""
    first = round(start * RATE)
    for i in range(min(total - first, round(seconds * RATE))):
        t = i / RATE
        envelope = min(1.0, t / 0.006) * math.exp(-t * 5.5)
        tone = (
            math.sin(2 * math.pi * freq * t)
            + 0.22 * math.sin(4 * math.pi * freq * t)
            + 0.07 * math.sin(2 * math.pi * 2.76 * freq * t)
        )
        out[first + i] += level * envelope * tone


def chime(out: pathlib.Path) -> None:
    total = round(1.1 * RATE)
    s = [0.0] * total
    bell(1046.5, 1.0, 0.0, 0.32, total, s)  # C6
    bell(1568.0, 0.95, 0.09, 0.22, total, s)  # G6, a fifth above, just after
    wav = out / "chime.wav"
    write_wav(wav, s)
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(wav), "-c:a", "libmp3lame", "-b:a", "96k", str(out / "chime.mp3")],
        check=True,
    )
    wav.unlink()


def tick(out: pathlib.Path) -> None:
    random.seed(7)
    total = round(0.03 * RATE)
    s = []
    for i in range(total):
        t = i / RATE
        envelope = min(1.0, t / 0.0008) * math.exp(-t * 260)
        s.append(0.55 * envelope * (0.8 * math.sin(2 * math.pi * 2300 * t) + 0.2 * (random.random() * 2 - 1)))
    write_wav(out / "tick.wav", s)


if __name__ == "__main__":
    out_dir = pathlib.Path(sys.argv[1])
    out_dir.mkdir(parents=True, exist_ok=True)
    chime(out_dir)
    tick(out_dir)
    for f in sorted(out_dir.iterdir()):
        print(f"{f.name}: {f.stat().st_size} bytes")
