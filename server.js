const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns/promises');
const net = require('node:net');
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const MAX_BYTES = 40 * 1024 * 1024;
const TUNINGS = ['auto', 'standard', 'drop-d', 'half-step-down', 'dadgad', 'open-g'];
const blocked = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
]) blocked.addSubnet(address, prefix);

function validateUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter a valid HTTPS media URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password ||
      (url.port && url.port !== '443')) {
    throw new Error('Use an HTTPS URL without credentials or a custom port.');
  }
  return url;
}

async function publicAddress(hostname, resolve = dns.resolve4) {
  if (net.isIP(hostname) === 6 || hostname.includes(':')) {
    throw new Error('Only public IPv4 media hosts are supported.');
  }
  const addresses = net.isIP(hostname) === 4 ? [hostname] : await resolve(hostname);
  if (!addresses.length || addresses.some(address =>
    net.isIP(address) !== 4 || blocked.check(address))) {
    throw new Error('The URL must point to a public internet address.');
  }
  return addresses[0];
}

async function download(value, destination, redirects = 0, deadline = Date.now() + 45000) {
  if (redirects > 4) throw new Error('Too many media redirects.');
  const url = validateUrl(value);
  const address = await publicAddress(url.hostname);
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Media download timed out.');
  await new Promise((resolve, reject) => {
    // Pin the validated address so a DNS change cannot redirect this connection internally.
    const request = https.get(url, {
      lookup: (_hostname, options, callback) => options.all
        ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4),
    });
    const timer = setTimeout(() => request.destroy(new Error('Media download timed out.')), remaining);
    request.on('error', reject);
    request.on('response', async response => {
      try {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.destroy();
          if (!response.headers.location) throw new Error('Media redirect has no destination.');
          await download(new URL(response.headers.location, url).href, destination, redirects + 1, deadline);
        } else {
          if (response.statusCode !== 200) throw new Error('The media host refused the download.');
          if (Number(response.headers['content-length']) > MAX_BYTES) {
            throw new Error('Media must be smaller than 40 MB.');
          }
          const contentType = response.headers['content-type'] || '';
          if (/text\/|application\/(?:json|xhtml)/i.test(contentType)) {
            throw new Error('Use a direct video/audio file URL, not a streaming-site page.');
          }
          let bytes = 0;
          const limit = new Transform({
            transform(chunk, _encoding, callback) {
              bytes += chunk.length;
              callback(bytes > MAX_BYTES ? new Error('Media must be smaller than 40 MB.') : null, chunk);
            },
          });
          await pipeline(response, limit, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
        }
        resolve();
      } catch (error) {
        response.destroy();
        reject(error);
      } finally {
        clearTimeout(timer);
      }
    });
    request.once('error', () => clearTimeout(timer));
  });
}

async function transcribe(url, tuning) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'i-love-tabs-'));
  try {
    const media = path.join(directory, 'media');
    const audio = path.join(directory, 'audio.wav');
    await download(url, media);
    try {
      await run('ffmpeg', [
        '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe',
        '-format_whitelist', 'mov,mp3,wav,ogg,flac,matroska,webm,aac',
        '-i', media, '-t', '60', '-vn', '-ac', '1', '-ar', '16000',
        '-c:a', 'pcm_s16le', audio,
      ], { timeout: 30000, maxBuffer: 1024 * 1024 });
    } catch (error) {
      throw new Error(error.code === 'ENOENT'
        ? 'FFmpeg is not installed on the server.'
        : 'Could not read this media. Use a supported video/audio file with an audio track.');
    }
    try {
      const { stdout } = await run(process.env.PYTHON || 'python3', [
        path.join(__dirname, 'analyze.py'), audio, tuning,
      ], { timeout: 30000, maxBuffer: 1024 * 1024 });
      return JSON.parse(stdout);
    } catch {
      throw new Error('Analysis failed. Check the Python/NumPy setup and use a clear, isolated guitar melody.');
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 4096) throw new Error('Request is too large.');
  }
  try { return JSON.parse(body); } catch { throw new Error('Send a valid JSON request.'); }
}

function createServer(analyze = transcribe) {
  let busy = false;
  return http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    const send = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
    if (request.method === 'GET' && Object.hasOwn(assets, request.url)) {
      const [file, type] = assets[request.url];
      try {
        const content = await fs.readFile(path.join(__dirname, 'public', file));
        response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        response.end(content);
      } catch { send(500, { error: 'Could not load the page.' }); }
      return;
    }
    if (request.method !== 'POST' || request.url !== '/api/transcribe') {
      send(404, { error: 'Not found.' });
      return;
    }
    // JSON-only requests prevent cross-site form submissions from starting expensive work.
    if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) {
      send(415, { error: 'Use application/json.' });
      return;
    }
    if (busy) { send(429, { error: 'Another video is being analyzed. Please try again shortly.' }); return; }
    busy = true;
    try {
      const { url, tuning = 'auto' } = await readJson(request);
      if (typeof url !== 'string' || url.length > 2048) throw new Error('Enter a media URL.');
      validateUrl(url);
      if (!TUNINGS.includes(tuning)) throw new Error('Choose a supported tuning.');
      send(200, await analyze(url, tuning));
    } catch (error) {
      send(400, { error: error.message });
    } finally {
      busy = false;
    }
  });
}

if (require.main === module) {
  const server = createServer();
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => {
    console.log(`i-love-tabs running on http://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 3000}`);
  });
}

module.exports = { createServer, validateUrl, publicAddress, download };
