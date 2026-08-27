"use client";

import { useEffect } from "react";
import { useStore } from "@/lib/store";

/**
 * ThemeProvider: Synchronizes application theme with user settings and system preferences.
 * Supports:
 * - "system": dynamically follows OS light/dark changes in real time
 * - "light": forces light mode
 * - "dark": forces dark mode
 */
export default function ThemeProvider() {
  const theme = useStore((s) => s.settings.theme || "system");

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    const applyTheme = () => {
      let resolved: "light" | "dark";
      if (theme === "system") {
        resolved = media.matches ? "dark" : "light";
      } else {
        resolved = theme;
      }

      root.setAttribute("data-theme", resolved);
      root.setAttribute("data-theme-setting", theme);
      root.style.colorScheme = resolved;
    };

    applyTheme();

    if (theme === "system") {
      const listener = () => applyTheme();
      if (typeof media.addEventListener === "function") {
        media.addEventListener("change", listener);
        return () => media.removeEventListener("change", listener);
      } else if (typeof media.addListener === "function") {
        // Fallback for older browsers / webviews
        media.addListener(listener);
        return () => media.removeListener(listener);
      }
    }
  }, [theme]);

  return null;
}
