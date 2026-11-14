import { createProvider } from '../provider/server.mjs';
import { receiveCurrent } from '../src/domain.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = await mkdtemp(join(tmpdir(), 'collection-'));
const provider = await createProvider();
try {
 const result = await receiveCurrent(provider.base, directory);
 console.log(JSON.stringify({ service: 'remote-zip', result, requests: provider.audit }, null, 2));
} finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
