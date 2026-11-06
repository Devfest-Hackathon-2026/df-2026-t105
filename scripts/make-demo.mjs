// 実演用の提案（2案）を実際に生成し、public/demo/ に書き出す。?demo で開いた画面がこれを読み込む。
// usage: node --env-file=.env scripts/make-demo.mjs [http://127.0.0.1:5317] ["意図"]
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url = "http://127.0.0.1:5317", intent = "ベースに寄り添う、少し切ないメロディ。最後の小節で上がって終わりたい"] = process.argv.slice(2);
const outDir = "public/demo";
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`${url}/?debug`);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.selectOption("#target", "lead");
await page.fill("#intent", intent);
await page.uncheck("#monitor");
await page.click("#ask");
await page.waitForFunction(() => /2案が届きました|できませんでした|失敗/.test(document.getElementById("status")?.textContent ?? ""), null, { timeout: 420_000 });
console.log(await page.textContent("#status"));
// 両方の案の説明が届くまで待つ
await page.waitForFunction(() => {
  const ex = (window).__ghostnotesExport?.();
  return ex && ex.cands.every((c) => c.explanation);
}, null, { timeout: 60_000 }).catch(() => console.log("説明の一部が届かなかった"));
const ex = await page.evaluate(() => (window).__ghostnotesExport());
await browser.close();
if (!ex) throw new Error("書き出せる提案がありません");

const tmp = join(tmpdir(), `ghostnotes-demo-${Date.now()}`);
mkdirSync(tmp, { recursive: true });
ex.cands = ex.cands.map((c, k) => {
  const name = `${"ab"[k]}.mp3`;
  const wav = join(tmp, `${k}.wav`);
  writeFileSync(wav, Buffer.from(c.wav, "base64"));
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", wav, "-b:a", "128k", join(outDir, name)]);
  const { wav: _drop, ...rest } = c;
  return { ...rest, audio: name };
});
writeFileSync(join(outDir, "set.json"), JSON.stringify(ex));
console.log(JSON.stringify({ intent: ex.intent, cands: ex.cands.map((c) => ({ title: c.spec.title, audio: c.audio, raw: c.raw.length, sourceBpm: c.sourceBpm })) }, null, 1));
