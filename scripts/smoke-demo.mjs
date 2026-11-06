// デモモード（?demo）で、事前生成の2案がすぐ表示され、小節ごとの採用ができるかを確かめる。API は呼ばない。
// usage: node scripts/smoke-demo.mjs [http://127.0.0.1:5317] [out/smoke-demo]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const [url = "http://127.0.0.1:5317", outDir = "out/smoke-demo"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`${url}/?demo`);
await page.evaluate(() => localStorage.clear());
await page.reload();
const t0 = Date.now();
await page.click("#demoBtn");
await page.waitForFunction(() => /事前に生成した2案を表示|読み込めません/.test(document.getElementById("status")?.textContent ?? ""));
console.log(`${Date.now() - t0}ms`, await page.textContent("#status"));
console.log("alts:", (await page.textContent("#alts"))?.replace(/\s+/g, " "));
console.log("bars:", (await page.textContent("#barAccept"))?.replace(/\s+/g, " "));
await page.screenshot({ path: `${outDir}/1-demo.png` });
await page.click('[data-bar="0"]');
await page.click('[data-bar="1"]');
await page.keyboard.press("2");
await page.click('[data-bar="3"]');
console.log("after bar accept:", (await page.textContent("#tracks"))?.replace(/\s+/g, " "), "|", (await page.textContent("#alts"))?.replace(/\s+/g, " "));
await page.fill("#reason", "前半は案A のフルートの音の流れ、最後は案B の上がり方が意図に近かった");
await page.click("#close");
console.log("log:", (await page.textContent("#log"))?.replace(/\s+/g, " "));
await page.screenshot({ path: `${outDir}/2-after.png` });
await browser.close();
