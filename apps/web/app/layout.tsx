import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SYNAPSE · agent workflow builder",
  description: "Visual, observable multi-agent workflow builder: build a support agent on a spatial canvas, watch its trace move through the graph, swap models and gate the release. Simulated providers.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#03050a" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
