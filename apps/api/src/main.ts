// Entry point: optional OpenTelemetry, migrations + seed when asked, then serve.
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) await import("./otel.ts");
const { migrate } = await import("./migrate.ts");
const { seed } = await import("./seed.ts");
const { build } = await import("./server.ts");

if (process.env.MIGRATE_ON_START === "1") { await migrate(); await seed(); }
const app = await build({ rateLimit: process.env.RATE_LIMIT ? Number(process.env.RATE_LIMIT) : undefined });
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 8440) });
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => app.close().then(() => process.exit(0)));
