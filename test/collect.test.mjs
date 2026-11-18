import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeZip } from '../provider/zip.mjs';
import { createRangeServer, assertNoFullReassembly } from './helpers/range-server.mjs';
import { Archive } from '../src/archive.mjs';
import { collectAuthorized, loadJob } from '../src/collect.mjs';
import { VersionConflictError } from '../src/remote.mjs';

function standardZip() {
  return makeZip([
    ['other/private.bin', Buffer.alloc(200000, 7)],
    ['allowed/a.csv', 'id,value\nA,1\n', 8, true],
    ['allowed/b.csv', 'id,value\nB,5\n', 0],
    ['same.csv', 'first'],
    ['same.csv', 'second'],
  ]);
}

async function withArchive(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'collect-'));
  try { await fn(directory, new Archive(directory)); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

async function withServer(initial, options, fn) {
  const server = await createRangeServer(initial, options);
  try { return await fn(server); } finally { await server.close(); }
}

const AUTHORIZED = [{ name: 'allowed/a.csv' }, { name: 'allowed/b.csv' }, { name: 'same.csv' }];
const delivery = { id: 'delivery-receipt', digest: 'a'.repeat(64), edition: 1 };

test('授权成员按中央目录取得并通过 CRC 与解压大小校验', async () => {
  const bytes = standardZip();
  await withServer(bytes, {}, async server => {
    await withArchive(async (directory, archive) => {
      const jobPath = join(directory, 'jobs', 'job.json');
      const job = await collectAuthorized({
        url: server.base + '/all.zip', authorized: AUTHORIZED, archive,
        deliveryReceipt: delivery, jobPath,
      });
      assert.equal(job.finished, true);
      assert.equal(job.etag, '"v1"');
      assert.deepEqual(job.summary, { obtained: 2, ambiguous: 1, missing: 0, incomplete: 0, inconsistent: 0, unsupported: 0 });
      const byName = Object.fromEntries(job.members.map(member => [member.name, member]));
      assert.equal(byName['allowed/a.csv'].status, 'obtained');
      assert.equal(byName['allowed/b.csv'].status, 'obtained');
      assert.equal(byName['same.csv'].status, 'ambiguous');
      assert.equal(byName['same.csv'].reason, 'DUPLICATE_NAME');
      assert.deepEqual(byName['same.csv'].detail.ordinals, [3, 4]);

      // 实际内容可凭收件凭据重新打开，且与来源字节一致。
      for (const member of job.members.filter(item => item.status === 'obtained')) {
        const receipt = JSON.parse(await readFile(join(directory, 'receipts', member.receipt.id + '.json')));
        const content = await archive.read(receipt);
        const expected = member.name === 'allowed/a.csv' ? 'id,value\nA,1\n' : 'id,value\nB,5\n';
        assert.equal(content.toString('utf8'), expected);
        assert.equal(receipt.source.member, member.name);
        assert.equal(receipt.source.etag, '"v1"');
        assert.deepEqual(receipt.source.deliveryReceipt, { id: delivery.id, digest: delivery.digest, edition: 1 });
      }
      // 授权之外的成员没有产生任何读取，更没有整包拼接。
      const { covered } = assertNoFullReassembly(server, bytes.length);
      assert.ok(covered < bytes.length);
      assert.ok(server.state.audit.length >= 4);

      const persisted = await loadJob(jobPath);
      assert.equal(persisted.id, job.id);
      assert.equal(persisted.finished, true);
    });
  });
});

test('授权名称不做前缀扩大，目录中不存在的成员标记 missing', async () => {
  const bytes = makeZip([['allowed/a.csv', 'x'], ['allowed/sub/c.csv', 'y']]);
  await withServer(bytes, {}, async server => {
    await withArchive(async (directory, archive) => {
      const job = await collectAuthorized({
        url: server.base + '/all.zip',
        authorized: [{ name: 'allowed' }, { name: 'allowed/sub/c.csv' }],
        archive, deliveryReceipt: delivery,
      });
      assert.equal(job.members.find(member => member.name === 'allowed').status, 'missing');
      assert.equal(job.members.find(member => member.name === 'allowed/sub/c.csv').status, 'obtained');
      assert.equal(job.summary.missing, 1);
    });
  });
});

test('中央目录与局部头冲突时停止该成员读取并标记 inconsistent', async () => {
  const bytes = standardZip();
  const corrupted = Buffer.from(bytes);
  // 找到 allowed/b.csv（ordinal 2）的局部头并篡改压缩方式。
  const nameAt = corrupted.indexOf(Buffer.from('allowed/b.csv'));
  const localAt = nameAt - 30;
  assert.equal(corrupted.readUInt32LE(localAt), 0x04034b50);
  corrupted.writeUInt16LE(8, localAt + 8);
  await withServer(corrupted, {}, async server => {
    await withArchive(async (directory, archive) => {
      const job = await collectAuthorized({
        url: server.base + '/all.zip',
        authorized: [{ name: 'allowed/b.csv' }],
        archive, deliveryReceipt: delivery,
      });
      const member = job.members[0];
      assert.equal(member.status, 'inconsistent');
      assert.deepEqual(member.detail.conflicts, ['METHOD_MISMATCH']);
      assert.equal(job.summary.obtained, 0);
    });
  });
});

test('内容 CRC 不符时标记 inconsistent 且不保存内容', async () => {
  const bytes = standardZip();
  const corrupted = Buffer.from(bytes);
  // b.csv 是 Stored，直接破坏其数据字节，局部头与中央目录仍保持一致。
  const dataAt = corrupted.indexOf(Buffer.from('id,value\nB,5\n'));
  assert.ok(dataAt > 0);
  corrupted[dataAt] = 'X'.charCodeAt(0);
  await withServer(corrupted, {}, async server => {
    await withArchive(async (directory, archive) => {
      const job = await collectAuthorized({
        url: server.base + '/all.zip',
        authorized: [{ name: 'allowed/b.csv' }],
        archive, deliveryReceipt: delivery,
      });
      assert.equal(job.members[0].status, 'inconsistent');
      assert.deepEqual(job.members[0].detail.conflicts, ['CRC32_MISMATCH']);
      assert.equal((await archive.list()).length, 0);
    });
  });
});

test('ZIP64 结束目录与数据描述符成员可正常领取', async () => {
  const bytes = makeZip([['allowed/a.csv', 'id,value\nA,1\n', 8, true], ['skip.bin', Buffer.alloc(50, 9)]], true);
  await withServer(bytes, {}, async server => {
    await withArchive(async (directory, archive) => {
      const job = await collectAuthorized({
        url: server.base + '/all.zip',
        authorized: [{ name: 'allowed/a.csv' }],
        archive, deliveryReceipt: delivery,
      });
      assert.equal(job.discovery.zip64, true);
      assert.equal(job.members[0].status, 'obtained');
      assert.equal(job.members[0].ordinal, 0);
    });
  });
});

test('大目录与长 EOCD 注释下仍只读取允许的末尾片段', async () => {
  const many = Array.from({ length: 400 }, (_, index) => [`dir/member-${index}.txt`, `内容${index}`]);
  const base = makeZip(many);
  const eocdOffset = base.length - 22;
  const comment = Buffer.from('承办方备注'.repeat(2000));
  assert.ok(comment.length <= 65535);
  const bytes = Buffer.concat([
    base.subarray(0, eocdOffset),
    base.subarray(eocdOffset, eocdOffset + 20),
    Buffer.from([comment.length & 0xff, (comment.length >> 8) & 0xff]),
    comment,
  ]);
  await withServer(bytes, {}, async server => {
    await withArchive(async (directory, archive) => {
      const target = 'dir/member-257.txt';
      const job = await collectAuthorized({
        url: server.base + '/all.zip',
        authorized: [{ name: target }],
        archive, deliveryReceipt: delivery,
      });
      assert.equal(job.members[0].status, 'obtained');
      // 末尾请求恰好覆盖合同允许的 65557 字节。
      const tailStart = Math.max(0, bytes.length - 65557);
      const tailRequests = server.state.audit
        .filter(item => item.range?.endsWith(`-${bytes.length - 1}`))
        .map(item => Number(item.range.slice(6).split('-')[0]));
      assert.ok(tailRequests.includes(tailStart));
      // 即便小压缩包的末尾片段覆盖较大，合并范围仍不得覆盖整包。
      assertNoFullReassembly(server, bytes.length);
    });
  });
});

test('恢复作业先确认旧偏移版本；已取得成员不重复领取', async () => {
  const bytes = standardZip();
  await withServer(bytes, {}, async server => {
    await withArchive(async (directory, archive) => {
      const jobPath = join(directory, 'jobs', 'job.json');
      const first = await collectAuthorized({
        url: server.base + '/all.zip',
        authorized: [{ name: 'allowed/a.csv' }, { name: 'allowed/b.csv' }],
        archive, deliveryReceipt: delivery, jobPath,
      });
      assert.equal(first.summary.obtained, 2);
      const requestsAfterFirst = server.state.requests;
      const stored = await loadJob(jobPath);
      const resumed = await collectAuthorized({
        url: server.base + '/all.zip',
        authorized: [{ name: 'allowed/a.csv' }, { name: 'allowed/b.csv' }],
        archive, deliveryReceipt: delivery, jobPath, existingJob: stored,
      });
      assert.equal(resumed.finished, true);
      // 恢复只做一次版本探测，不会重新发现目录或重取成员数据。
      assert.equal(server.state.requests, requestsAfterFirst + 1);
      assert.equal(server.state.audit.at(-1).ifMatch, '"v1"');
    });
  });
});

test('恢复时资料包已换版则报版本冲突，旧偏移不再使用', async () => {
  const bytes = standardZip();
  const replacement = makeZip([['allowed/a.csv', 'id,value\nA,2\n', 8, true]]);
  await withServer(bytes, {}, async server => {
    await withArchive(async (directory, archive) => {
      const jobPath = join(directory, 'jobs', 'job.json');
      const stored = await collectAuthorized({
        url: server.base + '/all.zip',
        authorized: [{ name: 'allowed/a.csv' }],
        archive, deliveryReceipt: delivery, jobPath,
      });
      server.swap(replacement, '"v2"');
      await assert.rejects(() => collectAuthorized({
        url: server.base + '/all.zip',
        authorized: [{ name: 'allowed/a.csv' }],
        archive, deliveryReceipt: delivery, jobPath, existingJob: stored,
      }), error => error instanceof VersionConflictError && error.expected === '"v1"' && error.actual === '"v2"');
      // 冲突后没有再发起任何数据范围请求。
      assert.ok(server.state.audit.at(-1).ifMatch === '"v1"');
    });
  });
});

test('领取途中换版会中断作业并保留未完成状态', async () => {
  const bytes = standardZip();
  const replacement = makeZip([
    ['allowed/a.csv', 'changed', 8, true],
    ['allowed/b.csv', 'id,value\nB,5\n', 0],
    ['same.csv', 'first'],
    ['same.csv', 'second'],
  ]);
  await withServer(bytes, { swapAt: 5 }, async server => {
    server.swap(replacement, '"v2"');
    await withArchive(async (directory, archive) => {
      const jobPath = join(directory, 'jobs', 'job.json');
      await assert.rejects(() => collectAuthorized({
        url: server.base + '/all.zip', authorized: AUTHORIZED,
        archive, deliveryReceipt: delivery, jobPath,
      }), VersionConflictError);
      const persisted = await loadJob(jobPath);
      assert.equal(persisted.finished, false);
      assert.ok(persisted.members.length < AUTHORIZED.length);
    });
  });
});

test('发现阶段换版允许以新版本重新发现并完成领取', async () => {
  const gen1 = makeZip([['allowed/a.csv', 'old', 0]]);
  const gen2 = makeZip([['allowed/a.csv', 'new-content', 8, true]]);
  await withServer(gen1, { swapAt: 2 }, async server => {
    server.swap(gen2, '"v2"');
    await withArchive(async (directory, archive) => {
      const job = await collectAuthorized({
        url: server.base + '/all.zip',
        authorized: [{ name: 'allowed/a.csv' }],
        archive, deliveryReceipt: delivery,
      });
      assert.equal(job.etag, '"v2"');
      assert.equal(job.attempts, 2);
      assert.equal(job.members[0].status, 'obtained');
      const receipt = (await archive.list()).find(item => item.source.member === 'allowed/a.csv');
      assert.equal((await archive.read(receipt)).toString('utf8'), 'new-content');
    });
  });
});

test('读取预算被超过时拒绝继续，防止拼回整包', async () => {
  const bytes = standardZip();
  await withServer(bytes, {}, async server => {
    await withArchive(async (directory, archive) => {
      await assert.rejects(() => collectAuthorized({
        url: server.base + '/all.zip',
        authorized: [{ name: 'other/private.bin' }],
        archive, deliveryReceipt: delivery,
        readerOptions: { maxMemberBytes: 1024 },
      }), /成员读取预算/);
      // 未保存任何成员内容。
      assert.equal((await archive.list()).length, 0);
    });
  });
});

test('数据描述符与中央目录不符时标记 inconsistent', async () => {
  const bytes = standardZip();
  const corrupted = Buffer.from(bytes);
  // a.csv 使用数据描述符，定位其描述符签名并破坏 CRC 字段。
  const descriptorSig = Buffer.from([0x50, 0x4b, 0x07, 0x08]);
  const sigAt = corrupted.indexOf(descriptorSig);
  assert.ok(sigAt > 0, '测试资料包应包含数据描述符');
  corrupted.writeUInt32LE(0xdeadbeef, sigAt + 4);
  await withServer(corrupted, {}, async server => {
    await withArchive(async (directory, archive) => {
      const job = await collectAuthorized({
        url: server.base + '/all.zip',
        authorized: [{ name: 'allowed/a.csv' }],
        archive, deliveryReceipt: delivery,
      });
      assert.equal(job.members[0].status, 'inconsistent');
      assert.deepEqual(job.members[0].detail.conflicts, ['DESCRIPTOR_MISMATCH']);
      assert.equal((await archive.list()).length, 0);
    });
  });
});

test('零长度成员可被领取并通过校验', async () => {
  const bytes = makeZip([['empty.txt', ''], ['allowed/a.csv', 'data', 0]]);
  await withServer(bytes, {}, async server => {
    await withArchive(async (directory, archive) => {
      const job = await collectAuthorized({
        url: server.base + '/all.zip',
        authorized: [{ name: 'empty.txt' }],
        archive, deliveryReceipt: delivery,
      });
      assert.equal(job.members[0].status, 'obtained');
      const receipt = (await archive.list())[0];
      assert.equal((await archive.read(receipt)).length, 0);
    });
  });
});

test('未完成作业的恢复先做版本探测，换版后不得沿用旧偏移', async () => {
  const bytes = standardZip();
  const replacement = makeZip([
    ['allowed/a.csv', 'changed', 8, true],
    ['allowed/b.csv', 'id,value\nB,5\n', 0],
    ['same.csv', 'first'],
    ['same.csv', 'second'],
  ]);
  await withServer(bytes, { swapAt: 5 }, async server => {
    server.swap(replacement, '"v2"');
    await withArchive(async (directory, archive) => {
      const jobPath = join(directory, 'jobs', 'job.json');
      await assert.rejects(() => collectAuthorized({
        url: server.base + '/all.zip', authorized: AUTHORIZED,
        archive, deliveryReceipt: delivery, jobPath,
      }), VersionConflictError);
      const interrupted = await loadJob(jobPath);
      assert.equal(interrupted.finished, false);
      // 资料包已处于 v2，携带 v1 凭据的恢复必须在探测阶段失败。
      await assert.rejects(() => collectAuthorized({
        url: server.base + '/all.zip', authorized: AUTHORIZED,
        archive, deliveryReceipt: delivery, jobPath, existingJob: interrupted,
      }), error => error instanceof VersionConflictError && error.expected === '"v1"' && error.actual === '"v2"');
    });
  });
});
