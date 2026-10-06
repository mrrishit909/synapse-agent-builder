import type { NextConfig } from "next";

// Static export: the public sandbox is plain files (GitHub Pages under /projects/synapse-agent-builder/demo, or nginx in Docker).
const config: NextConfig = {
  output: "export",
  basePath: process.env.NEXT_PUBLIC_BASE_PATH ?? "",
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ["@synapse/domain", "@synapse/motion", "@synapse/telemetry", "@synapse/sdk"],
  typescript: { ignoreBuildErrors: true }, // type-checked separately by `npm run typecheck`
};
export default config;
