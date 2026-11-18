import type { NextConfig } from 'next';
import { dirname, resolve } from 'node:path';

const enableSync = process.env.NEXT_PUBLIC_ENABLE_SYNC === '1';
const root = process.cwd();
const syncHost = resolve(root, 'src/components/sync-host.ts');
const syncHostStub = resolve(root, 'src/components/sync-host-stub.ts');
const privacyContent = resolve(root, 'src/app/privacy/content.tsx');
const privacySync = resolve(root, 'src/app/privacy/content-with-sync.tsx');
const supportContent = resolve(root, 'src/app/support/content.tsx');
const supportSync = resolve(root, 'src/app/support/content-with-sync.tsx');

const nextConfig: NextConfig = {
  output: 'export',
  poweredByHeader: false,
  images: { unoptimized: true },
  turbopack: {
    root: dirname(require.resolve('next/package.json')).replace(/[\\/]node_modules[\\/]next$/, ''),
    resolveAlias: {
      ...(!enableSync ? { '@/components/sync-host': './src/components/sync-host-stub.ts' } : {}),
      ...(enableSync ? {
        '@/app/privacy/content': './src/app/privacy/content-with-sync.tsx',
        '@/app/support/content': './src/app/support/content-with-sync.tsx',
      } : {}),
    },
  },
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      ...(!enableSync ? {
        [syncHost]: syncHostStub,
        '@/components/sync-host': syncHostStub,
      } : {
        [privacyContent]: privacySync,
        [supportContent]: supportSync,
      }),
    };
    return config;
  },
};

export default nextConfig;
