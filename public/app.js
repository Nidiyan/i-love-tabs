const form = document.querySelector('#transcribe');
const status = document.querySelector('#status');
const results = document.querySelector('#results');
const submit = document.querySelector('#submit');
let transcription;

form.addEventListener('submit', async event => {
  event.preventDefault();
  results.hidden = true;
  submit.disabled = true;
  form.setAttribute('aria-busy', 'true');
  status.textContent = 'Downloading and listening… this can take up to two minutes.';
  try {
    const response = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: form.elements.url.value.trim(), tuning: form.elements.tuning.value }),
    });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || 'Could not analyze the recording.');
    transcription = data;
    document.querySelector('#result-tuning').textContent = `${data.tuning.strings.join(' – ')} (${data.tuning.confidence} confidence)`;
    document.querySelector('#result-key').textContent = `${data.key.name} (${data.key.confidence} confidence)`;
    document.querySelector('#tabs').textContent = data.tabs;
    document.querySelector('#warnings').replaceChildren(...data.warnings.map(warning => {
      const item = document.createElement('li');
      item.textContent = warning;
      return item;
    }));
    document.querySelector('#notes').replaceChildren(...data.notes.map(note => {
      const row = document.createElement('tr');
      for (const value of [note.start, note.duration, note.note, note.string ?? 'Unmapped', note.fret ?? '—']) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      return row;
    }));
    results.hidden = false;
    status.textContent = `Analyzed ${data.duration} seconds. Review the estimates below. String 1 is the lowest string.`;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    submit.disabled = false;
    form.removeAttribute('aria-busy');
  }
});

document.querySelector('#download').addEventListener('click', () => {
  if (!transcription) return;
  const text = `Tuning: ${transcription.tuning.strings.join(' ')}\nKey: ${transcription.key.name}\n\n${transcription.tabs}\n\n${transcription.warnings.join('\n')}\n`;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'guitar-tabs.txt';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
