import type { ReactNode } from "react";

export type SettingsGlyphName =
  | "overview" | "connections" | "council" | "vision" | "capture"
  | "appearance" | "limits" | "sessions" | "updates" | "search"
  | "close" | "chevron" | "cloud" | "keyboard" | "check" | "shield";

const strokes: Record<SettingsGlyphName, ReactNode> = {
  overview: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  connections: <><path d="M8 3v4M16 3v4M7 7h10v5a5 5 0 0 1-10 0V7Z" /><path d="M12 17v4" /></>,
  council: <><path d="M12 3v3m-7 5H3m18 0h-2M7 17l-2 2m12-2 2 2" /><path d="M8 7a4 4 0 0 1 8 0c2 0 3 2 3 4s-1.5 3-3 3.5V18a2 2 0 0 1-4 0V8m0 8a2 2 0 0 1-4 0v-1.5C6 14 5 13 5 11s1-4 3-4Z" /></>,
  vision: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
  capture: <><path d="M4 8V5a2 2 0 0 1 2-2h3m6 0h3a2 2 0 0 1 2 2v3m0 8v3a2 2 0 0 1-2 2h-3m-6 0H6a2 2 0 0 1-2-2v-3" /><rect x="8" y="8" width="8" height="8" rx="2" /></>,
  appearance: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></>,
  limits: <><path d="M4.5 18.5a9 9 0 1 1 15 0" /><path d="m12 13 4-5M8 19h8" /><circle cx="12" cy="13" r="1" /></>,
  sessions: <><rect x="4" y="10" width="16" height="12" rx="2" /><path d="M8 10V7a4 4 0 1 1 8 0v3" /><circle cx="12" cy="16" r="1" /></>,
  updates: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.5 9a7 7 0 0 1 12-2L20 12M4 12l2.5 5a7 7 0 0 0 12-2" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  close: <path d="M5 5 19 19M19 5 5 19" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  cloud: <path d="M20 17.5a4.5 4.5 0 0 0-2-8.5A6 6 0 0 0 6.5 11 3.5 3.5 0 0 0 7 18h12" />,
  keyboard: <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10" /></>,
  check: <path d="m4 12 5 5L20 6" />,
  shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></>,
};

export default function SettingsGlyph({
  name, size = 18,
}: { name: SettingsGlyphName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {strokes[name]}
    </svg>
  );
}
