// docs/経緯と設計.md を、共有用の1枚の HTML ページにする。
// usage: node scripts/doc-page/build.mjs docs/経緯と設計.md out/ghostnotes-design.html
import { marked } from "marked";
import { readFileSync, writeFileSync } from "node:fs";

const [src, out] = process.argv.slice(2);
const md = readFileSync(src, "utf8");

const slugs = new Map();
const toc = [];
const renderer = new marked.Renderer();
renderer.heading = ({ tokens, depth }) => {
  const text = marked.Parser.parseInline(tokens);
  const plain = text.replace(/<[^>]+>/g, "");
  if (depth === 1) return "";
  let id = "s" + (slugs.size + 1);
  slugs.set(id, plain);
  if (depth === 2) toc.push({ id, plain });
  return `<h${depth} id="${id}">${text}</h${depth}>\n`;
};
renderer.table = function (token) {
  const head = token.header.map((c) => `<th>${marked.Parser.parseInline(c.tokens)}</th>`).join("");
  const rows = token.rows.map((r) => `<tr>${r.map((c) => `<td>${marked.Parser.parseInline(c.tokens)}</td>`).join("")}</tr>`).join("");
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>\n`;
};
renderer.code = ({ text, lang }) =>
  lang === "mermaid"
    ? `<figure class="diagram"><pre class="mermaid">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre><figcaption>1回の提案の流れ。曲の正本は MIDI で、Lyria の音声は提案を作る材料として使う</figcaption></figure>\n`
    : `<pre class="code"><code>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</code></pre>\n`;
renderer.link = ({ href, tokens }) => {
  const text = marked.Parser.parseInline(tokens);
  return /^https?:/.test(href) ? `<a href="${href}" target="_blank" rel="noopener">${text}</a>` : `<span class="file">${text}</span>`;
};

const title = /^# (.+)$/m.exec(md)?.[1] ?? "Ghostnotes";
// 冒頭のメタ情報（更新日など）の箇条書きは、見出しの下の小さな行として出す
const metaMatch = /^# .+\n\n((?:- .+\n)+)/m.exec(md);
const meta = metaMatch ? metaMatch[1].trim().split("\n").map((l) => l.replace(/^- /, "")) : [];
const body = marked.parse(md.replace(/^# .+\n\n(?:- .+\n)+/m, ""), { renderer });

const html = readFileSync(new URL("./template.html", import.meta.url), "utf8")
  .replace("{{TITLE}}", title)
  .replace("{{META}}", meta.map((m) => `<span>${marked.parseInline(m)}</span>`).join(""))
  .replace("{{TOC}}", toc.map((t) => `<li><a href="#${t.id}">${t.plain}</a></li>`).join(""))
  .replace("{{BODY}}", body);
writeFileSync(out, html);
console.log(`wrote ${out} (${html.length} chars, ${toc.length} sections)`);
