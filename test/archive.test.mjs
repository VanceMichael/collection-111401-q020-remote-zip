import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Archive } from '../src/archive.mjs';

test('同一内容能够共享对象，但保留不同领取出处', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'receipts-'));
  try {
    const archive = new Archive(directory);
    const bytes = Buffer.from('合作资料\n');
    const receipts = await Promise.all(['甲', '乙'].map(origin => archive.save(bytes, { origin })));
    assert.equal(receipts[0].digest, receipts[1].digest);
    assert.notEqual(receipts[0].id, receipts[1].id);
    assert.equal((await readdir(join(directory, 'objects'))).length, 1);
    assert.equal((await new Archive(directory).list()).length, 2);
    assert.deepEqual(await archive.read(receipts[0]), bytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('内容损坏不能被收件凭据掩盖', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'corruption-'));
  try {
    const archive = new Archive(directory);
    const receipt = await archive.save(Buffer.from('原文'), { origin: '甲' });
    await writeFile(join(directory, 'objects', receipt.digest), '替换');
    await assert.rejects(() => archive.read(receipt), /校验不符/);
    await assert.rejects(() => archive.read({ digest: '../secret', size: 1 }), /内容标识无效/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('尚未发布的临时凭据不进入已收列表', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pending-'));
  try {
    const archive = new Archive(directory);
    await archive.save(Buffer.from('有效内容'), { origin: '甲' });
    await writeFile(join(directory, 'receipts', 'unfinished.pending'), '{');
    assert.equal((await archive.list()).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
