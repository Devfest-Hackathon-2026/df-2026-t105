import test from "node:test";
import assert from "node:assert/strict";
import { issueToken, passwordMatches, readCookie, safeNext, tokenValid, loginPage } from "../server/auth.mjs";

test("password comparison", () => {
  assert.equal(passwordMatches("secret", "secret"), true);
  assert.equal(passwordMatches("secret", "Secret"), false);
  assert.equal(passwordMatches("secret", undefined), false);
});

test("session token is accepted until it expires and only for the same password", () => {
  const now = Date.UTC(2026, 10, 10);
  const token = issueToken("pw", now);
  assert.equal(tokenValid("pw", token, now), true);
  assert.equal(tokenValid("pw", token, now + 8 * 24 * 3600 * 1000), false);
  assert.equal(tokenValid("other", token, now), false);
  const [exp, sig] = token.split(".");
  assert.equal(tokenValid("pw", `${Number(exp) + 1}.${sig}`, now), false);
  assert.equal(tokenValid("pw", "garbage", now), false);
  assert.equal(tokenValid("pw", null, now), false);
});

test("cookie parsing", () => {
  assert.equal(readCookie({ headers: { cookie: "a=1; gn_session=abc.def; b=2" } }), "abc.def");
  assert.equal(readCookie({ headers: {} }), null);
});

test("redirect target stays on this site", () => {
  assert.equal(safeNext("/?demo"), "/?demo");
  assert.equal(safeNext("//evil.example"), "/");
  assert.equal(safeNext("https://evil.example"), "/");
  assert.equal(safeNext("/\\evil.example"), "/");
  assert.equal(safeNext(null), "/");
});

test("login page escapes the redirect target", () => {
  assert.ok(!loginPage({ next: '/"><script>' }).includes("<script>"));
});
