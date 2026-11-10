// サイト全体のパスワード。パスワードだけのログイン画面を出し、通ったら署名付きの Cookie で覚える。
// Cookie は「有効期限.署名」の形で、署名の鍵はパスワードそのもの。サーバーに状態を持たないので
// Cloud Run のインスタンスが複数でも通り、パスワードを変えると古い Cookie はすべて無効になる。
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const COOKIE = "gn_session";
const MAX_AGE_SEC = 7 * 24 * 60 * 60;

const digest = (s) => createHash("sha256").update(s).digest();
const sign = (password, exp) => createHmac("sha256", password).update(`ghostnotes-session:${exp}`).digest("base64url");

export function passwordMatches(password, input) {
  return typeof input === "string" && timingSafeEqual(digest(input), digest(password));
}

export function issueToken(password, now = Date.now()) {
  const exp = Math.floor(now / 1000) + MAX_AGE_SEC;
  return `${exp}.${sign(password, exp)}`;
}

export function tokenValid(password, token, now = Date.now()) {
  const m = /^(\d+)\.([\w-]+)$/.exec(token ?? "");
  if (!m || Number(m[1]) * 1000 < now) return false;
  const want = Buffer.from(sign(password, Number(m[1])));
  const got = Buffer.from(m[2]);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function readCookie(req, name = COOKIE) {
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function sessionCookie(token, secure) {
  return `${COOKIE}=${token}; Path=/; Max-Age=${MAX_AGE_SEC}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function clearCookie(secure) {
  return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** ログイン後に戻る先。外部サイトへ飛ばされないよう、同じサイト内のパスだけを通す */
export function safeNext(next) {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function loginPage({ next = "/", error = "" } = {}) {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Ghostnotes</title>
<style>
:root { color-scheme: light dark; --ground:#f3f4f6; --surface:#fff; --line:#dde0e6; --text:#16181d; --muted:#5f6573; --accent:#2563d9; --error:#c0392b; }
@media (prefers-color-scheme: dark) { :root { --ground:#14161b; --surface:#1d2128; --line:#323844; --text:#eceef2; --muted:#9aa1ae; --accent:#5b8def; --error:#ef6b5b; } }
* { box-sizing: border-box; }
body { margin:0; min-height:100vh; display:grid; place-items:center; padding:16px; background:var(--ground); color:var(--text);
  font-family: "Hiragino Sans", "Yu Gothic UI", "Noto Sans JP", system-ui, sans-serif; }
form { width:100%; max-width:340px; background:var(--surface); border:1px solid var(--line); border-radius:12px; padding:28px 24px; }
h1 { margin:0 0 4px; font-size:22px; }
p { margin:0 0 20px; color:var(--muted); font-size:13px; line-height:1.6; }
label { display:block; font-size:13px; margin-bottom:6px; }
input { width:100%; font:inherit; font-size:16px; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--ground); color:var(--text); }
input:focus { outline:2px solid var(--accent); outline-offset:1px; }
button { width:100%; margin-top:16px; font:inherit; font-size:15px; font-weight:600; padding:10px; border:0; border-radius:8px; background:var(--accent); color:#fff; cursor:pointer; }
.error { color:var(--error); font-size:13px; margin:10px 0 0; }
</style>
</head>
<body>
<form method="post" action="/login">
  <h1>Ghostnotes</h1>
  <p>パスワードを入力してください．</p>
  <label for="password">パスワード</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
  <input type="hidden" name="next" value="${esc(next)}">
  ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
  <button type="submit">ログイン</button>
</form>
</body>
</html>`;
}
