// Verify production SF3 worklet output, SF3 WAV export, single-candidate UI, and responsive layout.
import { chromium } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
const url = process.argv[2] ?? "http://127.0.0.1:8788";
const out = "out/smoke-soundfont";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
try {
 const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
 const errors = [];
 page.on("pageerror", (e) => errors.push(e.message));
 await page.addInitScript(() => {
   window.__sfAnalysers = [];
   const Original = window.AudioWorkletNode;
   window.AudioWorkletNode = class extends Original {
     constructor(ctx, name, opts) {
       super(ctx, name, opts);
       const analyser = ctx.createAnalyser();
       this.connect(analyser);
       window.__sfAnalysers.push(analyser);
     }
   };
 });
 await page.goto(url);
 await page.evaluate(() => localStorage.clear());
 await page.reload();
 assert.equal(await page.inputValue("#candidateCount"), "1");
 await page.locator(".settings summary").click();
 await page.selectOption("#candidateCount", "2");
 await page.selectOption("#transcriber", "a100");
 await page.reload();
 assert.equal(await page.inputValue("#candidateCount"), "2");
 assert.equal(await page.inputValue("#transcriber"), "a100");
 await page.click("#play");
 await page.waitForFunction(() => document.querySelector("#play")?.getAttribute("aria-pressed") === "true", { timeout: 60000 });
 let peak = 0;
 for (let i = 0; i < 12; i++) {
   peak = Math.max(peak, await page.evaluate(() => Math.max(0, ...window.__sfAnalysers.map((a) => { const x = new Float32Array(a.fftSize); a.getFloatTimeDomainData(x); return Math.max(...x.map(Math.abs)); }))));
   await page.waitForTimeout(100);
 }
 assert(peak > 0.001, `SoundFont worklet must produce sound, peak=${peak}`);
 console.log(`PASS SoundFont playback peak=${peak.toFixed(3)}`);
 await page.click("#play");
 await page.waitForTimeout(250);
 assert.equal(await page.getAttribute("#play", "aria-pressed"), "false");
 const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.click("#exportWav")]);
 await download.saveAs(`${out}/soundfont.wav`);
 const wav = readFileSync(`${out}/soundfont.wav`);
 let sum = 0, max = 0;
 for (let i = 44; i < wav.length; i += 2) { const v = wav.readInt16LE(i) / 32768; sum += v * v; max = Math.max(max, Math.abs(v)); }
 const rms = Math.sqrt(sum / ((wav.length - 44) / 2));
 assert(rms > 0.001 && max < 1, `WAV rms=${rms}, peak=${max}`);
 console.log(`PASS SoundFont WAV rms=${rms.toFixed(3)}, peak=${max.toFixed(3)}`);
 for (const theme of ["light", "dark"]) {
   await page.emulateMedia({ colorScheme: theme });
   for (const width of [1440, 768, 390]) {
     await page.setViewportSize({ width, height: 900 });
     await page.screenshot({ path: `${out}/${theme}-${width}.png`, fullPage: true });
     assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `overflow: ${width}`);
   }
 }
 assert.deepEqual(errors, []);
 console.log("PASS settings persist, 1 candidate default, both themes, 3 widths, no page errors");
} finally { await browser.close(); }
