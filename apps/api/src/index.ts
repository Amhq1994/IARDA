import { buildServer } from "./server.ts";
import { config } from "./config.ts";

const app = await buildServer({ logger: true });
await app.listen({ port: config.port, host: config.host });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => { await app.close(); process.exit(0); });
}
