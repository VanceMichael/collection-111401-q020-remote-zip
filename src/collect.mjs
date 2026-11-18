// 选择性领取编排：依据授权清单，只通过单范围请求取得对应成员，
// 以中央目录定位、局部头核对、CRC32 与解压大小验证实际内容。
// 同名歧义、目录不一致、换版等情况显式标记，绝不用猜测替代校验。

import { inflateRawSync } from 'node:zlib';
import { open, rename, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Archive } from './archive.mjs';
import { RemoteRangeReader, VersionConflictError } from './remote.mjs';
import {
  crc32, findEocd, parseZip64Eocd, parseZip64Locator,
  parseCentralDirectory, parseLocalHeader, reconcileLocalHeader, describeEntry,
  FLAG_ENCRYPTED, METHOD_STORED, METHOD_DEFLATED,
  ZipStructureError,
} from './zip.mjs';

const TAIL_LIMIT = 65557;
const DEFAULT_MAX_DIRECTORY_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_MEMBER_BYTES = 8 * 1024 * 1024;
const MAX_CONFLICT_RESTARTS = 1;

export async function loadJob(jobPath) {
  return JSON.parse(await readFile(jobPath, 'utf8'));
}

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const staging = path + '.pending.' + randomUUID();
  const handle = await open(staging, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.sync();
  } finally { await handle.close(); }
  await rename(staging, path);
}

function indexNames(entries) {
  const byName = new Map();
  for (const entry of entries) {
    const list = byName.get(entry.name) ?? [];
    list.push(entry);
    byName.set(entry.name, list);
  }
  return byName;
}

function failure(status, reason, detail) {
  return { status, reason, ...(detail ? { detail } : {}) };
}

function summarize(members) {
  const summary = { obtained: 0, ambiguous: 0, missing: 0, incomplete: 0, inconsistent: 0, unsupported: 0 };
  for (const member of members) summary[member.status] += 1;
  return summary;
}

