// DAW としての基本操作（ノートの追加、元に戻す・やり直す、音色・音量・ソロ、WAV 書き出し）を確かめる。API は呼ばない。
// usage: node scripts/smoke-daw.mjs [http://127.0.0.1:5317] [out/smoke-daw]
import { chromium } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";

const [url = "http://127.0.0.1:5317", outDir = "out/smoke-daw"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let failed = 0;
const check = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"} ${msg}`); if (!ok) failed++; };
const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem("ghostnotes.project.v1") ?? "null"));

await page.goto(url);
await page.evaluate(() => localStorage.clear());
await page.reload();

// リードのトラックに1音置く（ピアノロールの左上あたりをクリック）
const box = await page.locator("#roll").boundingBox();
const before = (await stored())?.tracks?.lead?.notes?.length ?? 0;
await page.mouse.click(box.x + 44 + 5, box.y + 10);
const afterAdd = (await stored()).tracks.lead.notes.length;
check(afterAdd === before + 1, `ノートを追加できる（${before} → ${afterAdd}）`);

await page.keyboard.press("Control+z");
check((await stored()).tracks.lead.notes.length === before, "Ctrl+Z で追加を取り消せる");
await page.keyboard.press("Control+Shift+z");
check((await stored()).tracks.lead.notes.length === afterAdd, "Ctrl+Shift+Z でやり直せる");
await page.click("#undo");
check((await stored()).tracks.lead.notes.length === before, "「戻す」ボタンでも取り消せる");
await page.click("#redo");

// 音色・音量・ソロ
const bassRow = page.locator(".track").nth(1);
await bassRow.locator(".preset").selectOption("sub");
check((await stored()).tracks.bass.preset === "sub", "ベースの音色をサブベースに変えられる");
await bassRow.locator(".vol").fill("-6");
await bassRow.locator(".vol").dispatchEvent("change");
check((await stored()).tracks.bass.volume === -6, "ベースの音量を -6 dB にできる");
await bassRow.locator(".solo").click();
check((await stored()).tracks.bass.solo === true, "ベースをソロにできる");
await bassRow.locator(".solo").click();
await page.keyboard.press("Control+z");
check((await stored()).tracks.bass.solo === true, "ソロの切り替えも元に戻せる");
await page.keyboard.press("Control+Shift+z");

// WAV 書き出し
const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.click("#exportWav")]);
const path = `${outDir}/${dl.suggestedFilename()}`;
await dl.saveAs(path);
const b = readFileSync(path);
const ch = b.readUInt16LE(22), sr = b.readUInt32LE(24), dataLen = b.readUInt32LE(40);
const seconds = dataLen / (sr * ch * 2);
let sum = 0, peak = 0;
for (let o = 44; o < b.length; o += 2) { const v = b.readInt16LE(o) / 32768; sum += v * v; peak = Math.max(peak, Math.abs(v)); }
const rms = Math.sqrt(sum / ((b.length - 44) / 2));
const p = await stored();
const expected = (60 / p.bpm) * 4 * p.bars * 2 + 1.5;
check(b.subarray(0, 4).toString() === "RIFF" && Math.abs(seconds - expected) < 0.05, `WAV を書き出せる（${seconds.toFixed(2)} 秒、期待 ${expected.toFixed(2)} 秒）`);
check(rms > 0.01 && peak < 1, `書き出した音が無音でも割れてもいない（RMS ${rms.toFixed(3)}、ピーク ${peak.toFixed(2)}）`);
// 8小節に伸ばすと、WAV も2倍の長さになる
await page.selectOption("#bars", "8");
check((await stored()).bars === 8, "ループを8小節にできる");
const [dl8] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.click("#exportWav")]);
const p8 = `${outDir}/8bars-${dl8.suggestedFilename()}`;
await dl8.saveAs(p8);
const b8 = readFileSync(p8);
const sec8 = b8.readUInt32LE(40) / (b8.readUInt32LE(24) * b8.readUInt16LE(22) * 2);
const exp8 = (60 / p.bpm) * 4 * 8 * 2 + 1.5;
check(Math.abs(sec8 - exp8) < 0.05, `8小節の WAV の長さ（${sec8.toFixed(2)} 秒、期待 ${exp8.toFixed(2)} 秒）`);
await page.keyboard.press("Control+z");
check((await stored()).bars === 4, "小節数の変更も元に戻せる");
await page.screenshot({ path: `${outDir}/daw.png` });
check(errors.length === 0, `ページのエラーなし${errors.length ? `: ${errors.join(" / ")}` : ""}`);
await browser.close();
process.exit(failed ? 1 : 0);
