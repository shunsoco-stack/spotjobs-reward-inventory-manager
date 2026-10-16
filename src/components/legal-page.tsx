import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import styles from "./legal-page.module.css";

interface LegalPageProps {
  current: "privacy" | "support";
  eyebrow: string;
  title: string;
  description: string;
  updated?: string;
  children: ReactNode;
}

export function LegalPage({ current, eyebrow, title, description, updated, children }: LegalPageProps) {
  return <div className={styles.page}>
    <a className={styles.skipLink} href="#main-content">本文へ移動</a>
    <header className={styles.header}>
      <div className={styles.headerInner}>
        <Link className={styles.brand} href="/" prefetch={false} aria-label="SPOTJOBS報酬・在庫管理アプリのホームへ">
          <Image src="/icon.svg" width={38} height={38} alt="" priority />
          <span>SPOTJOBS報酬・在庫管理アプリ</span>
        </Link>
        <nav className={styles.nav} aria-label="情報ページ">
          <a href="/privacy.html" aria-current={current === "privacy" ? "page" : undefined}>プライバシー</a>
          <a href="/support.html" aria-current={current === "support" ? "page" : undefined}>サポート</a>
        </nav>
      </div>
    </header>
    <main className={styles.main} id="main-content">
      <Link className={styles.backLink} href="/" prefetch={false}>← アプリへ戻る</Link>
      <div className={styles.hero}>
        <p className={styles.eyebrow}>{eyebrow}</p>
        <h1>{title}</h1>
        <p className={styles.lead}>{description}</p>
        {updated && <p className={styles.updated}>最終更新日：{updated}</p>}
      </div>
      <div className={styles.content}>{children}</div>
    </main>
    <footer className={styles.footer}>
      <nav className={styles.footerLinks} aria-label="フッターナビゲーション">
        <Link href="/" prefetch={false}>アプリ</Link>
        <a href="/privacy.html">プライバシーポリシー</a>
        <a href="/support.html">サポート</a>
      </nav>
      <p>個人制作の非公式管理ツールです。SPOTJOBS、ChargeSPOT、株式会社INFORICHとの提携・関係はありません。</p>
    </footer>
  </div>;
}

export { styles as legalPageStyles };
