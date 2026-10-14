export interface OfficialLanguageSource {
  id: string;
  language: string;
  title: string;
  url: string;
}

export const OFFICIAL_LANGUAGE_SOURCES: OfficialLanguageSource[] = [
  { id: "python", language: "Python", title: "Python Language Reference", url: "https://docs.python.org/3/reference/" },
  { id: "cpp", language: "C++", title: "WG21 C++ Working Draft", url: "https://eel.is/c++draft/" },
  { id: "rust", language: "Rust", title: "Rust Reference", url: "https://doc.rust-lang.org/reference/" },
];

export interface LanguageRefreshResult { source: OfficialLanguageSource; ok: boolean; detail: string; checkedAt: number; }

/** Check only the allow-listed official sources; never follow arbitrary links. */
export async function refreshOfficialLanguageSources(fetcher: typeof fetch = fetch): Promise<LanguageRefreshResult[]> {
  return Promise.all(OFFICIAL_LANGUAGE_SOURCES.map(async (source) => {
    try {
      const response = await fetcher(source.url, { method: "GET", headers: { Accept: "text/html,text/plain" } });
      return { source, ok: response.ok, detail: response.ok ? `reachable (${response.status})` : `HTTP ${response.status}`, checkedAt: Date.now() };
    } catch (error) {
      return { source, ok: false, detail: error instanceof Error ? error.message : String(error), checkedAt: Date.now() };
    }
  }));
}
