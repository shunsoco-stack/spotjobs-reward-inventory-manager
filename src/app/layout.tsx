import type { Metadata, Viewport } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'SPOTJOBS報酬・在庫管理アプリ',
  applicationName: 'SPOTJOBS報酬・在庫管理アプリ',
  description: '補充・抜き取りを手早く記録。週間報酬の目安、本数ボーナス、早期補充の対象在庫を確認できる、SPOTJOBSワーカー向けの非公式管理アプリです。',
  icons: { icon: [{ url: '/icon.svg', type: 'image/svg+xml' }, { url: '/icon-192.png', sizes: '192x192', type: 'image/png' }], apple: { url: '/icon-180.png', sizes: '180x180' } },
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'SPOTJOBS管理', statusBarStyle: 'default' },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#f5f7fa' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="ja"><body>{children}</body></html>;
}
