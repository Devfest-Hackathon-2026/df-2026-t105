// ブラウザで「意図を書く → Lyria → 耳コピ → ゴースト表示」まで通るかを確かめる。
// usage: node --env-file=.env scripts/smoke.mjs http://127.0.0.1:5317 out/smoke
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const [url = "http://127.0.0.1:5317", outDir = "out/smoke"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log(`[${m.type()}]`, m.text().slice(0, 300)); });
page.on("pageerror", (e) => console.log("[pageerror]", e.message, (e.stack ?? "").split("\n").slice(0, 6).join(" | ")));

await page.goto(url);
// SMOKE_DIRECT=1 のときだけブラウザにキーを入れる。既定は中継サーバー経由
if (process.env.SMOKE_DIRECT === "1") {
  await page.fill("#apiKey", process.env.GEMINI_API_KEY);
  await page.dispatchEvent("#apiKey", "change");
}
await page.screenshot({ path: `${outDir}/0-initial.png` });

await page.selectOption("#target", "lead");
await page.fill("#intent", "ベースに寄り添う、少し切ないメロディ。最後の小節で上がって終わりたい");
await page.uncheck("#monitor");
const t0 = Date.now();
await page.click("#ask");
let last = "";
const deadline = Date.now() + 240_000;
while (Date.now() < deadline) {
  const s = await page.textContent("#status");
  if (s !== last) { console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`, s); last = s; }
  if (/クリックで1音ずつ採用|できませんでした|error|Error/.test(s ?? "")) break;
  await page.waitForTimeout(500);
}
await page.screenshot({ path: `${outDir}/1-ghost.png` });
await page.screenshot({ path: `${outDir}/1b-ghost-full.png`, fullPage: true });
// 案B に切り替えて見る
if (await page.locator('[data-alt="1"]').count()) {
  await page.click('[data-alt="1"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${outDir}/1c-alt-b.png`, fullPage: true });
  console.log("alts:", (await page.textContent("#alts"))?.replace(/\s+/g, " "));
}
// 拾う音の量を減らす → 全部採用 → 理由を残して閉じる
await page.locator("#sens").fill("35");
console.log("after slider:", await page.textContent("#ghostSummary"));
await page.keyboard.press("Tab").catch(() => {});
await page.click("#acceptAll").catch(() => {});
await page.fill("#reason", "2小節の繰り返しが分かりやすかったので採用");
await page.click("#close");
await page.click("#play");
await page.waitForTimeout(1500);
await page.screenshot({ path: `${outDir}/2-accepted.png`, fullPage: true });
console.log("tracks:", (await page.textContent("#tracks"))?.replace(/\s+/g, " "));
console.log("log:", (await page.textContent("#log"))?.replace(/\s+/g, " "));
console.log("ghost panel:", (await page.textContent("#ghost"))?.replace(/\s+/g, " ").slice(0, 900));
await browser.close();
