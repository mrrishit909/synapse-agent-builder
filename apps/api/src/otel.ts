// OpenTelemetry tracing: HTTP server spans (picking up the browser's traceparent) and Postgres spans, exported over OTLP/HTTP to
// the collector in docker compose. Loaded before the server only when OTEL_EXPORTER_OTLP_ENDPOINT is set.
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";

const sdk = new NodeSDK({ serviceName: "synapse-api", traceExporter: new OTLPTraceExporter(), instrumentations: [new HttpInstrumentation(), new PgInstrumentation()] });
sdk.start();
process.on("SIGTERM", () => { sdk.shutdown().catch(() => {}); });
