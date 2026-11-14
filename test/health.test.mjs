import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createProvider } from '../provider/server.mjs';

test('标准健康检查保留原端点并报告当前来源版本', { timeout: 10000 }, async () => {
  const provider = await createProvider();
  try {
    for (const path of ['/health', '/_health']) {
      const response = await fetch(provider.base + path);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /application\/json/);
      assert.deepEqual(await response.json(), { service: 'local-source', generation: provider.state.generation });
    }
    const generation = provider.state.generation + 1;
    const changed = await fetch(provider.base + '/_control', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ generation })
    });
    assert.equal(changed.status, 200);
    assert.equal((await (await fetch(provider.base + '/health')).json()).generation, generation);
    assert.equal((await fetch(provider.base + '/missing-health-route')).status, 404);
  } finally {
    await provider.close();
  }
});

test('真实启动入口遵循 PORT 并可用标准路径探测', { timeout: 10000 }, async () => {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 8000);
  const child = spawn(process.execPath, ['scripts/serve.mjs'], {
    cwd: new URL('../', import.meta.url), env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'], signal: controller.signal
  });
  const exit = once(child, 'exit');
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', data => { stderr += data; });
  try {
    let output = '';
    let base;
    for await (const chunk of child.stdout) {
      output += chunk.toString();
      const address = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (address) { base = address[0]; break; }
    }
    assert.ok(base, '服务未打印监听地址：' + stderr);
    assert.ok(Number(new URL(base).port) > 0);
    const response = await fetch(base + '/health', { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).service, 'local-source');
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const [code, signal] = await exit;
    assert.equal(signal, null);
    assert.equal(code, 0, stderr);
  }
});
