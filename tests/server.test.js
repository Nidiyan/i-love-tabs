const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer, validateUrl, publicAddress, download } = require('../server');
const https = require('node:https');
const dns = require('node:dns/promises');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');

test('only credential-free HTTPS URLs on the default port are accepted', () => {
  assert.equal(validateUrl('https://example.com/guitar.mp4').hostname, 'example.com');
  for (const url of ['file:///etc/passwd', 'http://example.com/a', '******example.com/a', 'https://example.com:8443/a', 'bad']) {
    assert.throws(() => validateUrl(url));
  }
});

test('reject internal, reserved, IPv6 and mixed public/private DNS addresses', async () => {
  for (const host of ['127.0.0.1', '10.1.1.1', '169.254.169.254', '192.168.1.1', '100.64.0.1', '0.0.0.0', '198.18.0.1', '224.0.0.1', '[::1]']) {
    await assert.rejects(publicAddress(host));
  }
  await assert.rejects(publicAddress('example.com', async () => ['8.8.8.8', '127.0.0.1']));
  assert.equal(await publicAddress('example.com', async () => ['8.8.8.8']), '8.8.8.8');
});

test('slow DNS resolution and expired download deadlines fail promptly', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = publicAddress('example.com', () => new Promise(() => {}), 25);
  t.mock.timers.tick(25);
  await assert.rejects(pending, /lookup timed out/);
  await assert.rejects(download('https://example.com/a', '/tmp/unused-media', 0, Date.now() - 1), /download timed out/);
});

test('download pins validated DNS, bounds content, and revalidates redirects', async t => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'tabs-test-'));
  t.mock.method(dns, 'resolve4', async () => ['8.8.8.8']);
  let statusCode = 200;
  let headers = { 'content-type': 'audio/wav' };
  let chunks = [Buffer.from('test media')];
  let requests = 0;
  t.mock.method(https, 'get', (url, options) => {
    requests++;
    assert.equal(url.protocol, 'https:');
    options.lookup(url.hostname, {}, (error, address, family) => {
      assert.equal(error, null);
      assert.equal(address, '8.8.8.8');
      assert.equal(family, 4);
    });
    const request = new EventEmitter();
    request.destroy = error => request.emit('error', error);
    queueMicrotask(() => {
      const response = Readable.from(chunks);
      response.statusCode = statusCode;
      response.headers = headers;
      request.emit('response', response);
    });
    return request;
  });
  try {
    const destination = path.join(directory, 'media');
    await download('https://example.com/a', destination);
    assert.equal(await fs.readFile(destination, 'utf8'), 'test media');
    headers = { 'content-length': 41 * 1024 * 1024 };
    await assert.rejects(download('https://example.com/a', path.join(directory, 'large')), /40 MB/);
    headers = { 'content-type': 'audio/wav' };
    chunks = [Buffer.alloc(41 * 1024 * 1024)];
    await assert.rejects(download('https://example.com/a', path.join(directory, 'chunked')), /40 MB/);
    headers = { 'content-type': 'text/html' };
    await assert.rejects(download('https://example.com/a', path.join(directory, 'html')), /direct video/);
    statusCode = 302;
    headers = { location: 'https://127.0.0.1/private' };
    const before = requests;
    await assert.rejects(download('https://example.com/a', path.join(directory, 'redirect')), /public internet/);
    assert.equal(requests, before + 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function withServer(analyze, callback) {
  const server = createServer(analyze);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function post(base, body) {
  return fetch(`${base}/api/transcribe`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('serve homepage and pass selected tuning through the endpoint', async () => {
  await withServer(async (url, tuning) => ({ tabs: 'E|--0--', tuning, url }), async base => {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Video or audio URL/);
    const response = await post(base, { url: 'https://example.com/guitar.mp4', tuning: 'drop-d' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).tuning, 'drop-d');
    assert.equal((await fetch(`${base}/../server.js`)).status, 404);
  });
});

test('invalid requests are rejected before analysis; errors are returned clearly', async () => {
  let calls = 0;
  await withServer(async () => { calls++; throw new Error('No audio track.'); }, async base => {
    for (const body of [{}, { url: 'file:///etc/passwd' }, { url: 'https://example.com/a', tuning: 'unknown' }]) {
      assert.equal((await post(base, body)).status, 400);
    }
    const wrongType = await fetch(`${base}/api/transcribe`, { method: 'POST', body: '{}' });
    assert.equal(wrongType.status, 415);
    assert.equal(calls, 0);
    const response = await post(base, { url: 'https://example.com/a' });
    assert.deepEqual(await response.json(), { error: 'No audio track.' });
    assert.equal(response.status, 400);
    assert.equal(calls, 1);
  });
});

test('limit simultaneous analysis', async () => {
  let release;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  await withServer(() => {
    started();
    return new Promise(resolve => { release = resolve; });
  }, async base => {
    const pending = post(base, { url: 'https://example.com/a' });
    await ready;
    assert.equal((await post(base, { url: 'https://example.com/b' })).status, 429);
    release({ tabs: 'test' });
    assert.equal((await pending).status, 200);
  });
});
