export const metadata = {
  title: "AI Command Centre",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: 16 }}>
        <nav style={{ marginBottom: 16 }}>
          <a href="/" style={{ marginRight: 12 }}>
            Overview
          </a>
          <a href="/goals" style={{ marginRight: 12 }}>
            Goals
          </a>
          <a href="/workflows" style={{ marginRight: 12 }}>
            Workflows
          </a>
          <a href="/approvals">Approvals</a>
        </nav>
        {children}
      </body>
    </html>
  );
}
