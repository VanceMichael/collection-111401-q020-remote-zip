import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

for (const directory of ['src', 'provider', 'scripts', 'test']) {
  const entries = await readdir(directory, { recursive: true });
  for (const name of entries.filter(name => name.endsWith('.mjs'))) {
    const result = spawnSync(process.execPath, ['--check', `${directory}/${name}`], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
console.log('源码检查完成');
