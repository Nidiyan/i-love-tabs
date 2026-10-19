const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const dns = require('node:dns/promises');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { createServer } = require('../server');

const run = promisify(execFile);

test('media download through FFmpeg and Python returns timed tabs and cleans up', async t => {
  try {
    await run('ffmpeg', ['-version']);
  } catch (error) {
    if (error.code !== 'ENOENT' || process.env.REQUIRE_MEDIA_TESTS === '1') throw error;
    t.skip('Install FFmpeg to run the media pipeline test (required in the container).');
    return;
  }
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'tabs-fixture-'));
  const media = path.join(directory, 'guitar.mp4');
  let downloadedFile;
  t.mock.method(dns, 'resolve4', async () => ['8.8.8.8']);
  t.mock.method(https, 'get', () => {
    const request = new EventEmitter();
    request.destroy = error => request.emit('error', error);
    queueMicrotask(() => {
      const response = createReadStream(media);
      response.statusCode = 200;
      response.headers = { 'content-type': 'video/mp4' };
      request.emit('response', response);
    });
    return request;
  });
  const originalMkdtemp = fs.mkdtemp;
  t.mock.method(fs, 'mkdtemp', async (...args) => {
    const result = await originalMkdtemp(...args);
    downloadedFile = path.join(result, 'media');
    return result;
  });
  const server = createServer();
  try {
    await run('ffmpeg', [
      '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=size=64x64:rate=10:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=110:duration=1:sample_rate=16000',
      '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', media,
    ]);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/guitar.mp4', tuning: 'standard' }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.notes.length, 1);
    assert.equal(result.notes[0].note, 'A2');
    assert.ok(result.notes[0].duration >= 0.98);
    assert.match(result.tabs, /A2\|/);
    await assert.rejects(fs.access(path.dirname(downloadedFile)), { code: 'ENOENT' });
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
