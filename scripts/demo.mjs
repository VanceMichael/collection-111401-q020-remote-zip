import { createProvider } from '../provider/server.mjs';
import { receiveAuthorizedMembers } from '../src/domain.mjs';
import { Archive } from '../src/archive.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'collection-'));
const provider = await createProvider();
try {
  const result = await receiveAuthorizedMembers(provider.base, directory);
  const archive = new Archive(directory);
  const receipts = await archive.list();
  const contents = {};
  for (const member of result.members.filter(item => item.status === 'obtained')) {
    const receipt = receipts.find(item => item.id === member.receipt.id);
    contents[member.name] = (await archive.read(receipt)).toString('utf8');
  }
  console.log(JSON.stringify({
    service: 'remote-zip',
    result,
    obtainedContents: contents,
    rangeRequests: provider.audit.filter(item => item.path === '/all.zip').length,
    transferredBytes: provider.state.transferred ?? 0,
  }, null, 2));
} finally {
  await provider.close();
  await rm(directory, { recursive: true, force: true });
}
