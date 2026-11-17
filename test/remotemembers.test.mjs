import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProvider } from '../provider/server.mjs';
import { receiveAuthorized } from '../src/domain.mjs';
import { collectMembers } from '../src/remotemembers.mjs';
import { Archive } from '../src/archive.mjs';
import { makeZip } from '../provider/zip.mjs';

async function controlled(provider, change) {
  const response = await fetch(provider.base + '/_control', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(change),
  });
  assert.equal(response.status, 200);
}

async function withDirectory(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'members-'));
  try { return await fn(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

// 内存假来源：只认单范围请求，可记录每次范围并随时换版
function fakeSource(zipBytes, { etag = '"v1"' } = {}) {
  const log = [];
  const fetchImpl = async (url, options = {}) => {
    const range = options.headers?.range ?? '';
    log.push(range);
    const currentEtag = typeof etag === 'function' ? etag() : etag;
    if (options.headers?.['if-match'] && options.headers['if-match'] !== currentEtag)
      return new Response('{}', { status: 412, headers: { 'content-type': 'application/json' } });
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) return new Response(zipBytes, { status: 200, headers: { etag: currentEtag } });
    const start = match[1] ? Number(match[1]) : Math.max(0, zipBytes.length - Number(match[2]));
    const end = match[1] ? (match[2] ? Math.min(Number(match[2]), zipBytes.length - 1) : zipBytes.length - 1) : zipBytes.length - 1;
    if (start > end || start >= zipBytes.length) return new Response('{}', { status: 416 });
    return new Response(zipBytes.subarray(start, end + 1), {
      status: 206,
      headers: { etag: currentEtag, 'content-range': `bytes ${start}-${end}/${zipBytes.length}` },
    });
  };
  return { fetchImpl, log };
}

test('授权成员按目录取得并校验内容，同名成员保持歧义', async () => {
  const provider = await createProvider();
  try {
    await withDirectory(async directory => {
      const result = await receiveAuthorized(provider.base, directory);
      assert.equal(result.status, 'partial'); // same.csv 存在同名歧义
      assert.equal(result.version, '"delivery-1"');
      assert.deepEqual(result.obtained.map(item => item.name).sort(), ['allowed/a.csv', 'allowed/b.csv']);
      assert.deepEqual(result.ambiguous.map(item => item.name), ['same.csv']);
      assert.equal(result.ambiguous[0].candidates.length, 2);
      assert.deepEqual(result.missing, []);
      assert.deepEqual(result.failed, []);
      assert.deepEqual(result.pending, []);

      const archive = new Archive(directory);
      const receipts = new Map((await archive.list()).map(receipt => [receipt.id, receipt]));
      const contentOf = async name => {
        const item = result.obtained.find(entry => entry.name === name);
        return archive.read(receipts.get(item.receipt));
      };
      assert.equal((await contentOf('allowed/a.csv')).toString(), 'id,value\nA,1\n');
      assert.equal((await contentOf('allowed/b.csv')).toString(), 'id,value\nB,5\n');

      // 成员、压缩包版本、授权清单的对应关系落在凭据上
      const aItem = result.obtained.find(item => item.name === 'allowed/a.csv');
      const aReceipt = receipts.get(aItem.receipt);
      assert.equal(aReceipt.source.kind, 'zip-member');
      assert.equal(aReceipt.source.member, 'allowed/a.csv');
      assert.equal(aReceipt.source.etag, '"delivery-1"');
      assert.equal(aReceipt.source.deliveryReceipt, result.delivery);
      assert.equal(aReceipt.source.edition, 1);
      assert.ok(result.manifest);
      const manifest = JSON.parse((await archive.read(receipts.get(result.manifest))).toString());
      assert.equal(manifest.kind, 'collection-manifest');
      assert.equal(manifest.deliveryReceipt, result.delivery);
      assert.deepEqual(manifest.authorized, ['allowed/a.csv', 'allowed/b.csv', 'same.csv']);

      // 同名歧义成员没有任何凭据
      assert.ok(![...receipts.values()].some(receipt => receipt.source.member === 'same.csv'));
      // 未触碰未授权成员：传输量不足以覆盖 200000 字节的 private.bin
      assert.ok(provider.state.transferred < 200000, `transferred=${provider.state.transferred}`);
    });
  } finally { await provider.close(); }
});

test('ZIP64 结束目录下领取结果一致', async () => {
  const provider = await createProvider();
  try {
    await controlled(provider, { mode: 'zip64' });
    await withDirectory(async directory => {
      const result = await receiveAuthorized(provider.base, directory);
      assert.equal(result.directory.zip64, true);
      assert.deepEqual(result.obtained.map(item => item.name).sort(), ['allowed/a.csv', 'allowed/b.csv']);
      const archive = new Archive(directory);
      const receipts = new Map((await archive.list()).map(receipt => [receipt.id, receipt]));
      const item = result.obtained.find(entry => entry.name === 'allowed/a.csv');
      assert.equal((await archive.read(receipts.get(item.receipt))).toString(), 'id,value\nA,1\n');
    });
  } finally { await provider.close(); }
});

test('领取期间整包被替换：旧偏移作废并在新版本上完成', async () => {
  const provider = await createProvider();
  try {
    await withDirectory(async directory => {
      let flipped = false;
      let zipRequests = 0;
      const fetchImpl = async (url, options) => {
        if (new URL(url).pathname === '/all.zip') {
          zipRequests += 1;
          if (zipRequests === 2 && !flipped) {
            flipped = true;
            await controlled(provider, { generation: 2 });
          }
        }
        return fetch(url, options);
      };
      const result = await receiveAuthorized(provider.base, directory, { fetchImpl });
      assert.equal(result.version, '"delivery-2"');
      assert.ok(result.versionChanges >= 1);
      assert.deepEqual(result.obtained.map(item => item.name).sort(), ['allowed/a.csv', 'allowed/b.csv']);
      const archive = new Archive(directory);
      const receipts = new Map((await archive.list()).map(receipt => [receipt.id, receipt]));
      const item = result.obtained.find(entry => entry.name === 'allowed/a.csv');
      assert.equal((await archive.read(receipts.get(item.receipt))).toString(), 'id,value\nA,2\n');
      assert.equal(receipts.get(item.receipt).source.etag, '"delivery-2"');
    });
  } finally { await provider.close(); }
});

test('中断后续领先确认旧偏移仍适用，再补未完成成员', async () => {
  const provider = await createProvider();
  try {
    await withDirectory(async directory => {
      let zipRequests = 0;
      const flaky = async (url, options) => {
        if (new URL(url).pathname === '/all.zip') {
          zipRequests += 1;
          if (zipRequests === 5) throw new Error('网络中断');
        }
        return fetch(url, options);
      };
      const first = await receiveAuthorized(provider.base, directory, { fetchImpl: flaky });
      assert.equal(first.status, 'incomplete');
      assert.deepEqual(first.obtained.map(item => item.name), ['allowed/a.csv']);
      assert.deepEqual(first.pending, ['allowed/b.csv']);

      let resumedRequests = 0;
      const counting = async (url, options) => {
        if (new URL(url).pathname === '/all.zip') resumedRequests += 1;
        return fetch(url, options);
      };
      const resumed = await receiveAuthorized(provider.base, directory, { fetchImpl: counting });
      assert.equal(resumed.status, 'partial'); // same.csv 歧义仍在
      assert.deepEqual(resumed.obtained.map(item => item.name).sort(), ['allowed/a.csv', 'allowed/b.csv']);
      assert.equal(resumed.obtained.find(item => item.name === 'allowed/a.csv').reused, true);
      assert.equal(resumed.obtained.find(item => item.name === 'allowed/b.csv').reused, false);
      // 末尾确认 + b.csv 局部头/名称/数据，共 4 次范围请求，不重取已得成员
      assert.equal(resumedRequests, 4);
      const archive = new Archive(directory);
      const receipts = new Map((await archive.list()).map(receipt => [receipt.id, receipt]));
      const b = resumed.obtained.find(item => item.name === 'allowed/b.csv');
      assert.equal((await archive.read(receipts.get(b.receipt))).toString(), 'id,value\nB,5\n');
    });
  } finally { await provider.close(); }
});

test('目录与局部头冲突的成员不碰运气读数据', async () => {
  const good = makeZip([['x.csv', 'hello', 0], ['y.csv', 'world', 0]]);
  const corrupted = Buffer.from(good);
  corrupted.writeUInt16LE(8, 8); // 第一个局部头压缩方式改为 8，中央目录仍是 0
  const { fetchImpl, log } = fakeSource(corrupted);
  await withDirectory(async directory => {
    const report = await collectMembers({
      url: 'http://fake/all.zip', authorized: ['x.csv', 'y.csv'], directory, fetchImpl,
    });
    assert.equal(report.status, 'partial');
    assert.deepEqual(report.failed.map(item => item.name), ['x.csv']);
    assert.match(report.failed[0].reason, /不一致/);
    assert.deepEqual(report.obtained.map(item => item.name), ['y.csv']);
    // 末尾 + x 头 + x 名称 + y 头 + y 名称 + y 数据：x 的数据范围从未被请求
    assert.equal(log.length, 6);
    const archive = new Archive(directory);
    const receipts = new Map((await archive.list()).map(receipt => [receipt.id, receipt]));
    const y = report.obtained[0];
    assert.equal((await archive.read(receipts.get(y.receipt))).toString(), 'world');
  });
});

test('来源忽略范围返回整包时被拒绝', async () => {
  const zip = makeZip([['x.csv', 'hello', 0]]);
  const fetchImpl = async () => new Response(zip, { status: 200, headers: { etag: '"v1"' } });
  await withDirectory(async directory => {
    const report = await collectMembers({
      url: 'http://fake/all.zip', authorized: ['x.csv'], directory, fetchImpl,
    });
    assert.equal(report.status, 'aborted');
    assert.match(report.error, /整包/);
    assert.deepEqual(report.obtained, []);
    assert.deepEqual(report.pending, ['x.csv']);
  });
});

test('版本持续不稳定时明确报告未完成', async () => {
  const zip = makeZip([['x.csv', 'hello', 0], ['y.csv', 'world', 0]]);
  let generation = 0;
  const { fetchImpl } = fakeSource(zip, { etag: () => `"v${(generation += 1)}"` });
  await withDirectory(async directory => {
    const report = await collectMembers({
      url: 'http://fake/all.zip', authorized: ['x.csv', 'y.csv'], directory, fetchImpl,
    });
    assert.equal(report.status, 'version-unstable');
    assert.deepEqual(report.obtained, []);
    assert.deepEqual(report.pending.sort(), ['x.csv', 'y.csv']);
  });
});

test('未出现在目录中的授权成员记为缺失', async () => {
  const zip = makeZip([['x.csv', 'hello', 0]]);
  const { fetchImpl } = fakeSource(zip);
  await withDirectory(async directory => {
    const report = await collectMembers({
      url: 'http://fake/all.zip', authorized: ['x.csv', 'absent.csv'], directory, fetchImpl,
    });
    assert.equal(report.status, 'partial');
    assert.deepEqual(report.missing, ['absent.csv']);
    assert.deepEqual(report.obtained.map(item => item.name), ['x.csv']);
  });
});
