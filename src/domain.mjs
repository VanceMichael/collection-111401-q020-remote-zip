import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { capture } from './client.mjs';
import { Archive } from './archive.mjs';
import { collectAuthorized, loadJob } from './collect.mjs';
import { VersionConflictError } from './remote.mjs';

// 原有入口：领取并保存来源给出的授权清单与资料包位置。
export async function receiveCurrent(base, directory) {
  const { bytes, receipt } = await capture(base + '/delivery', directory);
  const data = JSON.parse(bytes);
  return {
    receipt: receipt.id,
    delivery: data.delivery,
    edition: data.edition,
    authorized: data.authorized,
    address: data.href,
  };
}

// 远端成员领取：先保存授权清单凭据，再按清单只领取对应成员。
// 返回每个授权成员的明确状态（obtained/ambiguous/missing/incomplete/inconsistent/unsupported）。
export async function receiveAuthorizedMembers(base, directory, options = {}) {
  const archive = new Archive(directory);
  const { bytes, receipt } = await capture(base + '/delivery', directory);
  const data = JSON.parse(bytes);
  const url = new URL(data.href, base).toString();
  const jobsDir = join(directory, 'jobs');
  await mkdir(jobsDir, { recursive: true });
  const jobPath = options.jobPath ?? join(jobsDir, receipt.id + '.json');
  const job = await collectAuthorized({
    url,
    authorized: data.authorized,
    archive,
    deliveryReceipt: { ...receipt, edition: data.edition },
    readerOptions: options.readerOptions,
    jobPath,
    existingJob: options.existingJob ?? null,
    onPhase: options.onPhase,
  });
  return {
    deliveryReceipt: receipt.id,
    edition: data.edition,
    etag: job.etag,
    summary: job.summary,
    members: job.members,
    job: job.id,
    finished: job.finished,
    transferred: job.transferred,
    requests: job.requests,
  };
}

// 恢复未完成的领取作业：先用 If-Match 确认旧偏移依据的版本仍然适用。
// 若资料包已换版，抛出 VersionConflictError，由调用方决定是否重新领取。
export async function resumeAuthorizedMembers(base, directory, jobPath, options = {}) {
  const archive = new Archive(directory);
  const existingJob = await loadJob(jobPath);
  const url = new URL(existingJob.url, base).toString();
  const job = await collectAuthorized({
    url,
    authorized: existingJob.authorized,
    archive,
    deliveryReceipt: {
      id: existingJob.deliveryReceipt.id,
      digest: existingJob.deliveryReceipt.digest,
      edition: existingJob.deliveryReceipt.edition,
    },
    readerOptions: options.readerOptions,
    jobPath,
    existingJob,
    onPhase: options.onPhase,
  });
  return {
    deliveryReceipt: existingJob.deliveryReceipt.id,
    edition: existingJob.deliveryReceipt.edition,
    etag: job.etag,
    summary: job.summary,
    members: job.members,
    job: job.id,
    finished: job.finished,
    transferred: job.transferred,
    requests: job.requests,
  };
}

export { VersionConflictError };
