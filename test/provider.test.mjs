import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProvider } from '../provider/server.mjs';
import { receiveCurrent } from '../src/domain.mjs';
import { Archive } from '../src/archive.mjs';

async function controlled(provider, change) {
  const response = await fetch(provider.base + '/_control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(change) });
  assert.equal(response.status, 200);
}

test('现有业务入口真实收存来源资料并可重新打开', async () => {
  const provider = await createProvider();
  const directory = await mkdtemp(join(tmpdir(), 'business-'));
  try {
    const result = await receiveCurrent(provider.base, directory);
    assert.ok(result);
    const archive = new Archive(directory);
    const receipts = await archive.list();
    assert.ok(receipts.length > 0);
    for (const receipt of receipts) assert.ok((await archive.read(receipt)).length > 0);
    assert.ok(provider.audit.some(request => !request.path.startsWith('/_')));
  } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('整包下载未获授权', async () => {
 const provider = await createProvider();
 try {
assert.equal((await fetch(provider.base+'/all.zip')).status,403);
 } finally { await provider.close(); }
});

test('末尾范围包含经典结束目录且不包含整包', async () => {
 const provider = await createProvider();
 try {
const response=await fetch(provider.base+'/all.zip',{headers:{range:'bytes=-65557'}});assert.equal(response.status,206);const bytes=Buffer.from(await response.arrayBuffer());assert.ok(bytes.length<=65557);assert.equal(bytes.readUInt32LE(bytes.length-22),0x06054b50);
 } finally { await provider.close(); }
});

test('ZIP64 结束目录可在小数据中出现', async () => {
 const provider = await createProvider();
 try {
await controlled(provider,{mode:'zip64'});const bytes=Buffer.from(await(await fetch(provider.base+'/all.zip',{headers:{range:'bytes=-65557'}})).arrayBuffer());assert.ok(bytes.includes(Buffer.from([0x50,0x4b,0x06,0x06])));assert.equal(bytes.readUInt32LE(bytes.length-42),0x07064b50);
 } finally { await provider.close(); }
});

test('换版后旧偏移条件失效', async () => {
 const provider = await createProvider();
 try {
await controlled(provider,{generation:2});assert.equal((await fetch(provider.base+'/all.zip',{headers:{range:'bytes=0-29','if-match':'"delivery-1"'}})).status,412);
 } finally { await provider.close(); }
});
