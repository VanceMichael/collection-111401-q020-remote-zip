// 纯 ZIP 结构解析：只依赖传入的 Buffer，不发起任何网络请求。
// 支持经典 EOCD、ZIP64 EOCD/locator、Stored/Deflate、UTF-8 文件名与数据描述符。
// 多卷等不支持结构以 ZipStructureError 明确报错，绝不静默猜测。

export const SIG_LOCAL = 0x04034b50;
export const SIG_CENTRAL = 0x02014b50;
export const SIG_EOCD = 0x06054b50;
export const SIG_ZIP64_EOCD = 0x06064b50;
export const SIG_ZIP64_LOCATOR = 0x07064b50;
export const SIG_DESCRIPTOR = 0x08074b50;

export const FLAG_DESCRIPTOR = 0x0008;
export const FLAG_UTF8 = 0x0800;
export const FLAG_ENCRYPTED = 0x0001;

export const METHOD_STORED = 0;
export const METHOD_DEFLATED = 8;

export class ZipStructureError extends Error {
  constructor(message, code = 'ZIP_STRUCTURE') {
    super(message);
    this.name = 'ZipStructureError';
    this.code = code;
  }
}

export function crc32(bytes) {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ (0xedb88320 & -(checksum & 1));
    }
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function u16(buf, offset) { return buf.readUInt16LE(offset); }
function u32(buf, offset) { return buf.readUInt32LE(offset); }

// 在末尾片段中定位经典 EOCD。注释最长 65535 字节，自尾部向前扫描，
// 取最后一个（最靠近尾部的）合法签名。
export function findEocd(tail) {
  if (tail.length < 22) return null;
  const lowest = Math.max(0, tail.length - 22 - 65535);
  for (let i = tail.length - 22; i >= lowest; i -= 1) {
    if (u32(tail, i) !== SIG_EOCD) continue;
    const commentLength = u16(tail, i + 20);
    if (commentLength !== tail.length - i - 22) continue;
    const disk = u16(tail, i + 4);
    const diskCd = u16(tail, i + 6);
    const entriesDisk = u16(tail, i + 8);
    const entriesTotal = u16(tail, i + 10);
    if (disk !== 0 || diskCd !== 0) {
      throw new ZipStructureError('多卷压缩包不受支持', 'MULTI_VOLUME');
    }
    return {
      tailOffset: i,
      disk,
      diskCd,
      entriesDisk,
      entriesTotal,
      cdSize: u32(tail, i + 12),
      cdOffset: u32(tail, i + 16),
      commentLength,
    };
  }
  return null;
}

export function parseZip64Locator(buf, offset = 0) {
  if (buf.length - offset < 20 || u32(buf, offset) !== SIG_ZIP64_LOCATOR) {
    throw new ZipStructureError('ZIP64 定位记录缺失或损坏');
  }
  const disk = u32(buf, offset + 4);
  const eocdOffset = buf.readBigUInt64LE(offset + 8);
  const disks = u32(buf, offset + 16);
  if (disk !== 0 || disks !== 1) {
    throw new ZipStructureError('多卷压缩包不受支持', 'MULTI_VOLUME');
  }
  return { eocdOffset: Number(eocdOffset), disks };
}

export function parseZip64Eocd(buf, offset = 0) {
  if (buf.length - offset < 56 || u32(buf, offset) !== SIG_ZIP64_EOCD) {
    throw new ZipStructureError('ZIP64 结束目录缺失或损坏');
  }
  const recordSize = buf.readBigUInt64LE(offset + 4);
  if (recordSize > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ZipStructureError('ZIP64 结束目录长度超出可处理范围');
  }
  const disk = u32(buf, offset + 16);
  const diskCd = u32(buf, offset + 20);
  if (disk !== 0 || diskCd !== 0) {
    throw new ZipStructureError('多卷压缩包不受支持', 'MULTI_VOLUME');
  }
  const entriesDisk = buf.readBigUInt64LE(offset + 24);
  const entriesTotal = buf.readBigUInt64LE(offset + 32);
  if (entriesDisk !== entriesTotal) {
    throw new ZipStructureError('中央目录跨越多个磁盘，多卷压缩包不受支持', 'MULTI_VOLUME');
  }
  return {
    recordSize: Number(recordSize),
    entries: Number(entriesTotal),
    cdSize: Number(buf.readBigUInt64LE(offset + 40)),
    cdOffset: Number(buf.readBigUInt64LE(offset + 48)),
  };
}

function decodeName(nameBytes, flags) {
  if ((flags & FLAG_UTF8) === FLAG_UTF8) return nameBytes.toString('utf8');
  // 非 UTF-8 名称按单字节回退解码；精确匹配仍以原始字节为准。
  return nameBytes.toString('latin1');
}

function readZip64Extra(extra, entry) {
  let cursor = 0;
  const result = {};
  while (cursor + 4 <= extra.length) {
    const id = extra.readUInt16LE(cursor);
    const size = extra.readUInt16LE(cursor + 2);
    const body = cursor + 4;
    if (body + size > extra.length) {
      throw new ZipStructureError(`中央目录第 ${entry.ordinal + 1} 条扩展字段越界`);
    }
    if (id === 0x0001) {
      let field = body;
      const take = () => {
        if (field + 8 > body + size) {
          throw new ZipStructureError(`中央目录第 ${entry.ordinal + 1} 条 ZIP64 字段不完整`);
        }
        const value = extra.readBigUInt64LE(field);
        field += 8;
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new ZipStructureError(`中央目录第 ${entry.ordinal + 1} 条数值超出可处理范围`);
        }
        return Number(value);
      };
      // 字段顺序固定，仅在经典字段为哨兵时出现。
      if (entry.uncompressedSize === 0xffffffff) result.uncompressedSize = take();
      if (entry.compressedSize === 0xffffffff) result.compressedSize = take();
      if (entry.localHeaderOffset === 0xffffffff) result.localHeaderOffset = take();
      if (entry.diskStart === 0xffff) result.diskStart = take();
    }
    cursor = body + size;
  }
  return result;
}

