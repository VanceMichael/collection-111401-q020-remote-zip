import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Archive, sha256 } from './archive.mjs';
import {
  compareLocalWithCentral, extractAndVerify, findEndOfCentralDirectory,
  locateCentralDirectory, parseCentralDirectory, parseDescriptor, parseLocalHeader,
  ZipMemberError, ZipStructureError,
} from './zipdir.mjs';

const TAIL_LIMIT = 65557; // 契约允许为发现结束目录读取的末尾上限
const LOCAL_HEADER_SIZE = 30;
const DESCRIPTOR_CLASSIC = 16;
const DESCRIPTOR_ZIP64 = 24;

class VersionChanged extends Error {} // 来源换版：旧偏移全部作废
class SourceRefused extends Error {} // 来源响应越出契约：停止而不是碰运气

const serializeEntries = entries => entries.map(entry => ({ ...entry, nameBytes: entry.nameBytes.toString('hex') }));
const deserializeEntries = entries => entries.map(entry => ({ ...entry, nameBytes: Buffer.from(entry.nameBytes, 'hex') }));

// 按授权清单从远端压缩包领取成员。只发单范围请求，拒绝整包响应；
// 每个成员经局部头核对、描述符核对、解压校验后才入收件库。
export async function collectMembers(options) {
  const {
    url, authorized, directory,
    tailLimit: requestedTailLimit,
    edition = null, deliveryReceipt = null,
    fetchImpl = fetch, maxVersionChanges = 3,
  } = options;
  const tailLimit = Math.min(requestedTailLimit ?? TAIL_LIMIT, TAIL_LIMIT);
  const names = [...new Set(authorized)];
  const authorizedHash = sha256(Buffer.from(JSON.stringify(names)));
  const archive = new Archive(directory);
  const statePath = join(directory, 'remotezip-state.json');
  const run = randomUUID();
  const report = {
    run, url, edition, deliveryReceipt, authorized: names,
    version: null, versionChanges: 0, status: 'incomplete', directory: null,
    obtained: [], ambiguous: [], missing: [], failed: [], pending: [],
    requests: 0, transferred: 0, manifest: null,
  };
  let totalSize = null;
  let memberState = {};
  let directoryState = null;

  const saveState = async () => {
    await mkdir(directory, { recursive: true });
    const staging = statePath + '.pending';
    await writeFile(staging, JSON.stringify({
      url, authorizedHash, etag: report.version, edition,
      directory: directoryState, members: memberState, updatedAt: new Date().toISOString(),
    }));
    await rename(staging, statePath);
  };
  const loadState = async () => {
    try { return JSON.parse(await readFile(statePath, 'utf8')); }
    catch { return null; }
  };

  // 单范围读取并核验响应；purpose 为 tail 时按末尾后缀请求
  const readRange = async (start, end, purpose, etag) => {
    if (totalSize !== null && purpose !== 'tail' && start === 0 && end === totalSize - 1)
      throw new SourceRefused('拒绝发出等同整包的范围请求');
    const headers = { range: purpose === 'tail' ? `bytes=-${tailLimit}` : `bytes=${start}-${end}` };
    if (etag) headers['if-match'] = etag;
    const response = await fetchImpl(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    report.requests += 1;
    if (response.status === 412) throw new VersionChanged('来源已换版，条件范围失效');
    if (response.status === 200) throw new SourceRefused('来源忽略范围请求并返回整包，已拒绝接收');
    if (response.status !== 206) throw new SourceRefused(`范围请求被拒绝：${response.status}`);
    const contentRange = response.headers.get('content-range') ?? '';
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
    if (!match) throw new SourceRefused('范围响应缺少内容范围标识，无法确认偏移');
    const [from, to, total] = [Number(match[1]), Number(match[2]), Number(match[3])];
    totalSize = total;
    const expectedFrom = purpose === 'tail' ? Math.max(0, total - tailLimit) : start;
    const expectedTo = purpose === 'tail' ? total - 1 : end;
    if (from !== expectedFrom || to !== expectedTo) throw new SourceRefused('范围响应与请求不符');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== to - from + 1) throw new SourceRefused('范围响应长度不符');
    report.transferred += bytes.length;
    return { bytes, etag: response.headers.get('etag') };
  };

  let resumeCandidate = await loadState();
  if (resumeCandidate
      && (resumeCandidate.url !== url || resumeCandidate.authorizedHash !== authorizedHash
          || !resumeCandidate.etag || !resumeCandidate.directory)) resumeCandidate = null;

  const attempt = async () => {
    // 恢复时先带旧版本条件读末尾：412 说明旧偏移已失效，206 且目录特征一致才可复用
    let tail = null;
    if (resumeCandidate?.etag) {
      try {
        tail = await readRange(0, 0, 'tail', resumeCandidate.etag);
      } catch (error) {
        if (!(error instanceof VersionChanged)) throw error;
        resumeCandidate = null;
      }
    }
    tail ??= await readRange(0, 0, 'tail', null);
    report.version = tail.etag ?? null;
    if (resumeCandidate && resumeCandidate.etag !== report.version) resumeCandidate = null;

    const tailStart = totalSize - tail.bytes.length;
    const located = locateCentralDirectory(tail.bytes, tailStart, findEndOfCentralDirectory(tail.bytes));
    report.directory = { entries: located.count, zip64: located.zip64 };
    let entries;
    if (resumeCandidate?.directory
        && resumeCandidate.directory.offset === located.offset
        && resumeCandidate.directory.size === located.size
        && resumeCandidate.directory.count === located.count) {
      entries = deserializeEntries(resumeCandidate.directory.entries); // 旧偏移经确认仍适用
      directoryState = resumeCandidate.directory;
      memberState = resumeCandidate.members ?? {};
    } else {
      resumeCandidate = null;
      memberState = {};
      let directoryBytes;
      if (located.offset >= tailStart) {
        directoryBytes = tail.bytes.subarray(located.offset - tailStart, located.offset - tailStart + located.size);
      } else if (located.size > 0) {
        directoryBytes = (await readRange(located.offset, located.offset + located.size - 1, 'directory', report.version)).bytes;
      } else {
        directoryBytes = Buffer.alloc(0);
      }
      entries = parseCentralDirectory(directoryBytes, located.count);
      directoryState = {
        offset: located.offset, size: located.size, count: located.count,
        zip64: located.zip64, entries: serializeEntries(entries),
      };
      await saveState();
    }

    // 授权名称精确匹配，不扩展为前缀或相似名；同名多个成员即业务歧义
    const byName = new Map();
    for (const entry of entries) {
      const list = byName.get(entry.name);
      if (list) list.push(entry);
      else byName.set(entry.name, [entry]);
    }
    const plan = [];
    for (const name of names) {
      const found = byName.get(name) ?? [];
      if (found.length === 0) report.missing.push(name);
      else if (found.length > 1)
        report.ambiguous.push({ name, candidates: found.map(({ ordinal, lhOffset }) => ({ ordinal, localOffset: lhOffset })) });
      else plan.push({ name, entry: found[0] });
    }

    for (const { name, entry } of plan) {
      const prior = memberState[name];
      if (prior?.status === 'obtained' && prior.etag === report.version) {
        report.obtained.push({
          name, receipt: prior.receipt, digest: prior.digest, size: prior.size,
          ordinal: entry.ordinal, localOffset: entry.lhOffset, reused: true,
        });
        continue;
      }
      if (entry.flags & 0x1) { report.failed.push({ name, reason: '成员已加密，不支持领取' }); continue; }
      if (entry.method !== 0 && entry.method !== 8) { report.failed.push({ name, reason: `不支持的压缩方式 ${entry.method}` }); continue; }
      try {
        const header = (await readRange(entry.lhOffset, entry.lhOffset + LOCAL_HEADER_SIZE - 1, `header:${name}`, report.version)).bytes;
        const local = parseLocalHeader(header);
        const nameExtraLength = local.nameLength + local.extraLength;
        let localName = Buffer.alloc(0);
        if (nameExtraLength > 0) {
          localName = (await readRange(
            entry.lhOffset + LOCAL_HEADER_SIZE,
            entry.lhOffset + LOCAL_HEADER_SIZE + nameExtraLength - 1,
            `header-extra:${name}`, report.version,
          )).bytes.subarray(0, local.nameLength);
        }
        const conflicts = compareLocalWithCentral(entry, local, localName);
        if (conflicts.length > 0)
          throw new ZipMemberError(`目录与局部头不一致：${conflicts.join('；')}，停止读取该成员`);
        const dataStart = entry.lhOffset + LOCAL_HEADER_SIZE + nameExtraLength;
        let data = Buffer.alloc(0);
        const want = entry.cSize + (entry.flags & 0x8 ? DESCRIPTOR_CLASSIC : 0);
        if (want > 0)
          data = (await readRange(dataStart, dataStart + want - 1, `member:${name}`, report.version)).bytes;
        if (entry.flags & 0x8) {
          try {
            parseDescriptor(data.subarray(entry.cSize), entry);
          } catch (error) {
            if (!(error instanceof ZipMemberError) || !located.zip64) throw error;
            data = (await readRange(dataStart, dataStart + entry.cSize + DESCRIPTOR_ZIP64 - 1, `member-descriptor64:${name}`, report.version)).bytes;
            parseDescriptor(data.subarray(entry.cSize), entry);
          }
        }
        const content = extractAndVerify(entry, data.subarray(0, entry.cSize));
        const receipt = await archive.save(content, {
          kind: 'zip-member', url, member: name, ordinal: entry.ordinal, localOffset: entry.lhOffset,
          etag: report.version, edition, deliveryReceipt, crc32: entry.crc, method: entry.method,
        });
        report.obtained.push({
          name, receipt: receipt.id, digest: receipt.digest, size: content.length,
          ordinal: entry.ordinal, localOffset: entry.lhOffset, reused: false,
        });
        memberState[name] = {
          status: 'obtained', receipt: receipt.id, digest: receipt.digest,
          size: content.length, etag: report.version,
        };
        await saveState();
      } catch (error) {
        if (error instanceof ZipMemberError) { report.failed.push({ name, reason: error.message }); continue; }
        throw error;
      }
    }
  };

  const finish = async error => {
    if (error) report.error = error.message;
    const settled = new Set([
      ...report.obtained.map(item => item.name),
      ...report.ambiguous.map(item => item.name),
      ...report.missing,
      ...report.failed.map(item => item.name),
    ]);
    report.pending = names.filter(name => !settled.has(name));
    if (report.status !== 'aborted' && report.status !== 'version-unstable') {
      if (report.pending.length > 0) report.status = 'incomplete';
      else if (report.failed.length > 0 || report.ambiguous.length > 0 || report.missing.length > 0) report.status = 'partial';
      else report.status = 'complete';
    }
    const manifest = {
      kind: 'collection-manifest', run, at: new Date().toISOString(), url,
      version: report.version, edition, deliveryReceipt, authorized: names,
      obtained: report.obtained, ambiguous: report.ambiguous, missing: report.missing,
      failed: report.failed, pending: report.pending, status: report.status,
      directory: report.directory, requests: report.requests,
      transferred: report.transferred, versionChanges: report.versionChanges,
    };
    const receipt = await archive.save(Buffer.from(JSON.stringify(manifest, null, 2)), {
      kind: 'collection-manifest', run, url, etag: report.version, edition, deliveryReceipt,
    });
    report.manifest = receipt.id;
    await saveState();
    return report;
  };

  let versionChanges = 0;
  for (;;) {
    try {
      await attempt();
      return await finish();
    } catch (error) {
      if (error instanceof VersionChanged) {
        versionChanges += 1;
        report.versionChanges = versionChanges;
        resumeCandidate = null;
        directoryState = null;
        memberState = {};
        report.obtained = [];
        report.ambiguous = [];
        report.missing = [];
        report.failed = [];
        if (versionChanges > maxVersionChanges) {
          report.status = 'version-unstable';
          return await finish(error);
        }
        continue;
      }
      if (error instanceof SourceRefused || error instanceof ZipStructureError) {
        report.status = 'aborted';
        return await finish(error);
      }
      report.status = 'incomplete'; // 网络等可恢复中断：状态已落盘，可按旧偏移确认后续领
      return await finish(error);
    }
  }
}
