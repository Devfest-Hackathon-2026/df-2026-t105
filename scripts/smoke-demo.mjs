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
await page.waitForFunction(() => /事前に生成した2案|読み込めません/.test(document.getElementById("status")?.textContent ?? ""));
console.log(`${Date.now() - t0}ms`, await page.textContent("#status"));
console.log("alts:", (await page.textContent("#alts"))?.replace(/\s+/g, " "));
console.log("takes:", await page.locator(".take-lane").count(), "lanes,", await page.locator(".take-bar").count(), "bars");
const leadNotes = () => page.evaluate(() => JSON.parse(localStorage.getItem("ghostnotes.project.v1")).tracks.lead.notes.length);
// テイクのレーン: 案A の1・2小節目と、案B の4小節目を取り込む（コンピング）
await page.click('.take-bar[data-take="0"][data-bar="0"]');
await page.click('.take-bar[data-take="0"][data-bar="1"]');
await page.click('.take-bar[data-take="1"][data-bar="3"]');
const afterComp = await leadNotes();
console.log("comped lead notes:", afterComp, "| pressed:", await page.locator('.take-bar[aria-pressed="true"]').count());
// もう一度押すと元に戻る
await page.click('.take-bar[data-take="1"][data-bar="3"]');
const afterUncomp = await leadNotes();
console.log("after un-comp bar 4:", afterUncomp, "| pressed:", await page.locator('.take-bar[aria-pressed="true"]').count());
await page.click('.take-bar[data-take="1"][data-bar="3"]');
console.log("after re-comp:", await leadNotes(), "| alts:", (await page.textContent("#alts"))?.replace(/\s+/g, " "));
await page.fill("#reason", "前半は案A のフルートの音の流れ、最後は案B の上がり方が意図に近かった");
await page.click("#close");
console.log("log:", (await page.textContent("#log"))?.replace(/\s+/g, " "));
await page.screenshot({ path: `${outDir}/2-after.png` });
// 採用した音を MIDI に書き出す
const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#exportMidi")]);
const path = `${outDir}/${dl.suggestedFilename()}`;
await dl.saveAs(path);
const { readFileSync } = await import("node:fs");
const b = readFileSync(path);
const noteOns = [...b].filter((x, i) => (x & 0xf0) === 0x90 && i > 14).length;
console.log("midi:", dl.suggestedFilename(), b.length, "bytes", b.subarray(0, 4).toString(), "ntrks", b.readUInt16BE(10), "note-on bytes ~", noteOns);
await browser.close();
