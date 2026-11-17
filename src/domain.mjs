import { capture } from './client.mjs';
import { collectMembers } from './remotemembers.mjs';

export async function receiveCurrent(base, directory) {
 const { bytes, receipt } = await capture(base + '/delivery', directory);
 const data = JSON.parse(bytes);
 return { receipt: receipt.id, delivery: data.delivery, edition: data.edition, authorized: data.authorized, address: data.href };
}

// 领取授权清单指定的压缩包成员：先收存交付说明，再按目录范围领取并校验成员
export async function receiveAuthorized(base, directory, options = {}) {
  const { bytes, receipt } = await capture(base + '/delivery', directory);
  const data = JSON.parse(bytes);
  const authorized = (data.authorized ?? [])
    .map(entry => entry?.name)
    .filter(name => typeof name === 'string' && name.length > 0);
  const report = await collectMembers({
    url: new URL(data.href, base).href,
    authorized,
    tailLimit: data.tailLimit,
    directory,
    edition: data.edition ?? null,
    deliveryReceipt: receipt.id,
    fetchImpl: options.fetchImpl,
  });
  return { delivery: receipt.id, documents: data.delivery ?? null, ...report };
}
