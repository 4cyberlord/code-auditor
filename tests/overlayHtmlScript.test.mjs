import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'

const source = readFileSync(new URL('../src-tauri/src/bin/mds.rs', import.meta.url), 'utf8')
for (const [name, functionName] of [['overlay', 'overlay_html'], ['command HUD', 'hud_html']]) {
  const html = source.match(new RegExp(`fn ${functionName}\\(\\) -> &'static str \\{\\s*r#"([\\s\\S]*?)"#`))?.[1]
  assert.ok(html, `the helper must contain the ${name} HTML`)
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  assert.equal(scripts.length, 1, `${name} must have one complete inline script`)
  assert.doesNotThrow(() => new Script(scripts[0][1], { filename: `${functionName}-inline.js` }))
}

console.log('overlay and command HUD inline scripts parse')
