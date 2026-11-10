import {editorProject} from "./fixtures/editor-project.mjs";
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
await page.evaluate(p=>localStorage.setItem("ghostnotes.project.v1",JSON.stringify(p)),editorProject());
await page.reload();

// リードのトラックに1音置く（ピアノロールの左上あたりをクリック）
const box = await page.locator("#roll").boundingBox();
const before = (await stored())?.tracks?.lead?.notes?.length ?? 0;
await page.mouse.click(box.x + 112 + 5, box.y + 22 + 6); // 鍵盤（112px）と目盛り（22px）の内側
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
// Move to empty space and add material; the song extent follows without a length setting.
await page.fill('#viewStart','8');await page.locator('#viewStart').press('Tab');
await page.click('.track-name:has-text("Lead")');
const late=await page.locator('#roll').boundingBox();
await page.mouse.click(late.x+112+5,late.y+22+6);
check((await stored()).bars===8,"空の8小節目へ音符を置くと曲が伸びる");
await page.keyboard.press('Control+z');
check((await stored()).bars===p.bars,"元に戻すと内容に合わせて曲の長さも戻る");
await page.screenshot({ path: `${outDir}/daw.png` });
check(errors.length === 0, `ページのエラーなし${errors.length ? `: ${errors.join(" / ")}` : ""}`);
await browser.close();
process.exit(failed ? 1 : 0);
