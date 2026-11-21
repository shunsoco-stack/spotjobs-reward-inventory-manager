import type { Metadata, Viewport } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'ワークストック｜報酬と在庫',
  applicationName: 'ワークストック',
  description: '補充・取出を手早く記録。週間報酬の目安、本数ボーナス、早期補充の対象在庫を確認できる、スポットワーク向けの管理アプリです。',
  icons: { icon: [{ url: '/icon.svg', type: 'image/svg+xml' }, { url: '/icon-192.png', sizes: '192x192', type: 'image/png' }], apple: { url: '/icon-180.png', sizes: '180x180' } },
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'ワークストック', statusBarStyle: 'default' },
};
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f7fa' },
    { media: '(prefers-color-scheme: dark)', color: '#101917' },
  ],
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="ja"><body>{children}</body></html>;
}
