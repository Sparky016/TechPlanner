import type { ReactNode } from 'react';

export const metadata = { title: 'Tech Planner' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
