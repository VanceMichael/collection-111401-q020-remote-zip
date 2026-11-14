import { deflateRawSync } from 'node:zlib';

export function crc32(bytes) {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit++) checksum = (checksum >>> 1) ^ (0xedb88320 & -(checksum & 1));
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

export function makeZip(entries, zip64 = false) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content, method = 0, descriptor = false] of entries) {
    const filename = Buffer.from(name);
    const source = Buffer.from(content);
    const packed = method === 8 ? deflateRawSync(source) : source;
    const checksum = crc32(source);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800 | (descriptor ? 8 : 0), 6);
    header.writeUInt16LE(method, 8);
    if (!descriptor) {
      header.writeUInt32LE(checksum, 14);
      header.writeUInt32LE(packed.length, 18);
      header.writeUInt32LE(source.length, 22);
    }
    header.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800 | (descriptor ? 8 : 0), 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(source.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    const trailing = Buffer.alloc(descriptor ? 16 : 0);
    if (descriptor) {
      trailing.writeUInt32LE(0x08074b50, 0); trailing.writeUInt32LE(checksum, 4);
      trailing.writeUInt32LE(packed.length, 8); trailing.writeUInt32LE(source.length, 12);
    }
    locals.push(header, filename, packed, trailing);
    centrals.push(central, filename);
    offset += header.length + filename.length + packed.length + trailing.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : directory.length, 12);
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  const extensions = [];
  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0); record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12); record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(entries.length), 24); record.writeBigUInt64LE(BigInt(entries.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40); record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0); locator.writeBigUInt64LE(BigInt(offset + directory.length), 8); locator.writeUInt32LE(1, 16);
    extensions.push(record, locator);
  }
  return Buffer.concat([...locals, directory, ...extensions, end]);
}

export function serveRange(context, bytes, type, etag) {
  const { request, binary, json, state } = context;
  if (request.headers['if-match'] && request.headers['if-match'] !== etag) return json({ error: '对象已经换版' }, 412);
  const range = request.headers.range;
  if (!range) return binary(bytes, type, { etag, 'accept-ranges': 'bytes' });
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) return json({ error: '仅接受单一字节范围' }, 416);
  let start = match[1] ? Number(match[1]) : Math.max(0, bytes.length - Number(match[2]));
  let end = match[1] ? (match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1) : bytes.length - 1;
  if (start > end || start >= bytes.length) return json({ error: '范围超出对象' }, 416);
  state.transferred = (state.transferred ?? 0) + end - start + 1;
  return binary(bytes.subarray(start, end + 1), type, { etag, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${bytes.length}` }, 206);
}
