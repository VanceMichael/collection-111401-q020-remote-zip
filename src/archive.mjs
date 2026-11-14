import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export class Archive {
  constructor(root) { this.root = root; }

  async save(bytes, source) {
    const digest = sha256(bytes);
    const objects = join(this.root, 'objects');
    const receipts = join(this.root, 'receipts');
    await mkdir(objects, { recursive: true });
    await mkdir(receipts, { recursive: true });
    const temporary = join(objects, '.' + randomUUID());
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, join(objects, digest));
    await syncDirectory(objects);
    const receipt = { id: randomUUID(), digest, size: bytes.length, source };
    const receiptPath = join(receipts, receipt.id + '.json');
    const staging = receiptPath + '.pending';
    const record = await open(staging, 'wx', 0o600);
    try {
      await record.writeFile(JSON.stringify(receipt));
      await record.sync();
    } finally { await record.close(); }
    await rename(staging, receiptPath);
    await syncDirectory(receipts);
    return receipt;
  }

  async read(receipt) {
    if (!/^[a-f0-9]{64}$/.test(receipt.digest)) throw new Error('内容标识无效');
    const bytes = await readFile(join(this.root, 'objects', receipt.digest));
    if (sha256(bytes) !== receipt.digest || bytes.length !== receipt.size) throw new Error('已存内容校验不符');
    return bytes;
  }

  async list() {
    let names;
    try { names = await readdir(join(this.root, 'receipts')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return Promise.all(names.filter(name => name.endsWith('.json')).sort().map(async name =>
      JSON.parse(await readFile(join(this.root, 'receipts', name), 'utf8'))));
  }
}

async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
