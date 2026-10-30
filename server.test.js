import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPostServer } from './server.js';

async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'post-server-'));
  const logDirectory = join(directory, 'logs');
  const messages = [];
  const server = createPostServer({
    logDirectory,
    logger: { log(message) { messages.push(message); }, error(message) { messages.push(message); } },
    ...options,
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await server.flushLogs();
    await rm(directory, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  await server.flushLogs();
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    logFile: server.logPaths.POST,
    getLogFile: server.logPaths.GET,
    serviceLogFile: server.logPaths.service,
    logDirectory, directory, messages, server,
  };
}

async function records(logFile) {
  const text = await readFile(logFile, 'utf8');
  return text.split(/^={72}\n/m).filter((block) => block.trim()).map((block) => {
    const field = (label) => block.split(`${label}: `)[1].split('\n')[0];
    const section = (label, nextLabel) => {
      const content = block.split(`${label}:\n`)[1];
      return (nextLabel ? content.split(`\n${nextLabel}:\n`)[0] : content.trimEnd())
        .split('\n').map((line) => line.slice(2)).join('\n');
    };
    const firstLine = block.split('\n')[0];
    const receivedBytes = Number(field('Размер тела').split(' ')[0]);
    let body = receivedBytes === 0 ? '' : section('Тело', 'Заголовки');
    // Integration assertions compare JSON values independently of display indentation.
    if (field('Кодировка тела') === 'utf8' && body) {
      try { body = JSON.stringify(JSON.parse(body)); } catch { /* Plain text. */ }
    }
    return {
      method: firstLine.slice(0, firstLine.indexOf(' ')),
      url: firstLine.slice(firstLine.indexOf(' ') + 1),
      id: field('ID'), receivedAt: field('Время (UTC)'),
      clientIp: field('IP отправителя'), peerIp: field('IP соединения'),
      receivedBytes, bodyEncoding: field('Кодировка тела'), body,
      query: JSON.parse(section('Параметры URL', 'Тело')),
      headers: JSON.parse(section('Заголовки')),
    };
  });
}

test('request files are readable as plain text with formatted JSON and separated blocks', async (t) => {
  const { url, logFile, getLogFile } = await setup(t);
  assert.ok(logFile.endsWith('post.log'));
  assert.ok(getLogFile.endsWith('get.log'));
  const body = '{"message":"Привет","nested":{"id":123}}';
  assert.equal((await fetch(url, { method: 'POST', body })).status, 200);
  assert.equal((await fetch(`${url}/save?message=hello&id=123`)).status, 200);
  const postText = await readFile(logFile, 'utf8');
  assert.match(postText, /^={72}\nPOST \/\nВремя \(UTC\): /);
  assert.ok(postText.includes('Тело:\n  {\n    "message": "Привет",\n    "nested": {\n      "id": 123\n    }\n  }\nЗаголовки:'));
  const getText = await readFile(getLogFile, 'utf8');
  assert.ok(getText.includes('Параметры URL:\n  {\n    "message": "hello",\n    "id": "123"\n  }'));
  assert.ok(getText.includes('Тело:\n  (пусто)\n'));
});

test('formatting retains large numbers and duplicate JSON keys, and escapes terminal controls', async (t) => {
  const { url, logFile } = await setup(t);
  const exactJson = '{"n":9007199254740993,"x":1,"x":2}';
  const textBody = 'first\nsecond\u001b[31m';
  assert.equal((await fetch(url, { method: 'POST', body: exactJson })).status, 200);
  assert.equal((await fetch(url, { method: 'POST', body: textBody })).status, 200);
  const saved = await readFile(logFile, 'utf8');
  assert.ok(saved.includes(exactJson));
  assert.ok(saved.includes('  first\n  second\\u001b[31m'));
  assert.ok(!saved.includes('\u001b'));
  assert.equal(saved.match(/^={72}$/gm).length, 2);
});

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
  const { url, getLogFile: logFile } = await setup(t);
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
  const { url, getLogFile: logFile } = await setup(t);
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
  const { url, getLogFile: logFile } = await setup(t);
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
    const { url, getLogFile: logFile } = await setup(t, { trustProxy });
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
  const { url, logFile, getLogFile } = await setup(t);
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
  await assert.rejects(readFile(getLogFile), { code: 'ENOENT' });
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

test('GET, POST and service logs stay separate under concurrent traffic; legacy log is preserved', async (t) => {
  const { url, logFile, getLogFile, serviceLogFile, logDirectory, messages, server } = await setup(t);
  const legacy = join(logDirectory, 'requests.jsonl');
  await writeFile(legacy, 'existing history\n');
  const requests = Array.from({ length: 16 }, (_, index) => index % 2
    ? fetch(url, { method: 'POST', body: `private-post-${index}` })
    : fetch(`${url}/save?message=private-get-${index}`));
  assert.ok((await Promise.all(requests)).every((response) => response.status === 200));
  await server.flushLogs();
  const gets = await records(getLogFile);
  const posts = await records(logFile);
  assert.equal(gets.length, 8);
  assert.equal(posts.length, 8);
  assert.ok(gets.every((record) => record.method === 'GET'));
  assert.ok(posts.every((record) => record.method === 'POST'));
  assert.equal(new Set([...gets, ...posts].map((record) => record.id)).size, 16);
  const service = await readFile(serviceLogFile, 'utf8');
  assert.match(service, /INFO.*Server started/);
  assert.doesNotMatch(service, /private-get|private-post/);
  assert.doesNotMatch(messages.join('\n'), /private-get|private-post/);
  assert.equal(await readFile(legacy, 'utf8'), 'existing history\n');
});

test('failed method storage returns 500, leaves the other method working and recovers', async (t) => {
  const { url, logFile, getLogFile, serviceLogFile } = await setup(t);
  await mkdir(logFile);
  const failed = await fetch(url, { method: 'POST', body: 'private-failed-body' });
  assert.equal(failed.status, 500);
  assert.equal(failed.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${url}/save?message=still-working`)).status, 200);
  const service = await readFile(serviceLogFile, 'utf8');
  assert.match(service, /ERROR.*Cannot save request/);
  assert.doesNotMatch(service, /private-failed-body/);
  await rm(logFile, { recursive: true });
  assert.equal((await fetch(url, { method: 'POST', body: 'recovered' })).status, 200);
  assert.equal((await records(logFile))[0].body, 'recovered');
  assert.deepEqual((await records(getLogFile))[0].query, { message: 'still-working' });

  await rm(getLogFile);
  await mkdir(getLogFile);
  assert.equal((await fetch(`${url}/save?message=failed`)).status, 500);
  await rm(getLogFile, { recursive: true });
  assert.equal((await fetch(`${url}/save?message=recovered`)).status, 200);
  assert.deepEqual((await records(getLogFile))[0].query, { message: 'recovered' });
});

test('unavailable service log reports to stderr without losing successfully stored requests', async (t) => {
  const { url, getLogFile, serviceLogFile, messages, server } = await setup(t);
  await rm(serviceLogFile);
  await mkdir(serviceLogFile);
  assert.equal((await fetch(url, { method: 'PUT' })).status, 405);
  await server.flushLogs();
  assert.match(messages.join('\n'), /Cannot write service log/);
  assert.equal((await fetch(`${url}/save?message=works`)).status, 200);
  assert.deepEqual((await records(getLogFile))[0].query, { message: 'works' });
});
