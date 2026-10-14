# i-love-tabs
Translate a video of a guitarist to a set of tabs.

## Run locally

Requires Node.js 22+, Python 3.10+ with pip, and FFmpeg on your PATH.
On Debian/Ubuntu, install FFmpeg with `sudo apt-get install ffmpeg`.

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
npm start
```

Open http://127.0.0.1:3000. No npm dependencies, API keys, database, or build step
are required. `PORT` and `HOST` configure the listener; `PYTHON` can specify a
Python executable if it is not named `python3`. Keep the default loopback binding
for local use. Public deployment needs authentication/rate limits at a reverse
proxy and a sandboxed, resource-limited FFmpeg worker.

## Use

Paste a **direct public HTTPS video/audio file URL** (for example, an MP4 link),
choose automatic tuning or a known tuning, and select **Generate tabs**.
The app downloads up to 40 MB and analyzes the first 60 seconds. Supported
containers include MP4/MOV, WebM/MKV, WAV, MP3, Ogg, FLAC, and AAC. The file must
contain audio. Streaming-site pages such as YouTube, private hosts, IPv6-only
hosts, authenticated links, and custom ports are not supported.
Only process recordings you own or have permission to use.

The audio-first pipeline extracts mono audio with FFmpeg, detects stable pitches
with normalized autocorrelation, estimates tuning and key, then maps notes onto
six strings (up to 24 frets), favoring small fret movements. Results include
plain-text tabs, estimated tuning/key, timed notes, and a download button.
Downloaded media is temporary and removed after each request. No third-party
AI service is used.

### Accuracy and limitations

- This is an **experimental monophonic** transcription tool, not a reliable
  transcription of chords or a full band. Clean, isolated melodies work best.
  Noise, harmonics, vocals, repeated notes, bends, and effects can cause errors.
- Tuning cannot generally be recovered from a melody. Auto uses standard tuning
  as a low-confidence baseline, suggests half-step down for a lowest detected D#2,
  and Drop D for D2. It does **not** distinguish alternate tunings with the same
  range or detect capo positions. Override tuning when you know it; available
  choices also include DADGAD and Open G.
- Key is a duration-weighted pitch-class/profile estimate, not a guarantee.
  Short or ambiguous passages may have low confidence or an unknown key.
- Finger positions are suggestions: the same pitch is playable in several
  places. This version does not analyze hand movements or video frames.
- Tab columns represent **note order**, not rhythm. Consult the timed note list
  for starts and durations. Unplayable pitches are listed as unmapped.
- One analysis runs at a time; downloads and subprocesses have timeouts.

## Tests

```sh
npm test
```

Tests use Node's built-in test runner and Python's `unittest` with synthetic
guitar-range tones. No network access is required for the tests.

## API

`POST /api/transcribe` with `Content-Type: application/json`:

```json
{"url": "https://example.com/guitar.mp4", "tuning": "auto"}
```

Returns `tuning`, `key`, `tabs`, `notes`, `duration`, and `warnings`, or an
`error` message when download/analysis fails or no stable notes are detected.
Tuning values: `auto`, `standard`, `drop-d`, `half-step-down`, `dadgad`, `open-g`.
In the timed notes, string **1 is the lowest-pitched string** and string 6 the
highest; the ASCII tab displays the highest string first.
