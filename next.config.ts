import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['node-pty'],
  allowedDevOrigins: ['192.0.2.10', '100.x.y.z', '198.18.0.1'],
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
