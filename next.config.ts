import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['node-pty'],
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Cache-Control', value: 'no-store, must-revalidate' },
        ],
      },
    ];
  },
};

export default nextConfig;
