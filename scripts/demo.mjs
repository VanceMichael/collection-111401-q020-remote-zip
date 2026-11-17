import { createProvider } from '../provider/server.mjs';
import { receiveAuthorized } from '../src/domain.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = await mkdtemp(join(tmpdir(), 'collection-'));
const provider = await createProvider();
try {
 const result = await receiveAuthorized(provider.base, directory);
 console.log(JSON.stringify({ service: 'remote-zip', result, requests: provider.audit, transferred: provider.state.transferred ?? 0 }, null, 2));
} finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
