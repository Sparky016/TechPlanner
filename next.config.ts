import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Self-contained server (.next/standalone) for the production Docker image (task 38).
  output: 'standalone',
};

export default nextConfig;
