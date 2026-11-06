// Private SSH forwarding. Ctrl+C or the time limit stops the Colab runtime.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
const model = process.env.A100_MODEL ?? "medium";
const minutes = Number(process.env.A100_MINUTES ?? 60);
const port = Number(process.env.A100_PORT ?? 8223);
if (!["small", "medium", "large"].includes(model) || !Number.isFinite(minutes) || minutes < 1 || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("A100_MODEL / A100_MINUTES / A100_PORT を確認してください");
const tokenPath = process.env.HF_TOKEN_PATH ?? join(homedir(), ".cache/huggingface/token");
if (!existsSync(tokenPath)) throw new Error("hf auth login と MuScriptor のモデル利用条件への同意が必要です");
const session = `ghostnotes-${Date.now()}`;
// Prior permission never opts in to future credential transfers. Require interactive consent each time.
if (!process.stdin.isTTY) throw new Error("認証情報の送信確認が必要なため、端末で npm run a100 を実行してください");
const input = createInterface({ input: process.stdin, output: process.stdout });
const answer = await input.question(`Hugging Face の認証ファイル ${tokenPath} を、自分の Colab A100 (${session}) に転送します。終了時にランタイムを削除します。今回の送信を許可しますか？ [y/N] `);
input.close();
if (!/^y(es)?$/i.test(answer.trim())) process.exit(0);
const dir = mkdtempSync(join(tmpdir(), "ghostnotes-a100-"));
let tunnel, created = false, closing = false, lifetime;
const command = (cmd, args) => new Promise((ok, fail) => {
  const p = spawn(cmd, args, { stdio: "inherit" });
  p.on("error", fail);
  p.on("exit", (code) => code === 0 ? ok() : fail(new Error(`${cmd}: exit ${code}`)));
});
async function cleanup() {
  if (closing) return;
  closing = true;
  clearTimeout(lifetime);
  tunnel?.kill("SIGTERM");
  try { if (created) await command("colab", ["stop", "-s", session]); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { void cleanup().then(() => process.exit(0)); });
try {
  const { createServer } = await import("node:net");
  await new Promise((ok, fail) => { const s = createServer(); s.once("error", fail); s.listen(port, "127.0.0.1", () => s.close(ok)); });
  await command("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, "id")]);
  await command("colab", ["new", "-s", session, "--gpu", "A100"]);
  created = true;
  lifetime = setTimeout(() => { console.log("A100 の利用時間を終了します"); void cleanup(); }, minutes * 60_000);
  await command("colab", ["upload", "-s", session, tokenPath, "/content/ghostnotes-hf-token"]);
  writeFileSync(join(dir, "model.txt"), model);
  await command("colab", ["upload", "-s", session, join(dir, "model.txt"), "/content/ghostnotes-model.txt"]);
  await command("colab", ["exec", "-s", session, "-f", resolve("scripts/a100-serve.py"), "--timeout", "300"]);
  tunnel = spawn("ssh", ["-N", "-L", `127.0.0.1:${port}:127.0.0.1:8222`, "-i", join(dir, "id"),
    "-o", "ExitOnForwardFailure=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${join(dir, "known_hosts")}`,
    "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
    "-o", `ProxyCommand=colab ssh --proxy-mode -s ${session} --identity ${join(dir, "id")}`, `root@${session}`], { stdio: "inherit" });
  const exited = new Promise((ok, fail) => { tunnel.on("error", fail); tunnel.on("exit", (code) => closing ? ok() : fail(new Error(`SSH tunnel closed: ${code}`))); });
  void exited.catch(() => {});
  let ready = false;
  for (let i = 0; i < 120 && tunnel.exitCode === null && !closing; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }); if (r.ok) { ready = true; break; } } catch {}
    await delay(2000);
  }
  if (!ready) throw new Error("A100 の起動を確認できませんでした");
  console.log(`A100 ready (${model}). 設定 → 耳コピ → MuScriptor A100。Ctrl+C、または起動から${minutes}分で停止。`);
  await exited;
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { await cleanup(); }
