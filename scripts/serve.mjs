import { createProvider } from '../provider/server.mjs';
const provider = await createProvider(Number(process.env.PORT ?? 8080));
console.log('本地来源：' + provider.base);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await provider.close(); process.exit(0); });
