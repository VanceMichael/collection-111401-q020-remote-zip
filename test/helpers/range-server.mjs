// 测试辅助：在内存中持有合成 ZIP 字节，只接受单一字节范围，
// 行为与 provider 的资料接口一致，并可在请求之间换版或注入损坏。
import { createServer } from 'node:http';
import { once } from 'node:events';

export async function createRangeServer(initial, options = {}) {
  const state = {
    bytes: initial,
    etag: options.etag ?? '"v1"',
    transferred: 0,
    requests: 0,
    swapAt: options.swapAt ?? null,
    swapped: null,
    audit: [],
  };
  const server = createServer((request, response) => {
    try {
      state.requests += 1;
      state.audit.push({ method: request.method, range: request.headers.range ?? null, ifMatch: request.headers['if-match'] ?? null });
      if (state.swapAt && state.requests === state.swapAt && state.swapped) {
        state.bytes = state.swapped.bytes;
        state.etag = state.swapped.etag;
      }
      if (request.headers['if-match'] && request.headers['if-match'] !== state.etag) {
        response.writeHead(412, { 'content-type': 'application/json', etag: state.etag });
        response.end(JSON.stringify({ error: '对象已经换版' }));
        return;
      }
      const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
      if (!match) {
        response.writeHead(403, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: '禁止整包领取' }));
        return;
      }
      const start = Number(match[1]);
      const end = Number(match[2]);
      if (start > end || start >= state.bytes.length) {
        response.writeHead(416, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: '范围超出对象' }));
        return;
      }
      const safeEnd = Math.min(end, state.bytes.length - 1);
      const body = state.bytes.subarray(start, safeEnd + 1);
      state.transferred += body.length;
      response.writeHead(206, {
        'content-type': 'application/zip',
        etag: state.etag,
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${safeEnd}/${state.bytes.length}`,
      });
      response.end(body);
    } catch (error) {
      response.writeHead(400).end(error.message);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    state,
    swap(bytes, etag) {
      if (state.swapAt) {
        state.swapped = { bytes, etag };
      } else {
        state.bytes = bytes;
        state.etag = etag;
      }
    },
    mutate(fn) { fn(state.bytes); },
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

export function entryNames(entries) {
  return entries.map(entry => ({ name: entry }));
}

// 反拼包核对：所有请求必须是单一范围，合并后的覆盖范围不得覆盖整包。
export function assertNoFullReassembly(server, totalSize) {
  const audits = server.state.audit;
  if (!audits.every(item => item.range)) throw new Error('存在无 Range 的整对象请求');
  const ranges = audits
    .map(item => item.range.slice(6).split('-').map(Number))
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of ranges) {
    const last = merged.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  const covered = merged.reduce((sum, [start, end]) => sum + end - start + 1, 0);
  if (covered >= totalSize) throw new Error(`范围请求合并后覆盖了整包（${covered}/${totalSize}）`);
  return { covered, ranges: merged };
}
