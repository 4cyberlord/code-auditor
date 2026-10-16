import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const settings = readFileSync(new URL("../src/components/SettingsDialog.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
const icons = readFileSync(new URL("../src/components/SettingsGlyph.tsx", import.meta.url), "utf8");

for (const id of ["overview", "api", "council", "reading", "capture", "appearance", "limits", "sessions", "updates"]) {
  assert.match(settings, new RegExp('id: "' + id + '"'), "Missing setting navigation section: " + id);
}
for (const component of ["GatewayCard", "CodingSettingsCard", "ProviderCard", "CouncilCard", "ReadingCard", "CaptureCard", "AppearanceCard", "UpdateCard", "AccountCard", "StorageCard", "TimeZoneCard"]) {
  assert.ok(new RegExp("<" + component + "(?:\\s|/|>)").test(settings),
    "Missing original rendered settings panel: " + component);
}
assert.match(settings, /title="Unlock API settings"[\s\S]*?<GatewayCard\s*\/>/);
assert.match(settings, /title="Unlock account settings"[\s\S]*?<AccountCard\s*\/>/);
assert.match(settings, /await authReauthenticate\(pin\)/, "PIN reauthentication may not be removed");
assert.match(settings, /patch\(\{ maxTokens: Number\(tokenDraft\) \}\)/, "Token setting persistence lost");
assert.match(settings, /patch\(\{ gatewayPerMinute: Number\(rateDraft\) \}\)/, "Rate setting persistence lost");
assert.match(settings, /ref=\{searchRef\}/);
assert.match(settings, /e\.metaKey \|\| e\.ctrlKey/);
assert.match(settings, /aria-modal="true"/);
assert.match(settings, /aria-label="Settings navigation"/);
assert.match(settings, /aria-current=\{tab === item\.id \? "page" : undefined\}/);
assert.match(settings, /sandbox templates, standby capacity and port recovery are server-managed/i);
assert.match(settings, /<SettingsGlyph name=\{item\.icon\}/);
assert.match(styles, /\.modal\.settings-workspace\s*\{/);
assert.match(styles, /\.settings-workspace-sidebar\s*\{/);
assert.match(styles, /@media \(max-width: 650px\)/);
assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
assert.doesNotMatch(styles.slice(styles.indexOf("Council Editor Settings Control Center")), /\.overlay-|\.coding-overlay/, "Scoped CSS must not modify overlay");
assert.match(icons, /aria-hidden="true"/);
console.log("PASS: Settings control center navigation, existing panels, PIN security, persistence, responsive isolation");
