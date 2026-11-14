import { capture } from './client.mjs';
export async function receiveCurrent(base, directory) {
 const { bytes, receipt } = await capture(base + '/delivery', directory);
 const data = JSON.parse(bytes);
 return { receipt: receipt.id, delivery: data.delivery, edition: data.edition, authorized: data.authorized, address: data.href };
}
