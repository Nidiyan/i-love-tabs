import unittest

import numpy as np

from analyze import analyze, detect_notes, estimate_key, estimate_tuning, make_tabs


def melody(pitches, rate=16000):
    parts = []
    for midi in pitches:
        time = np.arange(int(rate * 0.45)) / rate
        frequency = 440 * 2 ** ((midi - 69) / 12)
        signal = 0.4 * np.sin(2 * np.pi * frequency * time)
        signal += 0.12 * np.sin(4 * np.pi * frequency * time)
        parts.extend([signal, np.zeros(int(rate * 0.12))])
    return np.concatenate(parts)


class AnalysisTests(unittest.TestCase):
    def test_sustained_notes_keep_full_duration_including_partial_final_hop(self):
        rate = 16000
        for length in [1600, 16000, 16213]:
            with self.subTest(length=length):
                time = np.arange(length) / rate
                notes = detect_notes(0.4 * np.sin(2 * np.pi * 110 * time), rate)
                self.assertEqual(len(notes), 1)
                self.assertEqual(notes[0]["midi"], 45)
                self.assertAlmostEqual(notes[0]["start"], 0, delta=0.02)
                self.assertAlmostEqual(notes[0]["duration"], length / rate, delta=0.021)
                self.assertLessEqual(notes[0]["start"] + notes[0]["duration"],
                                     round(length / rate, 3))

    def test_note_boundaries_follow_audio_not_window_left_edges(self):
        rate = 16000
        tone = 0.4 * np.sin(2 * np.pi * 110 * np.arange(rate // 2) / rate)
        samples = np.concatenate([np.zeros(rate // 4), tone, np.zeros(rate // 4)])
        notes = detect_notes(samples, rate)
        self.assertEqual(len(notes), 1)
        self.assertAlmostEqual(notes[0]["start"], 0.25, delta=0.02)
        self.assertAlmostEqual(notes[0]["start"] + notes[0]["duration"], 0.75, delta=0.02)

    def test_detect_guitar_notes_with_harmonics_and_silence(self):
        pitches = [38, 40, 45, 50, 55, 59, 64, 72]
        notes = detect_notes(melody(pitches), 16000)
        self.assertEqual([note["midi"] for note in notes], pitches)
        self.assertTrue(all(note["duration"] >= 0.08 for note in notes))
        self.assertTrue(all(a["start"] < b["start"] for a, b in zip(notes, notes[1:])))

    def test_silent_short_and_noisy_recordings_have_no_notes(self):
        rng = np.random.default_rng(7)
        for samples in [np.zeros(16000), np.zeros(10), np.array([]),
                        rng.normal(0, 0.1, 16000)]:
            self.assertEqual(detect_notes(samples, 16000), [])
        self.assertIn("error", analyze(np.zeros(16000), 16000))

    def test_tuning_estimates_are_explicitly_uncertain_and_overridable(self):
        for pitch, expected in [(40, "standard"), (39, "half-step-down"), (38, "drop-d")]:
            self.assertEqual(estimate_tuning([{"midi": pitch}], "auto"), (expected, "low"))
        self.assertEqual(estimate_tuning([{"midi": 40}], "dadgad"), ("dadgad", "user-selected"))
        with self.assertRaises(ValueError):
            analyze(melody([40]), 16000, "invalid")

    def test_low_d_requires_drop_d_and_notes_remain_unmapped_in_standard(self):
        notes = [{"midi": 38, "start": 0, "duration": 1}]
        mapped, tabs = make_tabs(notes, "drop-d")
        self.assertEqual((mapped[0]["string"], mapped[0]["fret"]), (1, 0))
        self.assertIn("D2|-0--", tabs)
        mapped, _ = make_tabs(notes, "standard")
        self.assertIsNone(mapped[0]["string"])
        self.assertIsNone(mapped[0]["fret"])

    def test_key_estimate_and_insufficient_evidence(self):
        profile = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
        notes = [{"midi": 60 + i, "duration": weight} for i, weight in enumerate(profile)]
        self.assertEqual(estimate_key(notes)["name"], "C major")
        self.assertEqual(estimate_key([{"midi": 40, "duration": 1}])["name"], "Unknown")
        self.assertEqual(estimate_key([{"midi": i, "duration": 1} for i in range(12)])["name"], "Unknown")

    def test_complete_transcription_maps_pitches_and_has_warnings(self):
        result = analyze(melody([40, 43, 47, 52]), 16000)
        self.assertEqual(result["tuning"]["id"], "standard")
        self.assertEqual(len(result["notes"]), 4)
        self.assertEqual(len(result["tabs"].splitlines()), 6)
        self.assertTrue(result["warnings"])
        for note in result["notes"]:
            self.assertEqual([40, 45, 50, 55, 59, 64][note["string"] - 1] + note["fret"], note["midi"])


if __name__ == "__main__":
    unittest.main()
