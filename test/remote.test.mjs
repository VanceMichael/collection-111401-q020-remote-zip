import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteRangeReader, VersionConflictError } from '../src/remote.mjs';

function response({ status = 206, body = Buffer.alloc(1), headers = {}, total = 100, start = 0, end = 0 }) {
  const head = {
    'content-type': 'application/zip',
    etag: '"v1"',
    'content-range': `bytes ${start}-${end}/${total}`,
    ...headers,
  };
  return {
    status,
    headers: { get: name => head[name.toLowerCase()] ?? null },
    body: (async function* () { yield body; })(),
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

// 按请求头中的 Range 生成匹配的模拟响应。
function echoingResponse(overrides = {}) {
  return async (url, init) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(init.headers.range);
    const start = Number(match[1]);
    const end = Number(match[2]);
    return response({ start, end, body: Buffer.alloc(end - start + 1), total: 100, ...overrides });
  };
}

test('范围请求携带单一 Range 并校验 206、Content-Range 与响应体积', async () => {
  const calls = [];
  const reader = new RemoteRangeReader('http://source/all.zip', {
    fetchImpl: async (url, init) => {
      calls.push(init.headers);
      return echoingResponse({ body: Buffer.from('abc') })(url, init);
    },
  });
  const result = await reader.range(10, 12);
  assert.equal(calls[0].range, 'bytes=10-12');
  assert.equal(result.bytes.toString('utf8'), 'abc');
  assert.equal(result.total, 100);
  assert.equal(result.etag, '"v1"');
  assert.equal(reader.transferred, 3);
});

test('首个响应确定 ETag，后续响应换版则报版本冲突', async () => {
  let first = true;
  const reader = new RemoteRangeReader('http://source/all.zip', {
    fetchImpl: async (url, init) => {
      if (!first) return echoingResponse({ headers: { etag: '"v2"' } })(url, init);
      first = false;
      return echoingResponse()(url, init);
    },
  });
  await reader.range(0, 0);
  await assert.rejects(() => reader.range(1, 1), VersionConflictError);
});

test('412 响应转换为版本冲突并保留期望与实际版本', async () => {
  const reader = new RemoteRangeReader('http://source/all.zip', {
    etag: '"v1"',
    fetchImpl: async () => response({
      status: 412,
      headers: { 'content-type': 'application/json', etag: '"v9"' },
    }),
  });
  await assert.rejects(
    () => reader.range(0, 9),
    error => error instanceof VersionConflictError && error.expected === '"v1"' && error.actual === '"v9"',
  );
});

test('非 206 状态、错误的 Content-Range 与体积不符都被拒绝', async () => {
  const reader200 = new RemoteRangeReader('http://source/all.zip', {
    fetchImpl: async () => response({ status: 200 }),
  });
  await assert.rejects(() => reader200.range(0, 0), /部分内容/);

  const readerRange = new RemoteRangeReader('http://source/all.zip', {
    fetchImpl: async () => response({ start: 5, end: 5, body: Buffer.from('x') }),
  });
  await assert.rejects(() => readerRange.range(0, 0), /不一致/);

  const readerSize = new RemoteRangeReader('http://source/all.zip', {
    fetchImpl: async (url, init) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(init.headers.range);
      return response({
        start: Number(match[1]), end: Number(match[2]),
        body: Buffer.alloc(Number(match[2]) - Number(match[1]) + 2),
      });
    },
  });
  await assert.rejects(() => readerSize.range(0, 2), /体积/);
});

test('单响应与累计传输上限阻止拼回式读取', async () => {
  const small = new RemoteRangeReader('http://source/all.zip', { maxResponseBytes: 2, fetchImpl: echoingResponse() });
  await assert.rejects(() => small.range(0, 2), /单次范围/);

  const budget = new RemoteRangeReader('http://source/all.zip', { maxTotalBytes: 5, fetchImpl: echoingResponse() });
  await budget.range(0, 2);
  await assert.rejects(() => budget.range(3, 5), /累计范围读取/);
});

test('probe 使用 If-Match 验证旧版本仍然适用', async () => {
  const seen = [];
  const okReader = new RemoteRangeReader('http://source/all.zip', {
    etag: '"v1"',
    fetchImpl: async (url, init) => { seen.push(init.headers); return echoingResponse()(url, init); },
  });
  await okReader.probe();
  assert.equal(seen[0]['if-match'], '"v1"');
  assert.equal(seen[0].range, 'bytes=0-0');

  const staleReader = new RemoteRangeReader('http://source/all.zip', {
    etag: '"v1"',
    fetchImpl: async () => response({ status: 412, headers: { etag: '"v2"', 'content-type': 'application/json' } }),
  });
  await assert.rejects(() => staleReader.probe(), VersionConflictError);
});
