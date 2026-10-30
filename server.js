import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultLogDirectory = resolve(dirname(fileURLToPath(import.meta.url)), 'logs');

function resolveLogDirectory() {
  if (process.env.LOG_DIR) return resolve(process.env.LOG_DIR);
  if (process.env.LOG_FILE) return dirname(resolve(process.env.LOG_FILE));
  return defaultLogDirectory;
}

function safeText(value) {
  return String(value).replace(/\r\n/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function formatBody(body) {
  try {
    const parsed = JSON.parse(body);
    const compact = body.replace(/("(?:\\.|[^"\\])*")|\s+/g, (_match, quoted) => quoted ?? '');
    // Only format JSON when doing so preserves numbers and duplicate keys.
    if (JSON.stringify(parsed) === compact) return JSON.stringify(parsed, null, 2);
  } catch { /* Other content stays plain text. */ }
  return body;
}

function formatRequest(record) {
  const indent = (text) => safeText(text).split('\n').map((line) => `  ${line}`).join('\n');
  const body = record.body === '' ? '(пусто)'
    : record.bodyEncoding === 'base64' ? record.body : formatBody(record.body);
  return [
    '='.repeat(72),
    `${record.method} ${safeText(record.url)}`,
    `Время (UTC): ${record.receivedAt}`,
    `ID: ${record.id}`,
    `IP отправителя: ${record.clientIp}`,
    `IP соединения: ${record.peerIp}`,
    `Размер тела: ${record.receivedBytes} байт`,
    `Кодировка тела: ${record.bodyEncoding}`,
    'Параметры URL:', indent(JSON.stringify(record.query, null, 2)),
    'Тело:', indent(body),
    'Заголовки:', indent(JSON.stringify(record.headers, null, 2)),
    '', '',
  ].join('\n');
}

function createLogStore({ directory, logger }) {
  const paths = {
    GET: resolve(directory, 'get.log'),
    POST: resolve(directory, 'post.log'),
    service: resolve(directory, 'service.log'),
  };
  const pending = new Map();
  function append(file, text) {
    // Serialize each file's writes so simultaneous requests stay in separate blocks.
    const write = (pending.get(file) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, text, 'utf8');
    });
    pending.set(file, write);
    return write;
  }
  return {
    paths,
    request(record) {
      return append(paths[record.method], formatRequest(record));
    },
    async service(level, message, details = {}) {
      const suffix = Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
      const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${safeText(message)}${suffix}`;
      (level === 'error' ? logger.error : logger.log).call(logger, line);
      try {
        await append(paths.service, `${line}\n`);
      } catch (error) {
        logger.error(`Cannot write service log: ${JSON.stringify(error.message)}`);
      }
    },
    async flush() { await Promise.allSettled([...pending.values()]); },
  };
}

function sendJson(response, status, payload, headers = {}) {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(body);
}

export function createPostServer({
  logDirectory = defaultLogDirectory,
  maxBodyBytes = 1024 * 1024,
  logger = console,
  trustProxy = false,
} = {}) {
  const logs = createLogStore({ directory: logDirectory, logger });

  const server = http.createServer((request, response) => {
    let requestUrl;
    try {
      requestUrl = new URL(request.url, 'http://localhost');
    } catch {
      request.resume();
      void logs.service('warn', 'Request rejected', { status: 400, reason: 'Invalid URL' });
      sendJson(response, 400, { error: 'Invalid request URL.' });
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/health') {
      request.resume();
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    if (request.method !== 'POST' && request.method !== 'GET') {
      request.resume();
      void logs.service('warn', 'Request rejected', { status: 405, method: request.method });
      sendJson(response, 405, { error: 'Use GET or POST to send data.' }, {
        Allow: 'GET, POST',
      });
      return;
    }

    const query = Object.create(null);
    for (const [name, value] of requestUrl.searchParams) {
      if (!Object.hasOwn(query, name)) query[name] = value;
      else if (Array.isArray(query[name])) query[name].push(value);
      else query[name] = [query[name], value];
    }

    let chunks = [];
    let receivedBytes = 0;
    let tooLarge = false;

    request.on('error', (error) => {
      chunks = [];
      void logs.service('error', 'Request interrupted', { method: request.method, error: error.message });
    });

    request.on('data', (chunk) => {
      if (tooLarge) return;
      receivedBytes += chunk.length;
      if (receivedBytes > maxBodyBytes) {
        tooLarge = true;
        chunks = [];
        void logs.service('warn', 'Request rejected', { status: 413, method: request.method, maxBodyBytes });
        sendJson(response, 413, { error: 'Request body is too large.', maxBodyBytes }, {
          Connection: 'close',
        });
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', async () => {
      if (tooLarge || request.aborted) return;
      const body = Buffer.concat(chunks);
      chunks = [];
      const text = body.toString('utf8');
      const isUtf8 = Buffer.from(text, 'utf8').equals(body);
      const headers = { ...request.headers };
      for (const name of ['authorization', 'proxy-authorization', 'cookie']) {
        if (name in headers) headers[name] = '[REDACTED]';
      }
      // In Compose, only Caddy can reach this service. Caddy overwrites this
      // header with the actual peer IP; direct runs ignore it by default.
      const forwardedIp = request.headers['x-real-ip'];
      const clientIp = trustProxy && typeof forwardedIp === 'string' && isIP(forwardedIp)
        ? forwardedIp : request.socket.remoteAddress;
      const record = {
        id: randomUUID(),
        receivedAt: new Date().toISOString(),
        clientIp,
        peerIp: request.socket.remoteAddress,
        method: request.method,
        url: request.url,
        query,
        headers,
        receivedBytes: body.length,
        bodyEncoding: isUtf8 ? 'utf8' : 'base64',
        body: isUtf8 ? text : body.toString('base64'),
      };

      try {
        await logs.request(record);
      } catch (error) {
        await logs.service('error', 'Cannot save request', {
          method: request.method, requestId: record.id, error: error.message,
        });
        sendJson(response, 500, { error: 'Cannot save request.' });
        return;
      }

      sendJson(response, 200, {
        status: 'ok',
        requestId: record.id,
        receivedBytes: record.receivedBytes,
      });
    });
  });

  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.setTimeout(30_000, (socket) => socket.destroy());
  server.logPaths = logs.paths;
  server.flushLogs = () => logs.flush();
  server.on('listening', () => {
    void logs.service('info', 'Server started', { address: server.address(), logDirectory });
  });
  server.on('close', () => { void logs.service('info', 'Server stopped'); });
  server.on('error', (error) => { void logs.service('error', 'Server error', { error: error.message }); });
  return server;
}

function start() {
  const host = process.env.HOST ?? '0.0.0.0';
  const port = Number(process.env.PORT ?? 80);
  const maxBodyBytes = Number(process.env.MAX_BODY_BYTES ?? 1024 * 1024);
  const logDirectory = resolveLogDirectory();

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT must be an integer from 1 to 65535.');
    process.exitCode = 1;
    return;
  }
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    console.error('MAX_BODY_BYTES must be a positive integer.');
    process.exitCode = 1;
    return;
  }

  const server = createPostServer({ logDirectory, maxBodyBytes, trustProxy: process.env.TRUST_PROXY === 'true' });
  server.on('error', () => {
    process.exitCode = 1;
  });
  server.listen(port, host);

  const stop = () => {
    server.close(() => { void server.flushLogs(); });
    setTimeout(() => server.closeAllConnections(), 5000).unref();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  start();
}