// 解析完整中央目录缓冲区，expectedCount 来自 EOCD/ZIP64 EOCD，
// 条目数量不一致属于结构错误，不得继续读取文件数据。
export function parseCentralDirectory(buf, expectedCount) {
  const entries = [];
  let offset = 0;
  for (let ordinal = 0; ordinal < expectedCount; ordinal += 1) {
    if (offset + 46 > buf.length) {
      throw new ZipStructureError(`中央目录第 ${ordinal + 1} 条记录不完整`);
    }
    if (u32(buf, offset) !== SIG_CENTRAL) {
      throw new ZipStructureError(`中央目录第 ${ordinal + 1} 条签名错误`);
    }
    const nameLength = u16(buf, offset + 28);
    const extraLength = u16(buf, offset + 30);
    const commentLength = u16(buf, offset + 32);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    if (offset + recordLength > buf.length) {
      throw new ZipStructureError(`中央目录第 ${ordinal + 1} 条记录越界`);
    }
    const entry = {
      ordinal,
      flags: u16(buf, offset + 8),
      method: u16(buf, offset + 10),
      crc32: u32(buf, offset + 16),
      compressedSize: u32(buf, offset + 20),
      uncompressedSize: u32(buf, offset + 24),
      diskStart: u16(buf, offset + 34),
      localHeaderOffset: u32(buf, offset + 42),
      nameBytes: Buffer.from(buf.subarray(offset + 46, offset + 46 + nameLength)),
    };
    const extra = buf.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength);
    const zip64 = readZip64Extra(extra, entry);
    if (zip64.uncompressedSize !== undefined) entry.uncompressedSize = zip64.uncompressedSize;
    if (zip64.compressedSize !== undefined) entry.compressedSize = zip64.compressedSize;
    if (zip64.localHeaderOffset !== undefined) entry.localHeaderOffset = zip64.localHeaderOffset;
    if (zip64.diskStart !== undefined) entry.diskStart = zip64.diskStart;
    if (entry.diskStart !== 0) {
      throw new ZipStructureError(`成员 ${ordinal} 位于其他磁盘，多卷压缩包不受支持`, 'MULTI_VOLUME');
    }
    entry.name = decodeName(entry.nameBytes, entry.flags);
    entries.push(entry);
    offset += recordLength;
  }
  if (offset !== buf.length) {
    throw new ZipStructureError('中央目录体积与结束目录记录不一致');
  }
  return entries;
}

export function parseLocalHeader(buf) {
  if (buf.length < 30 || u32(buf, 0) !== SIG_LOCAL) {
    throw new ZipStructureError('局部文件头签名错误');
  }
  return {
    versionNeeded: u16(buf, 4),
    flags: u16(buf, 6),
    method: u16(buf, 8),
    crc32: u32(buf, 14),
    compressedSize: u32(buf, 18),
    uncompressedSize: u32(buf, 22),
    nameLength: u16(buf, 26),
    extraLength: u16(buf, 28),
  };
}

// 中央目录与局部头一致性核对。数据描述符位置的局部头零值是合法的，
// 任何无法调和的差异都返回原因，调用方必须停止该成员的读取。
export function reconcileLocalHeader(entry, local, nameBytes) {
  const reasons = [];
  if (!entry.nameBytes.equals(nameBytes)) reasons.push('NAME_MISMATCH');
  if (entry.method !== local.method) reasons.push('METHOD_MISMATCH');
  if ((entry.flags & ~FLAG_DESCRIPTOR) !== (local.flags & ~FLAG_DESCRIPTOR)) {
    reasons.push('FLAGS_MISMATCH');
  }
  const descriptor = (entry.flags & FLAG_DESCRIPTOR) === FLAG_DESCRIPTOR;
  const check = (label, centralValue, localValue) => {
    if (descriptor) {
      if (localValue !== 0 && localValue !== centralValue) reasons.push(`${label}_MISMATCH`);
    } else if (localValue !== centralValue) {
      reasons.push(`${label}_MISMATCH`);
    }
  };
  check('CRC32', entry.crc32, local.crc32);
  check('COMPRESSED_SIZE', entry.compressedSize, local.compressedSize);
  check('UNCOMPRESSED_SIZE', entry.uncompressedSize, local.uncompressedSize);
  return reasons;
}

export function describeEntry(entry) {
  return {
    ordinal: entry.ordinal,
    name: entry.name,
    method: entry.method,
    flags: entry.flags,
    crc32: entry.crc32,
    compressedSize: entry.compressedSize,
    uncompressedSize: entry.uncompressedSize,
    localHeaderOffset: entry.localHeaderOffset,
    encrypted: (entry.flags & FLAG_ENCRYPTED) === FLAG_ENCRYPTED,
    descriptor: (entry.flags & FLAG_DESCRIPTOR) === FLAG_DESCRIPTOR,
  };
}
