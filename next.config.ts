import type { NextConfig } from 'next';
import { dirname } from 'node:path';
const nextConfig: NextConfig = {
  output: 'export',
  poweredByHeader: false,
  images: { unoptimized: true },
  turbopack: { root: dirname(require.resolve('next/package.json')).replace(/[\\/]node_modules[\\/]next$/, '') },
};
export default nextConfig;
