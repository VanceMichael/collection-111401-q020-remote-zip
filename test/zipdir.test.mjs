import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  crc32, findEndOfCentralDirectory, locateCentralDirectory, parseCentralDirectory,
  parseLocalHeader, compareLocalWithCentral, parseDescriptor, extractAndVerify,
  ZipStructureError, ZipUnsupportedError, ZipMemberError,
} from '../src/zipdir.mjs';
import { makeZip } from '../provider/zip.mjs';

const directoryOf = zip => {
  const located = locateCentralDirectory(zip, 0);
  return { located, bytes: zip.subarray(located.offset, located.offset + located.size) };
};

test('crc32 符合标准向量', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('带注释的结束目录可以定位，垃圾后缀不被接受', () => {
  const eocd = Buffer.alloc(22 + 5);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(3, 8);
  eocd.writeUInt16LE(3, 10);
  eocd.writeUInt16LE(5, 20);
  eocd.write('hello', 22);
  const found = findEndOfCentralDirectory(Buffer.concat([Buffer.from('前缀字节'), eocd]));
  assert.equal(found.count, 3);
  assert.throws(() => findEndOfCentralDirectory(Buffer.concat([eocd, Buffer.from('尾巴')])), ZipStructureError);
});

test('多卷结构明确不支持', () => {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 4);
  assert.throws(() => locateCentralDirectory(eocd, 0), ZipUnsupportedError);
  assert.throws(() => locateCentralDirectory(eocd, 0), /多卷/);
});

test('目录记录数与结束目录不一致时拒绝解析', () => {
  const zip = makeZip([['a.txt', '甲'], ['b.txt', '乙']]);
  const { located, bytes } = directoryOf(zip);
  assert.equal(located.count, 2);
  assert.throws(() => parseCentralDirectory(bytes, 3), /不一致/);
  const entries = parseCentralDirectory(bytes, 2);
  assert.deepEqual(entries.map(entry => entry.name), ['a.txt', 'b.txt']);
  assert.deepEqual(entries.map(entry => entry.ordinal), [0, 1]);
});

test('ZIP64 结束记录给出真实目录位置', () => {
  const zip = makeZip([['a.txt', '内容']], true);
  const located = locateCentralDirectory(zip, 0);
  assert.equal(located.zip64, true);
  assert.equal(located.count, 1);
  const entries = parseCentralDirectory(zip.subarray(located.offset, located.offset + located.size), 1);
  assert.equal(entries[0].name, 'a.txt');
});

test('局部头与中央目录冲突被逐项列出', () => {
  const zip = makeZip([['a.txt', 'hello', 0]]);
  const { located, bytes } = directoryOf(zip);
  const [entry] = parseCentralDirectory(bytes, located.count);
  const local = parseLocalHeader(zip.subarray(entry.lhOffset, entry.lhOffset + 30));
  const name = zip.subarray(entry.lhOffset + 30, entry.lhOffset + 30 + local.nameLength);
  assert.deepEqual(compareLocalWithCentral(entry, local, name), []);
  const conflicts = compareLocalWithCentral(entry, { ...local, method: 8 }, name);
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0], /压缩方式/);
  assert.ok(compareLocalWithCentral(entry, local, Buffer.from('b.txt')).length > 0);
});

test('数据描述符只接受与目录吻合的记录', () => {
  const entry = { cSize: 7, uSize: 9, crc: 0x11223344 };
  const good = Buffer.alloc(16);
  good.writeUInt32LE(0x08074b50, 0);
  good.writeUInt32LE(entry.crc, 4);
  good.writeUInt32LE(7, 8);
  good.writeUInt32LE(9, 12);
  assert.doesNotThrow(() => parseDescriptor(good, entry));
  const bad = Buffer.from(good);
  bad.writeUInt32LE(8, 8);
  assert.throws(() => parseDescriptor(bad, entry), ZipMemberError);
  const badCrc = Buffer.from(good);
  badCrc.writeUInt32LE(0x99887766, 4);
  assert.throws(() => parseDescriptor(badCrc, entry), /CRC32/);
});

test('内容校验以解压后大小和 CRC32 为准', () => {
  const content = Buffer.from('id,value\nA,1\n');
  const packed = deflateRawSync(content);
  const entry = { flags: 0x8, method: 8, cSize: packed.length, uSize: content.length, crc: crc32(content) };
  assert.deepEqual(extractAndVerify(entry, packed), content);
  assert.throws(() => extractAndVerify(entry, packed.subarray(0, packed.length - 1)), ZipMemberError);
  assert.throws(() => extractAndVerify({ ...entry, crc: entry.crc ^ 1 }, packed), /CRC32/);
  assert.throws(() => extractAndVerify({ ...entry, method: 99 }, packed), /压缩方式/);
  assert.throws(() => extractAndVerify({ ...entry, flags: 0x9, method: 0 }, packed), /加密/);
  const stored = { flags: 0, method: 0, cSize: content.length, uSize: content.length, crc: crc32(content) };
  assert.deepEqual(extractAndVerify(stored, content), content);
});

test('局部头签名不符按成员级问题处理', () => {
  assert.throws(() => parseLocalHeader(Buffer.alloc(30)), ZipMemberError);
});
