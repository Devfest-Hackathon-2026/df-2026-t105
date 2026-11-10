import {editorProject} from "./fixtures/editor-project.mjs";
// ピアノロールの編集操作（移動・リサイズ・Esc 取り消し・クリック削除・カーソル）をブラウザで通す。API は呼ばない。
// usage: node scripts/smoke-roll.mjs
import { chromium } from "playwright";
import { spawn } from "node:child_process";

const URL = "http://127.0.0.1:5319/";
const KEY = "ghostnotes.project.v1";
const LABEL_W = 112; // 左端の鍵盤の幅（roll.ts の KEY_W）
const RULER_H = 22; // 上の小節の目盛りの高さ（roll.ts の RULER_H）
const STEPS = 64; // デモ曲は4小節 × 16分
const TOP_PITCH = 52; // ベースは上が pitch 52、下が 28 の25行

// dev サーバーを自分で立てて、最後に止める
const vite = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", "5319", "--strictPort"], { stdio: "ignore", detached: true });
const stopVite = async () => {
  for (const sig of ["SIGTERM", "SIGKILL"]) {
    try { process.kill(-vite.pid, sig); } catch {}
    if (vite.exitCode !== null) return;
    await new Promise((r) => setTimeout(r, 300));
  }
};
let up = false;
for (let i = 0; i < 150 && !up; i++) {
  try { up = (await fetch(URL)).ok; } catch { await new Promise((r) => setTimeout(r, 200)); }
}

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? "PASS" : "FAIL"} ${label}`); if (!ok) failures++; };

const browser = await chromium.launch();
try {
  if (!up) throw new Error("dev server が起動しない");
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto(URL);
  await page.evaluate(p=>localStorage.setItem("ghostnotes.project.v1",JSON.stringify(p)),editorProject());
  await page.reload();
  await page.click('button.track-name:has-text("Bass")');
  await page.selectOption("#grid","1");
  // 初回読み込みでは localStorage にまだ保存されていないので、無害な操作（ミュート→戻す）で保存させる
  await page.click(".track:first-child .mute");
  await page.click(".track:first-child .mute");

  const geo = await page.evaluate(() => {
    const r = document.getElementById("roll").getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height };
  });
  const cw = (geo.w - LABEL_W) / STEPS;
  const rh = (geo.h - RULER_H) / (TOP_PITCH - 28 + 1);
  const cellX = (step) => geo.left + LABEL_W + (step + 0.5) * cw;
  const rowY = (pitch) => geo.top + RULER_H + (TOP_PITCH - pitch + 0.5) * rh;
  const readNotes = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k)).tracks.bass.notes, KEY);
  const snap = (ns) => JSON.stringify(ns.map((n) => [n.step, n.len, n.pitch]).sort((a, b) => a[0] - b[0] || a[2] - b[2]));

  // 1) 最初のベースノートを 4ステップ右・2半音上にドラッグで移動
  const first = [...(await readNotes())].sort((a, b) => a.step - b.step)[0];
  await page.mouse.move(cellX(first.step + first.len / 2 - 0.5), rowY(first.pitch));
  await page.mouse.down();
  await page.mouse.move(cellX(first.step + first.len / 2 - 0.5 + 4), rowY(first.pitch + 2), { steps: 10 });
  await page.mouse.up();
  let notes = await readNotes();
  const moved = notes.find((n) => n.step === first.step + 4 && n.pitch === first.pitch + 2);
  check(!!moved && moved.len === first.len, `move: step ${first.step + 4} / pitch ${first.pitch + 2} に移動した（len ${first.len}）`);
  check(!notes.some((n) => n.step === first.step && n.pitch === first.pitch), "move: 元の位置から消えている");

  // 2) そのノートの右端をドラッグして 2ステップ伸ばす
  const w = moved.len * cw;
  const endX = geo.left + LABEL_W + (moved.step + moved.len) * cw;
  const gripX = w < 24 ? endX - w * 0.125 : endX - 3; // つかみ位置は右端の中心あたり
  await page.mouse.move(gripX, rowY(moved.pitch));
  await page.mouse.down();
  await page.mouse.move(endX + 2 * cw, rowY(moved.pitch), { steps: 10 });
  await page.mouse.up();
  notes = await readNotes();
  const resized = notes.find((n) => n.step === moved.step && n.pitch === moved.pitch);
  check(!!resized && resized.len === moved.len + 2, `resize: len が ${moved.len + 2} になった`);

  // 3) ドラッグ中に Esc を押すと取り消される
  const before = snap(notes);
  const escNote = notes.find((n) => n !== resized);
  await page.mouse.move(cellX(escNote.step + escNote.len / 2 - 0.5), rowY(escNote.pitch));
  await page.mouse.down();
  await page.mouse.move(cellX(escNote.step + escNote.len / 2 - 0.5 + 2), rowY(escNote.pitch + 1), { steps: 5 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  check(snap(await readNotes()) === before, "esc: ドラッグ中に Esc で元のまま");

  // 4) 動かさずクリックすると消える
  await page.mouse.click(cellX(resized.step), rowY(resized.pitch));
  notes = await readNotes();
  check(!notes.some((n) => n.step === resized.step && n.pitch === resized.pitch), "click: 動かさずクリックで消えた");

  // 5) カーソルの形状
  const cursorAt = async (x, y) => {
    await page.mouse.move(x, y);
    return page.evaluate(() => document.getElementById("roll").style.cursor);
  };
  const other = notes.find((n) => n.len >= 2);
  const cBody = await cursorAt(cellX(other.step), rowY(other.pitch));
  check(cBody === "grab", `cursor: ノート本体で grab（${cBody}）`);
  const ow = other.len * cw;
  const oEnd = geo.left + LABEL_W + (other.step + other.len) * cw;
  const cEdge = await cursorAt(oEnd - (ow < 24 ? ow * 0.125 : 3), rowY(other.pitch));
  check(cEdge === "ew-resize", `cursor: 右端で ew-resize（${cEdge}）`);
  const cEmpty = await cursorAt(cellX(STEPS - 1), rowY(TOP_PITCH));
  check(cEmpty === "crosshair", `cursor: 空きマスで crosshair（${cEmpty}）`);
} catch (e) {
  console.log("FAIL", e.message);
  failures++;
} finally {
  await browser.close();
  await stopVite();
}
console.log(failures ? `FAIL ${failures} 件失敗` : "PASS すべて成功");
process.exit(failures ? 1 : 0);
