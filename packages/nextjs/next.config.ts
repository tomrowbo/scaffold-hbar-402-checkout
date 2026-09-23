import type { NextConfig } from "next";
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);
const { ProvidePlugin } = nodeRequire("webpack") as {
  ProvidePlugin: new (definitions: Record<string, string[]>) => unknown;
};

const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  transpilePackages: ["@hashgraph/hedera-wallet-connect", "@scaffold-hbar-ui/components"],
  typescript: {
    ignoreBuildErrors: process.env.NEXT_PUBLIC_IGNORE_BUILD_ERROR === "true",
  },
  eslint: {
    ignoreDuringBuilds: process.env.NEXT_PUBLIC_IGNORE_BUILD_ERROR === "true",
  },
  // `/openapi.json` and `/llms.txt` are the conventional, dot-bearing paths MPP discovery and
  // agent tooling expect. Next.js's app-paths manifest silently drops route segments named
  // like a metadata-file convention (`name.ext`), so the handlers live at extension-free
  // paths (`/api/openapi`, `/api/llms`) and are rewritten to their conventional URLs here.
  async rewrites() {
    return [
      { source: "/openapi.json", destination: "/api/openapi" },
      { source: "/llms.txt", destination: "/api/llms" },
    ];
  },
  webpack: (config, { dev, isServer }) => {
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      porto: false,
      "porto/internal": false,
      // mppx dynamically imports the MCP SDK from its compose() path to raise MCP-shaped
      // payment errors. This storefront only uses the HTTP transport, and the SDK is an
      // optional peer, so stub it out rather than pulling it into the bundle.
      "@modelcontextprotocol/sdk/types.js": false,
    };

    config.resolve.fallback = {
      ...(config.resolve.fallback ?? {}),
      fs: false,
      net: false,
      tls: false,
      crypto: nodeRequire.resolve("crypto-browserify"),
      stream: nodeRequire.resolve("stream-browserify"),
      buffer: nodeRequire.resolve("buffer"),
      util: nodeRequire.resolve("util"),
      assert: nodeRequire.resolve("assert"),
      process: nodeRequire.resolve("process/browser"),
    };

    config.plugins.push(
      new ProvidePlugin({
        Buffer: ["buffer", "Buffer"],
        process: ["process"],
      }),
    );

    config.externals.push("pino-pretty", "lokijs", "encoding");
    if (isServer) {
      config.externals.push("@walletconnect/modal");
    }

    config.ignoreWarnings = [
      ...(config.ignoreWarnings ?? []),
      {
        module: /node_modules\/@reown\/appkit\/node_modules\/ox/,
        message: /Critical dependency/,
      },
    ];

    if (dev) {
      config.watchOptions = {
        followSymlinks: true,
      };
      config.snapshot = {
        ...config.snapshot,
        managedPaths: [],
      };
    }
    return config;
  },
};

export default nextConfig;
