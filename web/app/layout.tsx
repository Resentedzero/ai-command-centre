import { JetBrains_Mono, Pixelify_Sans } from "next/font/google";
import type { ReactNode } from "react";
import { LiveProvider } from "../components/live";
import { PreferencesProvider } from "../components/preferences";
import { NoticeStrip } from "../components/pixel/NoticeStrip";
import { PixelTopBar } from "../components/pixel/PixelTopBar";
import { KeeperDock, KeeperPanel, KeeperProvider } from "../components/keeper/Keeper";
import { RoleIconsProvider } from "../components/agents/RoleIcon";
import "./tokens.css";

// D4 as amended by D19: Pixelify Sans for titles, labels and buttons; JetBrains Mono for values and long reading.
const pixel = Pixelify_Sans({ subsets: ["latin"], variable: "--font-pixel" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata = {
  title: "AI Command Centre",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${pixel.variable} ${mono.variable}`}>
      <body>
        <PreferencesProvider>
          <LiveProvider>
          <RoleIconsProvider>
            <KeeperProvider>
              <PixelTopBar />
              {children}
              <NoticeStrip />
              <KeeperDock />
              <KeeperPanel />
            </KeeperProvider>
          </RoleIconsProvider>
        </LiveProvider>
        </PreferencesProvider>
      </body>
    </html>
  );
}
