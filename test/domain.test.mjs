import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProvider } from '../provider/server.mjs';
import { receiveAuthorizedMembers, resumeAuthorizedMembers, VersionConflictError } from '../src/domain.mjs';
import { Archive } from '../src/archive.mjs';
import { loadJob } from '../src/collect.mjs';

async function controlled(provider, change) {
  const response = await fetch(provider.base + '/_control', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(change),
  });
  assert.equal(response.status, 200);
}

async function withTempDirectory(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'domain-'));
  try { await fn(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('业务入口完成授权成员领取并给出逐成员结论', async () => {
  const provider = await createProvider();
  try {
    await withTempDirectory(async directory => {
      const result = await receiveAuthorizedMembers(provider.base, directory);
      assert.equal(result.finished, true);
      assert.equal(result.etag, '"delivery-1"');
      assert.deepEqual(result.summary, { obtained: 2, ambiguous: 1, missing: 0, incomplete: 0, inconsistent: 0, unsupported: 0 });
      const byName = Object.fromEntries(result.members.map(member => [member.name, member]));
      assert.equal(byName['allowed/a.csv'].status, 'obtained');
      assert.equal(byName['same.csv'].status, 'ambiguous');
      assert.deepEqual(byName['same.csv'].detail.ordinals, [3, 4]);

      // 成员、压缩包版本与授权清单凭据的对应关系完整可追溯。
      const archive = new Archive(directory);
      const receipts = await archive.list();
      const deliveryReceipts = receipts.filter(item => item.source.url?.endsWith('/delivery'));
      const memberReceipts = receipts.filter(item => item.source.kind === 'authorized-member');
      assert.equal(deliveryReceipts.length, 1);
      assert.equal(memberReceipts.length, 2);
      for (const receipt of memberReceipts) {
        assert.equal(receipt.source.etag, '"delivery-1"');
        assert.equal(receipt.source.deliveryReceipt.digest, deliveryReceipts[0].digest);
        assert.ok((await archive.read(receipt)).length > 0);
      }
      // 作业状态已落盘。
      const jobPath = join(directory, 'jobs', result.deliveryReceipt + '.json');
      const job = await loadJob(jobPath);
      assert.equal(job.id, result.job);
      assert.equal(job.finished, true);

      // 只通过 /all.zip 与 /delivery 两个授权接口访问来源，不触及其他路径。
      const zipRequests = provider.audit.filter(item => item.path === '/all.zip');
      assert.ok(zipRequests.length > 0);
      assert.ok(provider.audit.every(item => item.path === '/delivery' || item.path === '/all.zip'));
      // 收件对象只有清单与两个授权成员，不存在整包副本。
      assert.equal(receipts.length, 3);
      assert.ok(receipts.every(item => /^[a-f0-9]{64}$/.test(item.digest)));
    });
  } finally { await provider.close(); }
});

test('换版后恢复旧作业报版本冲突；重新领取后取得新版本内容', async () => {
  const provider = await createProvider();
  try {
    await withTempDirectory(async directory => {
      const first = await receiveAuthorizedMembers(provider.base, directory);
      const jobPath = join(directory, 'jobs', first.deliveryReceipt + '.json');
      const aReceipt = first.members.find(member => member.name === 'allowed/a.csv').receipt;

      await controlled(provider, { generation: 2 });
      await assert.rejects(
        () => resumeAuthorizedMembers(provider.base, directory, jobPath),
        error => error instanceof VersionConflictError,
      );

      // 重新领取清单后绑定新版本，且成员内容反映换版（A,1 -> A,2）。
      const second = await receiveAuthorizedMembers(provider.base, directory);
      assert.equal(second.etag, '"delivery-2"');
      assert.equal(second.summary.obtained, 2);
      const archive = new Archive(directory);
      const newReceipt = second.members.find(member => member.name === 'allowed/a.csv').receipt;
      assert.notEqual(newReceipt.digest, aReceipt.digest);
      const stored = (await archive.list()).find(item => item.id === newReceipt.id);
      assert.equal((await archive.read(stored)).toString('utf8'), 'id,value\nA,2\n');
    });
  } finally { await provider.close(); }
});

test('ZIP64 模式下业务入口同样完成领取', async () => {
  const provider = await createProvider();
  try {
    await controlled(provider, { mode: 'zip64' });
    await withTempDirectory(async directory => {
      const result = await receiveAuthorizedMembers(provider.base, directory);
      assert.equal(result.summary.obtained, 2);
      assert.equal(result.summary.ambiguous, 1);
    });
  } finally { await provider.close(); }
});
