import test from 'node:test';
import assert from 'node:assert/strict';
import { makeZip, crc32 as providerCrc32 } from '../provider/zip.mjs';
import {
  crc32, findEocd, parseCentralDirectory, parseLocalHeader, reconcileLocalHeader,
  parseZip64Locator, parseZip64Eocd, ZipStructureError,
  SIG_EOCD, SIG_ZIP64_LOCATOR, SIG_ZIP64_EOCD, FLAG_DESCRIPTOR,
} from '../src/zip.mjs';

function locateCentralDirectory(buf) {
  const eocd = findEocd(buf);
  assert.ok(eocd);
  return { eocd, cd: buf.subarray(eocd.cdOffset, eocd.cdOffset + eocd.cdSize) };
}

test('crc32 与来源实现及已知向量一致', () => {
  assert.equal(crc32(Buffer.from('')), 0);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.from('id,value\nA,1\n')), providerCrc32(Buffer.from('id,value\nA,1\n')));
});

test('经典 EOCD 在无注释与带注释的末尾片段中都能定位', () => {
  const buf = makeZip([['a.txt', 'hello']]);
  const plain = findEocd(buf);
  assert.ok(plain);
  assert.equal(plain.entriesTotal, 1);
  assert.equal(plain.commentLength, 0);

  const eocdOffset = buf.length - 22;
  const comment = Buffer.from('承办方说明文字'.repeat(50));
  const withComment = Buffer.concat([
    buf.subarray(0, eocdOffset),
    buf.subarray(eocdOffset, eocdOffset + 20),
    Buffer.from([comment.length & 0xff, (comment.length >> 8) & 0xff]),
    comment,
  ]);
  const found = findEocd(withComment);
  assert.ok(found);
  assert.equal(found.tailOffset, eocdOffset);
  assert.equal(found.commentLength, comment.length);
  assert.equal(findEocd(withComment.subarray(0, 10)), null);
});

test('中央目录解析 Stored/Deflate/数据描述符条目', () => {
  const buf = makeZip([
    ['stored.bin', Buffer.alloc(100, 3), 0],
    ['text/a.csv', 'id,value\nA,1\n', 8],
    ['stream.log', 'flow', 8, true],
  ]);
  const { eocd, cd } = locateCentralDirectory(buf);
  const entries = parseCentralDirectory(cd, eocd.entriesTotal);
  assert.deepEqual(entries.map(entry => entry.name), ['stored.bin', 'text/a.csv', 'stream.log']);
  assert.equal(entries[0].method, 0);
  assert.equal(entries[1].method, 8);
  assert.equal(entries[2].method, 8);
  assert.equal(entries[2].flags & FLAG_DESCRIPTOR, FLAG_DESCRIPTOR);
  assert.equal(entries[2].uncompressedSize, 4);
  assert.ok(entries.every(entry => entry.localHeaderOffset >= 0));
});

test('ZIP64 结束记录与定位记录可被解析', () => {
  const buf = makeZip([['z.txt', 'zip64-data']], true);
  const eocd = findEocd(buf);
  assert.equal(eocd.entriesTotal, 0xffff);
  const locatorBuf = buf.subarray(eocd.tailOffset - 20, eocd.tailOffset);
  assert.equal(locatorBuf.readUInt32LE(0), SIG_ZIP64_LOCATOR);
  const locator = parseZip64Locator(locatorBuf);
  const record = parseZip64Eocd(buf.subarray(locator.eocdOffset, locator.eocdOffset + 56));
  assert.equal(buf.readUInt32LE(locator.eocdOffset), SIG_ZIP64_EOCD);
  assert.equal(record.entries, 1);
  assert.equal(record.cdOffset, eocd.cdOffset === 0xffffffff ? record.cdOffset : eocd.cdOffset);
  const cd = buf.subarray(record.cdOffset, record.cdOffset + record.cdSize);
  const entries = parseCentralDirectory(cd, record.entries);
  assert.equal(entries[0].name, 'z.txt');
});

test('中央目录条目数量与预期不符时拒绝继续解析', () => {
  const buf = makeZip([['a.txt', 'a'], ['b.txt', 'bb']]);
  const { eocd, cd } = locateCentralDirectory(buf);
  assert.throws(() => parseCentralDirectory(cd, 3), /不完整/);
  const truncated = cd.subarray(0, cd.length - 10);
  assert.throws(() => parseCentralDirectory(truncated, eocd.entriesTotal), ZipStructureError);
});

test('局部头与中央目录一致时通过核对，冲突时逐项报告', () => {
  const buf = makeZip([['ok.txt', 'content'], ['d.txt', 'desc', 8, true]]);
  const { eocd, cd } = locateCentralDirectory(buf);
  const entries = parseCentralDirectory(cd, eocd.entriesTotal);

  const first = entries[0];
  const localBuf = buf.subarray(first.localHeaderOffset, first.localHeaderOffset + 30 + first.nameBytes.length);
  const local = parseLocalHeader(localBuf);
  assert.deepEqual(reconcileLocalHeader(first, local, first.nameBytes), []);

  // 数据描述符条目的局部头零体积是合法形态。
  const second = entries[1];
  const secondLocalBuf = buf.subarray(second.localHeaderOffset, second.localHeaderOffset + 30 + second.nameBytes.length);
  const secondLocal = parseLocalHeader(secondLocalBuf);
  assert.deepEqual(reconcileLocalHeader(second, secondLocal, second.nameBytes), []);

  const tampered = { ...first, method: 8 };
  assert.deepEqual(reconcileLocalHeader(tampered, local, first.nameBytes), ['METHOD_MISMATCH']);
  const wrongName = reconcileLocalHeader(first, local, Buffer.from('other.txt'));
  assert.deepEqual(wrongName, ['NAME_MISMATCH']);
});

test('多卷 EOCD 与 ZIP64 定位记录被明确拒绝', () => {
  const buf = makeZip([['a.txt', 'a']]);
  const eocdOffset = buf.length - 22;
  const multi = Buffer.from(buf);
  multi.writeUInt16LE(1, eocdOffset + 4);
  assert.throws(() => findEocd(multi), /多卷/);

  const zip64 = makeZip([['a.txt', 'a']], true);
  const found = findEocd(zip64);
  const badLocator = Buffer.from(zip64.subarray(found.tailOffset - 20, found.tailOffset));
  badLocator.writeUInt32LE(2, 16);
  assert.throws(() => parseZip64Locator(badLocator), /多卷/);
});

test('EOCD 签名被破坏时返回未找到而非猜测', () => {
  const buf = makeZip([['a.txt', 'a']]);
  const broken = Buffer.from(buf);
  broken.writeUInt32LE(0, broken.length - 22);
  assert.equal(findEocd(broken), null);
  assert.equal(SIG_EOCD, 0x06054b50);
});
