import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['node-pty'],
  allowedDevOrigins: ['127.0.0.1', 'localhost', '192.0.2.10', '100.x.y.z', '198.18.0.1'],
  async headers() {
    return [
      {
        // Pages and API stay uncacheable — the URL can carry a token and the
        // history payload changes constantly.
        source: '/((?!_next/static/).*)',
        headers: [
          { key: 'Cache-Control', value: 'no-store, must-revalidate' },
        ],
      },
      {
        // Build output is content-hashed: a change ships a new filename, so it
        // is safe to cache hard. Under the old catch-all `no-store` every cold
        // start re-downloaded ~250KB of JS through the tunnel — the single
        // biggest cost of opening the app on a phone.
        source: '/_next/static/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
    ];
  },
};

export default nextConfig;
