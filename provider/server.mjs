import { createServer } from 'node:http';
import { once } from 'node:events';
import { routes, initialState, stop } from './routes.mjs';

export function json(value, status = 200, headers = {}) {
  return { body: Buffer.from(JSON.stringify(value)), status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } };
}

export function text(value, status = 200, headers = {}) {
  return { body: Buffer.from(value), status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers } };
}

export function binary(body, type, headers = {}, status = 200) {
  return { body: Buffer.from(body), status, headers: { 'content-type': type, ...headers } };
}

export async function createProvider(port = 0) {
  const state = structuredClone(initialState);
  const audit = [];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const pieces = [];
      let size = 0;
      for await (const piece of request) {
        size += piece.length;
        if (size > 1024 * 1024) { response.writeHead(413).end(); return; }
        pieces.push(piece);
      }
      const body = Buffer.concat(pieces);
      let payload = null;
      if (body.length && request.headers['content-type']?.includes('application/json')) payload = JSON.parse(body);
      audit.push({ method: request.method, path: url.pathname, query: url.search, size: body.length });
      let result;
      if (url.pathname === '/_health') result = json({ service: 'local-source', generation: state.generation });
      else if (url.pathname === '/_audit') result = json(audit);
      else if (url.pathname === '/_control' && request.method === 'POST') {
        for (const key of ['generation', 'mode', 'clock']) if (payload[key] !== undefined) state[key] = payload[key];
        result = json({ generation: state.generation, mode: state.mode, clock: state.clock });
      } else result = await routes({ request, url, body, payload, state, json, text, binary });
      result ??= json({ error: '资料不存在' }, 404);
      response.writeHead(result.status ?? 200, { 'cache-control': 'no-store', ...result.headers });
      response.end(result.body);
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, state, audit, close: async () => { await stop(state); return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  }); } };
}
