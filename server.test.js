import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPostServer } from './server.js';

async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'post-server-'));
  const logFile = join(directory, 'logs', 'requests.jsonl');
  const server = createPostServer({
    logFile,
    logger: { log() {}, error() {} },
    ...options,
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}`, logFile, directory };
}

async function records(logFile) {
  return (await readFile(logFile, 'utf8')).trim().split('\n').map(JSON.parse);
}

test('POST accepts any path and persists UTF-8, metadata and redacted headers before 200', async (t) => {
  const { url, logFile } = await setup(t);
  const body = JSON.stringify({ message: 'Привет' });
  const response = await fetch(`${url}/webhook?source=test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test', Cookie: 'secret=1' },
    body,
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  const [record] = await records(logFile);
  assert.equal(result.status, 'ok');
  assert.equal(result.requestId, record.id);
  assert.equal(result.receivedBytes, Buffer.byteLength(body));
  assert.equal(record.body, body);
  assert.equal(record.bodyEncoding, 'utf8');
  assert.equal(record.url, '/webhook?source=test');
  assert.deepEqual(record.query, { source: 'test' });
  assert.equal(record.clientIp, '127.0.0.1');
  assert.equal(record.headers.authorization, '[REDACTED]');
  assert.equal(record.headers.cookie, '[REDACTED]');
});

test('GET persists decoded query parameters, repeated keys and metadata before 200', async (t) => {
  const { url, logFile } = await setup(t);
  const target = '/save?message=hello+world&id=123&tag=one&tag=two&empty=&flag'
    + '&text=%D0%9F%D1%80%D0%B8%D0%B2%D0%B5%D1%82&escaped=a%26b%3Dc'
    + '&__proto__=value&constructor=test';
  const response = await fetch(`${url}${target}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  const [record] = await records(logFile);
  assert.equal(result.status, 'ok');
  assert.equal(result.requestId, record.id);
  assert.equal(result.receivedBytes, 0);
  assert.equal(record.method, 'GET');
  assert.equal(record.url, target);
  assert.equal(record.clientIp, '127.0.0.1');
  assert.equal(record.body, '');
  assert.equal(record.bodyEncoding, 'utf8');
  assert.deepEqual(record.query, {
    message: 'hello world',
    id: '123',
    tag: ['one', 'two'],
    empty: '',
    flag: '',
    text: 'Привет',
    escaped: 'a&b=c',
    ['__proto__']: 'value',
    constructor: 'test',
  });
});

test('GET accepts any path and saves repeated requests as separate records', async (t) => {
  const { url, logFile } = await setup(t);
  const paths = ['/', '/save', '/custom?x=1', '/custom?x=1', '/?message=root'];
  for (const path of paths) {
    assert.equal((await fetch(`${url}${path}`)).status, 200);
  }
  const saved = await records(logFile);
  assert.deepEqual(saved.map((record) => record.url), paths);
  assert.ok(saved.every((record) => record.method === 'GET'));
  assert.deepEqual(saved[0].query, {});
  assert.equal(new Set(saved.map((record) => record.id)).size, paths.length);
});

test('former frontend routes now accept GET data and return JSON only', async (t) => {
  const { url, logFile } = await setup(t);
  const paths = ['/', '/ui', '/ui/', '/ui/styles.css', '/ui/app.js'];
  for (const path of paths) {
    const response = await fetch(`${url}${path}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    assert.equal((await response.json()).status, 'ok');
  }
  assert.deepEqual((await records(logFile)).map((record) => record.url), paths);
});

test('client IP headers are trusted only in proxy mode and must contain a valid IP', async (t) => {
  for (const { trustProxy, header, expected } of [
    { trustProxy: false, header: '203.0.113.10', expected: '127.0.0.1' },
    { trustProxy: true, header: '203.0.113.10', expected: '203.0.113.10' },
    { trustProxy: true, header: '2001:db8::1', expected: '2001:db8::1' },
    { trustProxy: true, header: 'not-an-ip', expected: '127.0.0.1' },
  ]) {
    const { url, logFile } = await setup(t, { trustProxy });
    const response = await fetch(`${url}/save?proxy=test`, { headers: { 'X-Real-IP': header } });
    assert.equal(response.status, 200);
    const [record] = await records(logFile);
    assert.equal(record.clientIp, expected);
    assert.equal(record.peerIp, '127.0.0.1');
  }
});

test('empty and binary bodies are preserved', async (t) => {
  const { url, logFile } = await setup(t);
  const binary = Buffer.from([0, 255, 128, 1]);
  assert.equal((await fetch(url, { method: 'POST' })).status, 200);
  assert.equal((await fetch(url, { method: 'POST', body: binary })).status, 200);
  const saved = await records(logFile);
  assert.equal(saved[0].body, '');
  assert.equal(saved[0].receivedBytes, 0);
  assert.equal(saved[1].bodyEncoding, 'base64');
  assert.deepEqual(Buffer.from(saved[1].body, 'base64'), binary);
});

test('chunked request bodies are received completely', async (t) => {
  const { url, logFile } = await setup(t);
  const status = await new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'POST' }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.write('first-');
    request.end('second');
  });
  assert.equal(status, 200);
  assert.equal((await records(logFile))[0].body, 'first-second');
});

test('body limit accepts boundary and rejects larger bodies without logging them', async (t) => {
  const { url, logFile } = await setup(t, { maxBodyBytes: 4 });
  assert.equal((await fetch(url, { method: 'POST', body: '1234' })).status, 200);
  const response = await fetch(url, { method: 'POST', body: '12345' });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).maxBodyBytes, 4);
  assert.equal((await records(logFile)).length, 1);
});

test('health checks and unsupported methods do not create log records', async (t) => {
  const { url, logFile } = await setup(t);
  for (const path of ['/health', '/health?probe=1']) {
    const health = await fetch(`${url}${path}`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
  }
  for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) {
    const response = await fetch(`${url}/save`, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, POST');
  }
  await assert.rejects(readFile(logFile), { code: 'ENOENT' });
});

test('concurrent POSTs produce separate complete log records', async (t) => {
  const { url, logFile } = await setup(t);
  const bodies = Array.from({ length: 12 }, (_, index) => `${index}:${'x'.repeat(8192)}`);
  const responses = await Promise.all(bodies.map((body) => fetch(url, { method: 'POST', body })));
  assert.ok(responses.every((response) => response.status === 200));
  const saved = await records(logFile);
  assert.equal(new Set(saved.map((record) => record.id)).size, bodies.length);
  assert.deepEqual(saved.map((record) => record.body).sort(), bodies.sort());
});

test('failed persistence returns 500 and later requests can recover', async (t) => {
  const { url, directory, logFile } = await setup(t);
  const blockedDirectory = join(directory, 'logs');
  await writeFile(blockedDirectory, 'blocks directory creation');
  assert.equal((await fetch(url, { method: 'POST', body: 'first' })).status, 500);
  const failedGet = await fetch(`${url}/save?message=first`);
  assert.equal(failedGet.status, 500);
  assert.equal(failedGet.headers.get('cache-control'), 'no-store');
  await rm(blockedDirectory);
  assert.equal((await fetch(`${url}/save?message=second`)).status, 200);
  assert.equal((await fetch(url, { method: 'POST', body: 'second' })).status, 200);
  const saved = await records(logFile);
  assert.equal(saved.length, 2);
  assert.equal(saved[0].method, 'GET');
  assert.deepEqual(saved[0].query, { message: 'second' });
  assert.equal(saved[1].method, 'POST');
  assert.equal(saved[1].body, 'second');
});
