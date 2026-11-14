import { Archive } from './archive.mjs';

export async function capture(url, directory, options = {}) {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000), ...options });
  if (!response.ok) throw new Error(`来源领取失败：${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error('单份人工领取超过当前收件上限');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const source = { url, status: response.status, type: response.headers.get('content-type'), etag: response.headers.get('etag') };
  const archive = new Archive(directory);
  const receipt = await archive.save(bytes, source);
  return { bytes, receipt };
}
