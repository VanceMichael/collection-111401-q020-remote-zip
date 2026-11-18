// 远端资料包的受限范围读取器：
// 只允许单一字节范围、只接受 206 部分内容、全程绑定同一 ETag 版本，
// 单次响应与累计传输均有上限，从机制上避免把整包逐段拼回。

export class VersionConflictError extends Error {
  constructor(message, expected, actual) {
    super(message);
    this.name = 'VersionConflictError';
    this.code = 'VERSION_CONFLICT';
    this.expected = expected;
    this.actual = actual;
  }
}

export class RemoteRangeReader {
  constructor(url, options = {}) {
    this.url = url;
    this.etag = options.etag ?? null;
    this.maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
    this.maxTotalBytes = options.maxTotalBytes ?? 32 * 1024 * 1024;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.transferred = 0;
    this.requests = 0;
  }

  async range(start, end) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      throw new Error(`范围参数非法：${start}-${end}`);
    }
    const length = end - start + 1;
    if (length > this.maxResponseBytes) {
      throw new Error(`单次范围 ${length} 字节超过读取上限 ${this.maxResponseBytes}`);
    }
    if (this.transferred + length > this.maxTotalBytes) {
      throw new Error(`累计范围读取将超过预算 ${this.maxTotalBytes} 字节，停止以防拼回整包`);
    }
    const headers = { range: `bytes=${start}-${end}` };
    if (this.etag) headers['if-match'] = this.etag;
    let response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error.name === 'TimeoutError') throw new Error(`范围读取超时：${this.url}`);
      throw error;
    }
    if (response.status === 412) {
      await response.arrayBuffer().catch(() => {});
      throw new VersionConflictError(
        '资料包已经换版，旧偏移与条件凭据失效',
        this.etag,
        response.headers.get('etag'),
      );
    }
    if (response.status !== 206) {
      await response.arrayBuffer().catch(() => {});
      throw new Error(`来源未返回部分内容：${response.status}`);
    }
    const type = response.headers.get('content-type');
    if (type && !type.includes('zip') && !type.includes('octet-stream')) {
      throw new Error(`来源返回类型不是资料包：${type}`);
    }
    const contentRange = response.headers.get('content-range');
    const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(contentRange ?? '');
    if (!match) throw new Error('来源缺少合法 Content-Range，无法确认所取字节位置');
    const actualStart = Number(match[1]);
    const actualEnd = Number(match[2]);
    const total = match[3] === '*' ? null : Number(match[3]);
    if (actualStart !== start || actualEnd !== end) {
      throw new Error(`来源返回范围 ${actualStart}-${actualEnd} 与请求 ${start}-${end} 不一致`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > length) throw new Error('范围响应体积超过声明长度');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== length) {
      throw new Error(`范围响应体积 ${bytes.length} 与声明长度 ${length} 不一致`);
    }
    const responseEtag = response.headers.get('etag');
    if (!responseEtag) throw new Error('来源未提供 ETag，无法绑定资料包版本');
    if (!this.etag) this.etag = responseEtag;
    else if (responseEtag !== this.etag) {
      throw new VersionConflictError('来源在领取过程中换版', this.etag, responseEtag);
    }
    this.transferred += length;
    this.requests += 1;
    return { bytes, total, etag: this.etag };
  }

  // 验证旧作业的偏移在当前资料包上是否仍然适用，不传输实际数据。
  async probe() {
    if (!this.etag) throw new Error('探测前必须持有要验证的版本凭据');
    const response = await this.fetchImpl(this.url, {
      method: 'GET',
      headers: { range: 'bytes=0-0', 'if-match': this.etag },
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    this.requests += 1;
    if (response.status === 412) {
      await response.arrayBuffer().catch(() => {});
      throw new VersionConflictError('恢复时确认旧偏移所依据的版本已失效', this.etag, response.headers.get('etag'));
    }
    if (response.status !== 206) throw new Error(`版本探测得到意外状态：${response.status}`);
    const etag = response.headers.get('etag');
    if (etag !== this.etag) throw new VersionConflictError('版本探测返回的 ETag 与作业凭据不一致', this.etag, etag);
    // 完整排空响应体，保证连接可以被正常回收。
    await response.arrayBuffer();
    return { etag: this.etag };
  }
}