// options:
//   url             资料包地址
//   authorized      授权清单 [{ name }]
//   archive         Archive 收件存储
//   deliveryReceipt /delivery 清单的收件凭据
//   readerOptions   范围读取上限等
//   jobPath         作业状态持久化路径（可选）
//   existingJob     恢复时传入的旧作业；先探测版本，确认旧偏移仍适用才继续
//   onPhase         阶段回调，便于演练与测试
export async function collectAuthorized(options) {
  const {
    url,
    authorized,
    archive,
    deliveryReceipt,
    readerOptions = {},
    jobPath = null,
    existingJob = null,
    onPhase = () => {},
  } = options;
  if (!Array.isArray(authorized) || authorized.length === 0) {
    throw new Error('授权清单为空，无法执行成员领取');
  }
  if (!(archive instanceof Archive)) throw new Error('收件存储不可用');

  const names = [...new Set(authorized.map(item => item.name))];
  const maxDirectoryBytes = readerOptions.maxDirectoryBytes ?? DEFAULT_MAX_DIRECTORY_BYTES;
  const maxMemberBytes = readerOptions.maxMemberBytes ?? DEFAULT_MAX_MEMBER_BYTES;

  const job = existingJob ? structuredClone(existingJob) : {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: null,
    url,
    deliveryReceipt: { id: deliveryReceipt.id, digest: deliveryReceipt.digest, edition: deliveryReceipt.edition ?? null },
    authorized: names.map(name => ({ name })),
    etag: null,
    discovery: null,
    members: [],
    summary: summarize([]),
    finished: false,
    attempts: 0,
  };
  if (existingJob) {
    if (!job.etag) throw new Error('旧作业尚未取得版本凭据，无法确认偏移是否仍然适用');
    const authorizedNames = new Set(names);
    job.members = job.members.filter(member => authorizedNames.has(member.name));
  }

  const persist = async () => {
    job.updatedAt = new Date().toISOString();
    if (jobPath) await atomicWriteJson(jobPath, job);
  };

  const reader = new RemoteRangeReader(url, { etag: job.etag, ...readerOptions });
  if (existingJob) {
    // 恢复工作先确认旧偏移所依据的版本仍然适用；412 直接向上抛出。
    await reader.probe();
    if (job.finished) return job;
  }

  const mark = (name, outcome) => {
    const record = { name, ...outcome };
    job.members = job.members.filter(member => member.name !== name);
    job.members.push(record);
    job.summary = summarize(job.members);
    return record;
  };

  const discover = async () => {
    onPhase('tail');
    // 先取单字节范围以确定对象总长度，再取末尾片段定位 EOCD。
    const probe = await reader.range(0, 0);
    const total = probe.total;
    if (total === null) throw new Error('来源未声明资料包总长度，无法定位结束目录');
    const tailStart = Math.max(0, total - TAIL_LIMIT);
    let tail;
    if (tailStart === 0) {
      tail = total === 1 ? probe.bytes : (await reader.range(0, total - 1)).bytes;
    } else {
      tail = (await reader.range(tailStart, total - 1)).bytes;
    }

    const eocdAt = findEocd(tail);
    if (!eocdAt) throw new ZipStructureError('末尾片段未找到合法 EOCD 记录');
    if (eocdAt.entriesDisk !== eocdAt.entriesTotal) {
      throw new ZipStructureError('EOCD 条目计数跨越磁盘，多卷压缩包不受支持', 'MULTI_VOLUME');
    }

    let cdOffset = eocdAt.cdOffset;
    let cdSize = eocdAt.cdSize;
    let entryCount = eocdAt.entriesTotal;
    const zip64 = eocdAt.cdOffset === 0xffffffff || eocdAt.cdSize === 0xffffffff
      || eocdAt.entriesTotal === 0xffff;

    if (zip64) {
      const locatorOffsetInTail = eocdAt.tailOffset - 20;
      let locatorBuf;
      if (locatorOffsetInTail >= 0) {
        locatorBuf = tail.subarray(locatorOffsetInTail, eocdAt.tailOffset);
      } else {
        const locatorAbsolute = tailStart + locatorOffsetInTail;
        if (locatorAbsolute < 0) throw new ZipStructureError('ZIP64 定位记录位于资料包边界之外');
        locatorBuf = (await reader.range(locatorAbsolute, locatorAbsolute + 19)).bytes;
      }
      const locator = parseZip64Locator(locatorBuf);
      if (locator.eocdOffset + 56 > total || locator.eocdOffset < 0) {
        throw new ZipStructureError('ZIP64 结束目录位置超出资料包边界');
      }
      let recordBuf;
      const recordEnd = locator.eocdOffset + 55;
      if (locator.eocdOffset >= tailStart && recordEnd < total) {
        recordBuf = tail.subarray(locator.eocdOffset - tailStart, locator.eocdOffset - tailStart + 56);
      }
      if (!recordBuf || recordBuf.length < 56) {
        recordBuf = (await reader.range(locator.eocdOffset, recordEnd)).bytes;
      }
      const zip64Eocd = parseZip64Eocd(recordBuf);
      cdOffset = zip64Eocd.cdOffset;
      cdSize = zip64Eocd.cdSize;
      entryCount = zip64Eocd.entries;
    }

    if (!Number.isSafeInteger(cdOffset) || !Number.isSafeInteger(cdSize) || cdSize <= 0 || cdOffset < 0) {
      throw new ZipStructureError('中央目录位置或体积非法');
    }
    if (cdSize > maxDirectoryBytes) {
      throw new ZipStructureError(`中央目录 ${cdSize} 字节超过目录读取预算 ${maxDirectoryBytes}`);
    }
    if (cdOffset + cdSize > total) throw new ZipStructureError('中央目录超出资料包边界');
    if (entryCount <= 0) throw new ZipStructureError('资料包没有任何成员记录');

    onPhase('directory');
    const cd = (await reader.range(cdOffset, cdOffset + cdSize - 1)).bytes;
    const entries = parseCentralDirectory(cd, entryCount);
    for (const entry of entries) {
      if (entry.localHeaderOffset < 0 || entry.localHeaderOffset >= cdOffset) {
        throw new ZipStructureError(`成员 ${entry.name} 的局部头偏移越界`);
      }
      if (entry.compressedSize > maxMemberBytes || entry.uncompressedSize > maxMemberBytes) {
        throw new ZipStructureError(`成员 ${entry.name} 超过成员读取预算`);
      }
    }
    job.etag = reader.etag;
    job.discovery = {
      totalSize: total,
      cdOffset,
      cdSize,
      entryCount,
      zip64,
      entries: entries.map(describeEntry),
    };
    await persist();
    return { entries, total };
  };

  const fetchMember = async (entry, total) => {
    onPhase('local-header', entry);
    const fixed = (await reader.range(entry.localHeaderOffset, entry.localHeaderOffset + 29)).bytes;
    const local = parseLocalHeader(fixed);
    if (local.nameLength === 0) return { inconsistent: true, conflicts: ['EMPTY_LOCAL_NAME'] };
    const nameStart = entry.localHeaderOffset + 30;
    const nameBuf = (await reader.range(nameStart, nameStart + local.nameLength - 1)).bytes;
    const extraStart = nameStart + local.nameLength;
    if (local.extraLength) {
      // 额外字段必须原样跳过；它不属于成员身份判定内容，但其长度纳入边界核对。
      await reader.range(extraStart, extraStart + local.extraLength - 1);
    }
    const conflicts = reconcileLocalHeader(entry, local, nameBuf);
    if (conflicts.length) return { inconsistent: true, conflicts };

    const dataStart = extraStart + local.extraLength;
    if (dataStart < 0 || dataStart > total) {
      return { inconsistent: true, conflicts: ['LOCAL_HEADER_OUT_OF_BOUNDS'] };
    }
    if (entry.compressedSize === 0) {
      if (entry.uncompressedSize !== 0) {
        return { inconsistent: true, conflicts: ['UNCOMPRESSED_SIZE_MISMATCH'] };
      }
      return { content: Buffer.alloc(0) };
    }
    const dataEnd = dataStart + entry.compressedSize - 1;
    if (dataEnd >= total || dataEnd < dataStart) {
      return { inconsistent: true, conflicts: ['DATA_RANGE_OUT_OF_BOUNDS'] };
    }
    onPhase('data', entry);
    const packed = (await reader.range(dataStart, dataEnd)).bytes;
    let content;
    if (entry.method === METHOD_STORED) {
      if (packed.length !== entry.uncompressedSize) {
        return { inconsistent: true, conflicts: ['STORED_SIZE_MISMATCH'] };
      }
      content = packed;
    } else if (entry.method === METHOD_DEFLATED) {
      try {
        content = inflateRawSync(packed, { maxOutputLength: maxMemberBytes });
      } catch (error) {
        return { inconsistent: true, conflicts: ['INFLATE_FAILED'], detail: error.message };
      }
    } else {
      return { unsupported: true, reason: 'UNSUPPORTED_METHOD', detail: `压缩方式 ${entry.method}` };
    }
    if (content.length !== entry.uncompressedSize) {
      return { inconsistent: true, conflicts: ['UNCOMPRESSED_SIZE_MISMATCH'] };
    }
    const actualCrc = crc32(content);
    if (actualCrc !== entry.crc32) {
      return { inconsistent: true, conflicts: ['CRC32_MISMATCH'], detail: `期望 ${entry.crc32} 实际 ${actualCrc}` };
    }
    // 数据描述符位于压缩数据之后；带描述符标志时必须实际读取并与中央目录核对，
    // 不能因为局部头留零就跳过这一结构。
    if ((entry.flags & 0x0008) === 0x0008) {
      const descriptorStart = dataEnd + 1;
      if (descriptorStart + 16 > total) {
        return { inconsistent: true, conflicts: ['DESCRIPTOR_OUT_OF_BOUNDS'] };
      }
      const descriptor = (await reader.range(descriptorStart, descriptorStart + 15)).bytes;
      const hasSignature = descriptor.readUInt32LE(0) === 0x08074b50;
      const base = hasSignature ? 4 : 0;
      if (hasSignature && descriptor.length < 16) {
        return { inconsistent: true, conflicts: ['DESCRIPTOR_TRUNCATED'] };
      }
      const descriptorCrc = descriptor.readUInt32LE(base);
      const descriptorCompressed = descriptor.readUInt32LE(base + 4);
      const descriptorUncompressed = descriptor.readUInt32LE(base + 8);
      if (descriptorCrc !== entry.crc32
        || descriptorCompressed !== entry.compressedSize
        || descriptorUncompressed !== entry.uncompressedSize) {
        return { inconsistent: true, conflicts: ['DESCRIPTOR_MISMATCH'] };
      }
    }
    return { content };
  };

  let restarts = 0;
  let discovered = null;
  while (true) {
    job.attempts += 1;
    try {
      discovered = await discover();
      break;
    } catch (error) {
      // 仅在发现阶段允许换版后整体重新发现；成员数据读取途中换版不得静默重来。
      if (error instanceof VersionConflictError && restarts < MAX_CONFLICT_RESTARTS) {
        restarts += 1;
        job.etag = null;
        job.discovery = null;
        reader.etag = null;
        await persist();
        continue;
      }
      throw error;
    }
  }

  const { entries, total } = discovered;
  const byName = indexNames(entries);

  for (const name of names) {
    if (job.members.some(member => member.name === name && member.status === 'obtained')) continue;
    const matches = byName.get(name) ?? [];
    if (matches.length === 0) {
      mark(name, failure('missing', 'NOT_IN_DIRECTORY'));
      await persist();
      continue;
    }
    if (matches.length > 1) {
      mark(name, failure('ambiguous', 'DUPLICATE_NAME', {
        ordinals: matches.map(entry => entry.ordinal),
        candidates: matches.map(describeEntry),
      }));
      await persist();
      continue;
    }
    const entry = matches[0];
    if ((entry.flags & FLAG_ENCRYPTED) === FLAG_ENCRYPTED) {
      mark(name, failure('unsupported', 'ENCRYPTED_ENTRY'));
      await persist();
      continue;
    }
    let outcome;
    try {
      const result = await fetchMember(entry, total);
      if (result.inconsistent) {
        outcome = failure('inconsistent', 'LOCAL_HEADER_OR_CONTENT_CONFLICT', result);
      } else if (result.unsupported) {
        outcome = failure('unsupported', result.reason, result.detail ? { detail: result.detail } : undefined);
      } else {
        const receipt = await archive.save(result.content, {
          kind: 'authorized-member',
          member: name,
          ordinal: entry.ordinal,
          url,
          etag: reader.etag,
          edition: job.deliveryReceipt.edition,
          method: entry.method,
          crc32: entry.crc32,
          uncompressedSize: entry.uncompressedSize,
          compressedSize: entry.compressedSize,
          deliveryReceipt: job.deliveryReceipt,
        });
        outcome = {
          status: 'obtained',
          ordinal: entry.ordinal,
          receipt: { id: receipt.id, digest: receipt.digest, size: receipt.size },
        };
      }
    } catch (error) {
      if (error instanceof VersionConflictError) {
        job.finished = false;
        await persist();
        throw error;
      }
      outcome = failure('incomplete', 'FETCH_OR_VERIFY_FAILED', { detail: error.message });
    }
    mark(name, outcome);
    await persist();
  }

  job.finished = true;
  job.transferred = reader.transferred;
  job.requests = reader.requests;
  await persist();
  return job;
}
