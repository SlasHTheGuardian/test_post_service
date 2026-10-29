import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectDirectory = dirname(fileURLToPath(import.meta.url));
const defaultLogFile = resolve(projectDirectory, 'logs', 'requests.jsonl');

function sendJson(response, status, payload, headers = {}) {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}

export function createPostServer({
  logFile = defaultLogFile,
  maxBodyBytes = 1024 * 1024,
  logger = console,
} = {}) {
  let pendingWrite = Promise.resolve();

  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      request.resume();
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    if (request.method !== 'POST') {
      request.resume();
      sendJson(response, 405, { error: 'Use POST to send data, or GET /health.' }, {
        Allow: request.url === '/health' ? 'GET, POST' : 'POST',
      });
      return;
    }

    let chunks = [];
    let receivedBytes = 0;
    let tooLarge = false;

    request.on('error', (error) => {
      chunks = [];
      logger.error(`Request interrupted: ${error.message}`);
    });

    request.on('data', (chunk) => {
      if (tooLarge) return;
      receivedBytes += chunk.length;
      if (receivedBytes > maxBodyBytes) {
        tooLarge = true;
        chunks = [];
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
      const record = {
        id: randomUUID(),
        receivedAt: new Date().toISOString(),
        clientIp: request.socket.remoteAddress,
        method: request.method,
        url: request.url,
        headers,
        receivedBytes: body.length,
        bodyEncoding: isUtf8 ? 'utf8' : 'base64',
        body: isUtf8 ? text : body.toString('base64'),
      };

      // Serialize file appends so concurrent requests cannot mix log records.
      const write = pendingWrite.catch(() => {}).then(async () => {
        await mkdir(dirname(logFile), { recursive: true });
        await appendFile(logFile, `${JSON.stringify(record)}\n`, 'utf8');
      });
      pendingWrite = write;
      try {
        await write;
      } catch (error) {
        logger.error(`Cannot save request: ${error.message}`);
        sendJson(response, 500, { error: 'Cannot save request.' });
        return;
      }

      logger.log(JSON.stringify(record));
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
  return server;
}

function start() {
  const host = process.env.HOST ?? '0.0.0.0';
  const port = Number(process.env.PORT ?? 335);
  const maxBodyBytes = Number(process.env.MAX_BODY_BYTES ?? 1024 * 1024);
  const logFile = process.env.LOG_FILE ? resolve(process.env.LOG_FILE) : defaultLogFile;

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

  const server = createPostServer({ logFile, maxBodyBytes });
  server.on('error', (error) => {
    console.error(`Cannot listen on ${host}:${port}: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(`POST server listening on ${host}:${port}`);
    console.log(`Request log: ${logFile}`);
    console.log(`Send POST to http://<server-ip>:${port}/ (any path). Stop: Ctrl+C.`);
  });

  const stop = () => {
    server.close();
    setTimeout(() => server.closeAllConnections(), 5000).unref();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  start();
}
