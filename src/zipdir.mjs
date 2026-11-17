import { inflateRawSync } from 'node:zlib';

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

export function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 目录级问题：结构不一致或明确不支持，领取方不得继续碰运气读文件
export class ZipStructureError extends Error {
  constructor(message) { super(message); this.name = 'ZipStructureError'; }
}
export class ZipUnsupportedError extends ZipStructureError {
  constructor(message) { super(message); this.name = 'ZipUnsupportedError'; }
}
// 成员级问题：只影响单个授权成员，不得扩大为整包结论
export class ZipMemberError extends Error {
  constructor(message) { super(message); this.name = 'ZipMemberError'; }
}

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_MINIMUM = 22;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIZE = 20;
const ZIP64_EOCD_SIZE = 56;
const CENTRAL_SIGNATURE = 0x02014b50;
const CENTRAL_FIXED_SIZE = 46;
const LOCAL_SIGNATURE = 0x04034b50;
const DESCRIPTOR_SIGNATURE = 0x08074b50;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;

const toNumber = (value, label) => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipUnsupportedError(`${label}超出可处理范围`);
  return Number(value);
};

// 在末尾缓冲中定位经典结束目录；注释长度必须与缓冲末尾对齐
export function findEndOfCentralDirectory(tail) {
  for (let position = tail.length - EOCD_MINIMUM; position >= 0; position -= 1) {
    if (tail.readUInt32LE(position) !== EOCD_SIGNATURE) continue;
    const comment = tail.readUInt16LE(position + 20);
    if (position + EOCD_MINIMUM + comment !== tail.length) continue;
    return {
      position,
      disk: tail.readUInt16LE(position + 4),
      directoryDisk: tail.readUInt16LE(position + 6),
      diskCount: tail.readUInt16LE(position + 8),
      count: tail.readUInt16LE(position + 10),
      size: tail.readUInt32LE(position + 12),
      offset: tail.readUInt32LE(position + 16),
    };
  }
  throw new ZipStructureError('末尾范围内未找到有效的结束目录记录');
}

// 由结束目录（必要时含 ZIP64 记录）确定中央目录位置；多卷结构明确不支持
export function locateCentralDirectory(tail, tailStart, eocd = findEndOfCentralDirectory(tail)) {
  if (eocd.disk !== 0 || eocd.directoryDisk !== 0 || eocd.diskCount !== eocd.count)
    throw new ZipUnsupportedError('不支持多卷压缩包');
  let count = eocd.count;
  let size = eocd.size;
  let offset = eocd.offset;
  let zip64 = false;
  if (count === UINT16_MAX || size === UINT32_MAX || offset === UINT32_MAX) {
    zip64 = true;
    const locator = eocd.position - ZIP64_LOCATOR_SIZE;
    if (locator < 0 || tail.readUInt32LE(locator) !== ZIP64_LOCATOR_SIGNATURE)
      throw new ZipStructureError('缺少 ZIP64 定位记录，无法确定目录位置');
    if (tail.readUInt32LE(locator + 4) !== 0 || tail.readUInt32LE(locator + 16) !== 1)
      throw new ZipUnsupportedError('不支持多卷压缩包');
    const recordOffset = toNumber(tail.readBigUInt64LE(locator + 8), 'ZIP64 结束记录偏移');
    const relative = recordOffset - tailStart;
    if (relative < 0 || relative + ZIP64_EOCD_SIZE > tail.length)
      throw new ZipStructureError('ZIP64 结束记录不在已读末尾范围内');
    if (tail.readUInt32LE(relative) !== ZIP64_EOCD_SIGNATURE)
      throw new ZipStructureError('ZIP64 结束记录签名不符');
    if (tail.readUInt32LE(relative + 16) !== 0 || tail.readUInt32LE(relative + 20) !== 0)
      throw new ZipUnsupportedError('不支持多卷压缩包');
    const diskCount = tail.readBigUInt64LE(relative + 24);
    const total = tail.readBigUInt64LE(relative + 32);
    if (diskCount !== total) throw new ZipUnsupportedError('不支持多卷压缩包');
    count = toNumber(total, '目录记录数');
    size = toNumber(tail.readBigUInt64LE(relative + 40), '目录大小');
    offset = toNumber(tail.readBigUInt64LE(relative + 48), '目录偏移');
  }
  const eocdAbsolute = tailStart + eocd.position;
  if (offset + size > eocdAbsolute) throw new ZipStructureError('中央目录范围越过结束目录');
  return { count, size, offset, zip64, eocd: eocdAbsolute };
}

