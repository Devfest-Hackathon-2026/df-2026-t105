// 設計ドキュメントを Gemini に読ませ、ハッカソン審査員と懐疑的なチームメイトの立場で批評させる。
// usage: node --env-file=.env scripts/review-doc.mjs docs/経緯と設計.md [model]
import { readFileSync } from "node:fs";

const [path, model = "gemini-3.1-pro-preview"] = process.argv.slice(2);
const doc = readFileSync(path, "utf8");
const prompt = `あなたは2人のレビュアーを兼ねる。
(A) Google 系の技術コミュニティが主催する学生ハッカソンの審査員。大会テーマは "Own the Why, Build with Intent."（AI に丸投げせず、人が理由と意図を持って作る）。
(B) このチームの懐疑的なメンバー。音楽の素人で、「既存製品で足りるのでは」「本当に耳コピできるのか」「デモで失敗しないか」を気にしている。

次の設計ドキュメントを読み、日本語で批評せよ。
- 根拠のない主張、論理の飛躍、数字の解釈の誤り、見落としているリスクを具体的に指摘する。
- 審査で評価されそうな点と、突っ込まれそうな点を分ける。
- それぞれの指摘に、期限（11/10）までに取れる具体的な対策を1つ付ける。
- お世辞や一般論は書かない。ドキュメントに書かれていないことを事実として扱わない。

--- ドキュメント ---
${doc}`;

const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
  body: JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          strengths: { type: "ARRAY", items: { type: "STRING" } },
          issues: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                reviewer: { type: "STRING", enum: ["審査員", "チームメイト"] },
                severity: { type: "STRING", enum: ["高", "中", "低"] },
                point: { type: "STRING" },
                countermeasure: { type: "STRING" },
              },
              required: ["reviewer", "severity", "point", "countermeasure"],
            },
          },
        },
        required: ["strengths", "issues"],
      },
    },
  }),
});
if (!r.ok) { console.error(r.status, (await r.text()).slice(0, 500)); process.exit(1); }
const j = await r.json();
const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
console.log(JSON.stringify({ model: j.modelVersion, ...JSON.parse(text) }, null, 2));
