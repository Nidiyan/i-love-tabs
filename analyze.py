"""Audio-first, monophonic guitar transcription; no model or external service."""

import json
import sys
import wave

import numpy as np

PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
TUNINGS = {
    "standard": [40, 45, 50, 55, 59, 64],
    "drop-d": [38, 45, 50, 55, 59, 64],
    "half-step-down": [39, 44, 49, 54, 58, 63],
    "dadgad": [38, 45, 50, 55, 57, 62],
    "open-g": [38, 43, 50, 55, 59, 62],
}


def note_name(midi):
    return f"{PITCH_NAMES[midi % 12]}{midi // 12 - 1}"


def detect_notes(samples, rate):
    window = 2048
    hop = 320
    frames = []
    peak = float(np.max(np.abs(samples))) if len(samples) else 0
    if peak < 0.001:
        return []
    for start in range(0, len(samples) - window + 1, hop):
        frame = samples[start:start + window].copy()
        frame -= np.mean(frame)
        rms = float(np.sqrt(np.mean(frame ** 2)))
        midi = None
        if rms > max(0.004, peak * 0.025):
            spectrum = np.fft.rfft(frame, n=4096)
            correlation = np.fft.irfft(np.abs(spectrum) ** 2, n=4096)[:window]
            # Normalize by overlapping energy, avoiding bias toward short periods.
            energy = np.concatenate(([0.0], np.cumsum(frame ** 2)))
            lags = np.arange(int(rate / 1400), int(rate / 65) + 1)
            denominator = np.sqrt(
                energy[window - lags] * (energy[window] - energy[lags])
            )
            scores = correlation[lags] / np.maximum(denominator, 1e-12)
            maxima = np.where((scores[1:-1] > scores[:-2]) &
                              (scores[1:-1] >= scores[2:]))[0] + 1
            if len(maxima):
                best = float(np.max(scores[maxima]))
                candidates = maxima[scores[maxima] >= max(0.72, best * 0.95)]
                if len(candidates):
                    lag = int(lags[candidates[0]])
                    left, center, right = correlation[lag - 1:lag + 2]
                    divisor = left - 2 * center + right
                    offset = 0.5 * (left - right) / divisor if abs(divisor) > 1e-12 else 0
                    frequency = rate / (lag + float(np.clip(offset, -0.5, 0.5)))
                    pitch = int(round(69 + 12 * np.log2(frequency / 440)))
                    if 36 <= pitch <= 88:
                        midi = pitch
        frames.append((start / rate, midi, rms))

    notes = []
    index = 0
    while index < len(frames):
        start, midi, rms = frames[index]
        end = index + 1
        while end < len(frames) and frames[end][1] == midi:
            end += 1
        duration = (end - index) * hop / rate
        if midi is not None and duration >= 0.08:
            notes.append({"midi": midi, "start": round(start, 3),
                          "duration": round(duration, 3)})
        index = end
    return notes


def estimate_tuning(notes, requested):
    if requested != "auto":
        return requested, "user-selected"
    # Played pitches do not uniquely reveal open strings. Prefer standard
    # when there is no evidence requiring a lower tuning.
    lowest = min(note["midi"] for note in notes)
    if lowest >= 40:
        return "standard", "low"
    if lowest == 39:
        return "half-step-down", "low"
    if lowest == 38:
        return "drop-d", "low"
    return "standard", "unknown"


def estimate_key(notes):
    chroma = np.zeros(12)
    for note in notes:
        chroma[note["midi"] % 12] += note["duration"]
    if np.count_nonzero(chroma) < 3 or np.std(chroma) < 1e-12:
        return {"name": "Unknown", "confidence": "insufficient notes"}
    profiles = {
        "major": np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]),
        "minor": np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]),
    }
    scores = sorted(
        ((float(np.corrcoef(chroma, np.roll(profile, root))[0, 1]),
          f"{PITCH_NAMES[root]} {mode}")
         for mode, profile in profiles.items() for root in range(12)),
        reverse=True,
    )
    # A uniform distribution does not identify a key.
    if not np.isfinite(scores[0][0]):
        return {"name": "Unknown", "confidence": "insufficient tonal evidence"}
    return {"name": scores[0][1],
            "confidence": "moderate" if scores[0][0] > 0.6 and scores[0][0] - scores[1][0] > 0.08 else "low"}


def make_tabs(notes, tuning):
    strings = TUNINGS[tuning]
    previous_fret = 0
    previous_string = None
    output = []
    for note in notes:
        positions = [(index, note["midi"] - pitch) for index, pitch in enumerate(strings)
                     if 0 <= note["midi"] - pitch <= 24]
        if positions:
            string, fret = min(positions, key=lambda position:
                               abs(position[1] - previous_fret) + position[1] * 0.15 +
                               (0.5 if previous_string is not None and position[0] != previous_string else 0))
            previous_fret, previous_string = fret, string
        else:
            string, fret = None, None
        output.append({**note, "note": note_name(note["midi"]),
                       "string": string + 1 if string is not None else None, "fret": fret})
    blocks = []
    for offset in range(0, len(output), 24):
        rows = [f"{note_name(pitch):>3}|" for pitch in reversed(strings)]
        for note in output[offset:offset + 24]:
            for row in range(6):
                value = str(note["fret"]) if note["string"] == 6 - row else "-"
                rows[row] += value.center(4, "-")
        blocks.append("\n".join(row + "|" for row in rows))
    return output, "\n\n".join(blocks)


def analyze(samples, rate, requested="auto"):
    if requested != "auto" and requested not in TUNINGS:
        raise ValueError("Unsupported tuning")
    notes = detect_notes(samples, rate)
    if not notes:
        return {"error": "No stable guitar notes detected. Try a clearer, isolated melody."}
    tuning, confidence = estimate_tuning(notes, requested)
    mapped, tabs = make_tabs(notes, tuning)
    warnings = [
        "Experimental monophonic transcription: chords, vocals, effects, bends, and repeated notes may be missed.",
        "Audio cannot uniquely identify tuning or finger positions. Confirm the tuning and edit the suggested tabs.",
        "Only the first 60 seconds are analyzed. Tab columns show note order, not rhythmic spacing; use the timed note list for timing.",
    ]
    if any(note["string"] is None for note in mapped):
        warnings.append("Some pitches cannot be played in the selected tuning within 24 frets; they are marked unmapped.")
    return {"tuning": {"id": tuning, "strings": [note_name(pitch) for pitch in TUNINGS[tuning]],
                       "confidence": confidence},
            "key": estimate_key(notes), "notes": mapped, "tabs": tabs,
            "duration": round(len(samples) / rate, 2), "warnings": warnings}


if __name__ == "__main__":
    with wave.open(sys.argv[1], "rb") as audio:
        if audio.getnchannels() != 1 or audio.getsampwidth() != 2:
            raise ValueError("Expected mono 16-bit PCM audio")
        rate = audio.getframerate()
        samples = np.frombuffer(audio.readframes(rate * 60), dtype="<i2").astype(float) / 32768
    print(json.dumps(analyze(samples, rate, sys.argv[2]), allow_nan=False))