// 逐条解析中央目录；记录数必须与结束目录声明一致，ZIP64 扩展字段按序补全
export function parseCentralDirectory(buffer, expectedCount) {
  const entries = [];
  let position = 0;
  while (position < buffer.length) {
    if (position + CENTRAL_FIXED_SIZE > buffer.length) throw new ZipStructureError('中央目录记录被截断');
    if (buffer.readUInt32LE(position) !== CENTRAL_SIGNATURE) throw new ZipStructureError('中央目录记录签名不符');
    const flags = buffer.readUInt16LE(position + 8);
    const method = buffer.readUInt16LE(position + 10);
    const crc = buffer.readUInt32LE(position + 16);
    let compressed = buffer.readUInt32LE(position + 20);
    let size = buffer.readUInt32LE(position + 24);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    let disk = buffer.readUInt16LE(position + 34);
    let offset = buffer.readUInt32LE(position + 42);
    const recordLength = CENTRAL_FIXED_SIZE + nameLength + extraLength + commentLength;
    if (position + recordLength > buffer.length) throw new ZipStructureError('中央目录记录被截断');
    const nameBytes = Buffer.from(buffer.subarray(position + CENTRAL_FIXED_SIZE, position + CENTRAL_FIXED_SIZE + nameLength));
    if (size === UINT32_MAX || compressed === UINT32_MAX || offset === UINT32_MAX || disk === UINT16_MAX) {
      const extra = buffer.subarray(position + CENTRAL_FIXED_SIZE + nameLength, position + CENTRAL_FIXED_SIZE + nameLength + extraLength);
      let found = false;
      for (let p = 0; p + 4 <= extra.length;) {
        const id = extra.readUInt16LE(p);
        const length = extra.readUInt16LE(p + 2);
        if (p + 4 + length > extra.length) throw new ZipStructureError('中央目录扩展字段被截断');
        if (id === 0x0001) {
          let q = p + 4;
          const end = p + 4 + length;
          const take64 = () => {
            if (q + 8 > end) throw new ZipStructureError('ZIP64 扩展字段不完整');
            const value = toNumber(extra.readBigUInt64LE(q), 'ZIP64 字段');
            q += 8;
            return value;
          };
          if (size === UINT32_MAX) size = take64();
          if (compressed === UINT32_MAX) compressed = take64();
          if (offset === UINT32_MAX) offset = take64();
          if (disk === UINT16_MAX) {
            if (q + 4 > end) throw new ZipStructureError('ZIP64 扩展字段不完整');
            disk = extra.readUInt32LE(q);
          }
          found = true;
          break;
        }
        p += 4 + length;
      }
      if (!found) throw new ZipStructureError('缺少 ZIP64 扩展字段');
    }
    if (disk !== 0) throw new ZipUnsupportedError('不支持多卷压缩包');
    entries.push({
      ordinal: entries.length,
      nameBytes,
      name: nameBytes.toString('utf8'),
      flags, method, crc,
      cSize: compressed, uSize: size, lhOffset: offset,
    });
    position += recordLength;
  }
  if (entries.length !== expectedCount)
    throw new ZipStructureError(`目录记录数 ${entries.length} 与结束目录声明 ${expectedCount} 不一致`);
  return entries;
}

export function parseLocalHeader(header) {
  if (header.length < 30 || header.readUInt32LE(0) !== LOCAL_SIGNATURE)
    throw new ZipMemberError('局部头签名与目录记载的位置不符');
  return {
    flags: header.readUInt16LE(6),
    method: header.readUInt16LE(8),
    crc: header.readUInt32LE(14),
    cSize: header.readUInt32LE(18),
    uSize: header.readUInt32LE(22),
    nameLength: header.readUInt16LE(26),
    extraLength: header.readUInt16LE(28),
  };
}

// 中央目录与局部头逐项对照；任何冲突都返回给调用方，不得任选其一继续
export function compareLocalWithCentral(entry, local, localName) {
  const conflicts = [];
  if (local.method !== entry.method) conflicts.push(`压缩方式目录为 ${entry.method} 局部为 ${local.method}`);
  const mask = 0x0809; // 加密、数据描述符、UTF-8 名称
  if ((local.flags & mask) !== (entry.flags & mask))
    conflicts.push(`标志位目录为 0x${(entry.flags & mask).toString(16)} 局部为 0x${(local.flags & mask).toString(16)}`);
  if (!localName.equals(entry.nameBytes)) conflicts.push('成员名称不一致');
  if (!(entry.flags & 0x8)) {
    if (local.crc !== entry.crc) conflicts.push('CRC32 不一致');
    if (local.cSize !== entry.cSize) conflicts.push('压缩后大小不一致');
    if (local.uSize !== entry.uSize) conflicts.push('解压后大小不一致');
  }
  return conflicts;
}

// 数据描述符只有与中央目录完全吻合才被接受，不接受任何近似解读
export function parseDescriptor(buffer, entry) {
  let p = 0;
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === DESCRIPTOR_SIGNATURE) p = 4;
  if (buffer.length - p >= 12) {
    const crc = buffer.readUInt32LE(p);
    const compressed = buffer.readUInt32LE(p + 4);
    const size = buffer.readUInt32LE(p + 8);
    if (compressed === entry.cSize && size === entry.uSize) {
      if (crc !== entry.crc) throw new ZipMemberError('数据描述符 CRC32 与中央目录不一致');
      return;
    }
    if (buffer.length - p >= 20) {
      const compressed64 = toNumber(buffer.readBigUInt64LE(p + 4), '描述符压缩大小');
      const size64 = toNumber(buffer.readBigUInt64LE(p + 12), '描述符解压大小');
      if (compressed64 === entry.cSize && size64 === entry.uSize) {
        if (crc !== entry.crc) throw new ZipMemberError('数据描述符 CRC32 与中央目录不一致');
        return;
      }
    }
  }
  throw new ZipMemberError('数据描述符与中央目录不一致');
}

// 内容接收依据：解压后大小与 CRC32 必须与中央目录一致
export function extractAndVerify(entry, packed) {
  if (entry.flags & 0x1) throw new ZipMemberError('成员已加密，不支持领取');
  let content;
  if (entry.method === 0) {
    if (entry.cSize !== entry.uSize) throw new ZipMemberError('Stored 成员压缩前后大小不一致');
    content = packed;
  } else if (entry.method === 8) {
    try { content = inflateRawSync(packed); }
    catch { throw new ZipMemberError('Deflate 解压失败'); }
  } else {
    throw new ZipMemberError(`不支持的压缩方式 ${entry.method}`);
  }
  if (content.length !== entry.uSize) throw new ZipMemberError(`解压后大小 ${content.length} 与目录记载 ${entry.uSize} 不符`);
  if (crc32(content) !== entry.crc) throw new ZipMemberError('内容 CRC32 与目录记载不符');
  return content;
}
