import type { Metadata } from "next";
import "./globals.css";
import ThemeProvider from "@/components/ThemeProvider";

export const metadata: Metadata = {
  title: "Council Editor 0.1.0",
  description: "Independent multi-model solving, benchmarking, and consensus.",
};

const THEME_SCRIPT = `
(function() {
  try {
    var raw = localStorage.getItem("code-auditor.settings.v1");
    var theme = "system";
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && (parsed.theme === "light" || parsed.theme === "dark" || parsed.theme === "system")) {
        theme = parsed.theme;
      }
    }
    var resolved = theme;
    if (theme === "system") {
      resolved = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    document.documentElement.setAttribute("data-theme", resolved);
    document.documentElement.setAttribute("data-theme-setting", theme);
    document.documentElement.style.colorScheme = resolved;
  } catch (e) {}
})();
`;

/**
 * The last-resort dismissal for the boot screen.
 *
 * `BootScreen` removes it the moment the app is ready, which is the normal
 * path. This exists for the one that is not: if the bundle fails to hydrate,
 * an unremovable overlay would hide the error underneath it. Ten seconds is
 * far longer than a healthy start and far shorter than a person's patience.
 */
const BOOT_FAILSAFE = `
(function() {
  setTimeout(function () {
    var el = document.getElementById("boot");
    if (el) el.setAttribute("data-done", "true");
  }, 10000);
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: BOOT_FAILSAFE }} />
      </head>
      <body>
        {/* Painted by the server, in the markup, before a single byte of React
            arrives — which is the only way to fill the second where the window
            is open and nothing has mounted yet. It used to be a dark rectangle
            with nothing in it, which reads as a hang rather than a start.

            `BootScreen` fades it once the app has state worth showing, and the
            inline script below does the same after a delay, so a failure to
            hydrate cannot leave it stuck over a working app. */}
        <div id="boot" aria-hidden="true">
          <div className="boot-inner">
            <div className="boot-mark" aria-hidden="true">
              <span /><span /><span /><span />
            </div>
            <p className="boot-name">Council Editor 0.1.0</p>
            <p className="boot-note">Starting up…</p>
          </div>
        </div>
        <ThemeProvider />
        {children}
      </body>
    </html>
  );
}
