import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "アンキシム 在庫管理",
  description: "アンキシム 在庫使用数入力",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body className="bg-gray-50 min-h-screen">{children}</body>
    </html>
  );
}
