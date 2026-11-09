// はじめて触る人向けの操作ツアー。
// 画面の要素を順番にハイライトし、「生成 → 聴き比べ → 採用 → 手で直す → 書き出す」を
// 実際に操作しながら進める。各ステップの「やってみよう」を済ませると、自動で次へ進む。
// 暗幕はクリックを通すので、案内を開いたまま操作できる。

type Pane = "tracks" | "editor" | "generate";

/** 案内が「操作できたか」を判定するために読む、アプリの状態 */
export type AppState = {
  notes: number;
  proposal: boolean;
  alts: number;
  shownAlt: string | null;
  accepted: number;
  generating: boolean;
  playing: boolean;
  selected: number;
  selectTool: boolean;
  revision: number;
  historyPos: number;
};

type Task = {
  /** やってみること（HTML） */
  text: string;
  /** ステップを開いたときの状態 base と、いまの状態 now を比べて、済んだかを返す */
  done: (now: AppState, base: AppState) => boolean;
  /** false を返すときは、操作できない（提案がないなど）ので説明だけにする */
  when?: (now: AppState) => boolean;
  /** 済んだら自動で次へ進む。文字入力のように途中で進むと困るものは false */
  auto?: boolean;
};

export type TutorialStep = {
  /** 強調する要素のセレクタ。複数書くと、見えている要素をまとめた範囲を囲む。空なら画面中央に出す */
  target?: string[];
  /** target がどれも見えないときに代わりに囲む要素 */
  fallback?: string[];
  /** 狭い画面で表示を切り替えるパネル */
  pane?: Pane;
  chip?: string;
  title: string;
  /** HTML（固定の文面だけを入れる） */
  body: string;
  task?: Task;
  /** task が使えないときに body の後ろに足す一文 */
  whenMissing?: string;
  /** 進むときに、この条件ならこのステップを飛ばす */
  skip?: (now: AppState) => boolean;
  /** 案内の中から実行できる操作。hidden が true を返すときは出さない */
  /** 進むかどうかは task の判定に任せる（ここでは進めない） */
  action?: { label: string; run: () => Promise<void> | void; hidden?: (now: AppState) => boolean };
};

export type TutorialHost = {
  showPane: (pane: Pane) => void;
  loadDemo: () => Promise<boolean>;
  fillIntent: (text: string) => void;
  state: () => AppState;
};

const SEEN_KEY = "ghostnotes.tutorial.seen";
const EXAMPLE_INTENT = "ベースに寄り添う、少し切ないメロディ。最後の小節で上がって終わりたい";

export function tutorialSeen(): boolean {
  try { return localStorage.getItem(SEEN_KEY) === "1"; } catch { return true; }
}
function markSeen() {
  try { localStorage.setItem(SEEN_KEY, "1"); } catch {}
}

const intentText = () => (document.getElementById("intent") as HTMLTextAreaElement | null)?.value.trim() ?? "";

export function buildSteps(host: TutorialHost): TutorialStep[] {
  const demoAction = {
    label: "待たずに試す（収録済みの2案を開く）",
    run: async () => { if (!(await host.loadDemo())) throw new Error("収録済みの案を開けませんでした"); },
    hidden: (s: AppState) => s.proposal,
  };
  return [
    {
      title: "Ghostnotes へようこそ",
      body: `<p>フレーズを<b>言葉で頼む</b>と、Lyria が演奏し、その音を耳コピして<b>ピアノロールに「提案」として重ねます</b>。提案は紫の枠で描かれ、あなたが採用するまで曲には入りません。</p>
<ol class="tour-flow">
  <li><b>生成</b>：作りたいフレーズを言葉で書く</li>
  <li><b>聴き比べ</b>：案A・案Bを重ねて聴く</li>
  <li><b>採用</b>：気に入った音・小節だけ取り込む</li>
  <li><b>手で直す</b>：ペンと選択ツールで仕上げる</li>
  <li><b>書き出す</b>：MIDI・WAV に保存</li>
</ol>
<p class="tour-note">各ステップの「やってみよう」を実際に操作すると、自動で次へ進みます。飛ばしたいときは「スキップ」を押してください。</p>`,
    },
    {
      target: [".roll-wrap"],
      pane: "editor",
      chip: "準備",
      title: "ピアノロールに音を置く",
      body: `<p>横が時間、縦が音の高さです。ペンツールでクリックすると音符を置け、横にドラッグすると長さが決まります。</p>
<p class="tour-note">ベースやコードを先に置いておくと、提案はそれに合わせて作られます。置いた音は <kbd>Cmd/Ctrl</kbd>+<kbd>Z</kbd> で消せます。</p>`,
      task: {
        text: "ピアノロールをクリックして、音を1つ置いてみましょう",
        done: (s, b) => s.notes > b.notes,
        auto: true,
      },
    },
    {
      target: ["#target", "#intent"],
      pane: "generate",
      chip: "手順1・生成",
      title: "作りたいフレーズを言葉で書く",
      body: `<p><b>トラック</b>で提案を入れる先を選び、<b>フレーズ</b>に作りたいものを書きます。雰囲気・楽器・リズム感・どこで盛り上げたいかなど、意図を書くほど狙いに近づきます。</p>`,
      task: {
        text: "「フレーズ」欄に作りたいものを書きましょう。書けたら「次へ」",
        done: () => intentText().length > 0,
      },
      action: { label: "例文を入れる", run: () => host.fillIntent(EXAMPLE_INTENT), hidden: () => intentText().length > 0 },
    },
    {
      target: ["#generationStart", "#generationBars", "#candidateCount"],
      pane: "generate",
      chip: "手順1・生成",
      title: "どこに・何小節・何案",
      body: `<p><b>開始小節</b>と<b>長さ</b>で、提案を置く範囲を決めます。</p>
<p><b>候補数</b>を2案以上にすると、同じ意図を違う解釈で弾いた案が届き、聴き比べられます（そのぶん時間がかかります）。</p>`,
    },
    {
      target: ["#ask"],
      pane: "generate",
      chip: "手順1・生成",
      title: "生成する",
      body: `<p>押すと Lyria が演奏し、その音を耳コピします。<b>1案に1〜2分</b>かかります。</p>
<p class="tour-note">すぐ続きを試したいときは、下のボタンで収録済みの2案を開けます（テンポとキーが 100 BPM・C に変わります。音符は変わりません）。</p>`,
      task: {
        text: "「生成する」を押しましょう",
        done: (s) => s.generating || s.proposal,
        auto: true,
      },
      action: demoAction,
    },
    {
      target: ["#status", ".generation-panel .progress", "#previewPanel"],
      pane: "generate",
      chip: "手順1・生成",
      title: "提案が届くまで待つ",
      body: `<p>ここに進み具合が出ます。先に届いた原音は上の「原音」欄で聴けます。</p>
<p class="tour-note">エラーになったときは、⚙ 設定の Gemini API キーを確認するか、下のボタンで収録済みの案を開いてください。</p>`,
      task: {
        text: "提案が届くと自動で次へ進みます",
        done: (s) => s.proposal,
        auto: true,
      },
      skip: (s) => s.proposal,
      action: demoAction,
    },
    {
      target: ["#takes"],
      fallback: [".editor-head"],
      pane: "editor",
      chip: "手順2・聴き比べ",
      title: "案を切り替える",
      body: `<p>ピアノロールの上に<b>案ごとのレーン</b>が並びます。「案A」「案B」を押すか、キー <kbd>1</kbd> <kbd>2</kbd> で、ピアノロールに出す案を切り替えます。</p>`,
      task: {
        text: "「案B」を押して、表示する案を切り替えてみましょう",
        done: (s, b) => s.shownAlt !== b.shownAlt,
        when: (s) => s.alts >= 2,
        auto: true,
      },
      whenMissing: "（案が2つ以上あるときに使えます。候補数を2案にして生成してみてください）",
    },
    {
      target: ["#play", "#loop", ".seg[aria-label='聴くもの']"],
      chip: "手順2・聴き比べ",
      title: "重ねて聴く",
      body: `<p>右の切り替えで、何を聴くかを選びます。</p>
<ul>
  <li><b>ノート</b>：自分の音（採用済みの音）だけ</li>
  <li><b>提案</b>：提案も MIDI で重ねて鳴らす</li>
  <li><b>原音</b>：Lyria が弾いた元の音を重ねる</li>
</ul>`,
      task: {
        text: "「提案」を選んで、再生ボタン（<kbd>Space</kbd>）で聴いてみましょう",
        done: (s) => s.playing,
        auto: true,
      },
    },
    {
      target: [".roll-wrap", "#takes"],
      pane: "editor",
      chip: "手順3・採用",
      title: "気に入った音を採用する",
      body: `<p>紫の枠の音が<b>提案（ゴースト）</b>です。枠が<b>実線</b>なら耳コピで確かに拾えた音、<b>点線</b>なら誤検出かもしれない音です。塗りつぶされた音は、すでに曲に入っている自分の音です。</p>
<ul>
  <li><b>提案の音をクリック</b>：その1音を採用して、自分の音にする</li>
  <li><b>右クリック</b>：その提案を消す</li>
  <li><b>レーンの小節をクリック</b>：その小節をまるごとその案に置き換える（もう一度押すと戻る）</li>
</ul>`,
      task: {
        text: "紫の枠の音をクリックして、1つ採用してみましょう",
        done: (s, b) => s.accepted > b.accepted,
        when: (s) => s.proposal,
        auto: true,
      },
      whenMissing: "（提案が届くと、ここに紫の枠で表示されます）",
    },
    {
      target: ["#ghost"],
      fallback: ["#generatorPane"],
      pane: "generate",
      chip: "手順3・採用",
      title: "提案を確定する",
      body: `<ul>
  <li><b>拾う音の量</b>：耳コピで拾う音の多さを調整</li>
  <li><b>← 1/16 / 1/16 →</b>：提案のタイミングのずれを直す</li>
  <li><b>全部採用</b>（<kbd>Tab</kbd>）：表示中の案の音をすべて取り込む</li>
  <li><b>メモ</b>：なぜ採用したかを書き残す</li>
</ul>
<p>採用し終えたら、提案を閉じます。結果は下の「履歴」に残ります。</p>`,
      task: {
        text: "「採用して確定」（使わないなら「見送る」）を押しましょう",
        done: (s) => !s.proposal,
        when: (s) => s.proposal,
        auto: true,
      },
      whenMissing: "（このパネルは提案が届くと表示されます）",
    },
    {
      target: ["#toolSelect", ".roll-wrap"],
      pane: "editor",
      chip: "手順4・手で直す",
      title: "選択ツールで音を選ぶ",
      body: `<p>採用した音は、ふつうの音符として自由に直せます。<b>選択</b>（<kbd>V</kbd>）に切り替えると、ドラッグで範囲を囲んで複数の音を選べます。</p>`,
      task: {
        text: "「選択」（<kbd>V</kbd>）に切り替えて、ピアノロールをドラッグして音を囲みましょう",
        // ペンで置いた直後の音も選択中になるので、選択ツールで選び直したときに済んだとみなす
        done: (s, b) => s.selectTool && s.selected > 0 && (!b.selectTool || b.selected === 0 || s.selected !== b.selected),
        when: (s) => s.notes > 0,
        auto: true,
      },
      whenMissing: "（音を置くか採用すると試せます）",
    },
    {
      target: [".roll-wrap", ".vel-wrap"],
      pane: "editor",
      chip: "手順4・手で直す",
      title: "選んだ音を動かす",
      body: `<ul>
  <li><kbd>↑</kbd><kbd>↓</kbd>：移調（<kbd>Shift</kbd> でオクターブ）</li>
  <li><kbd>←</kbd><kbd>→</kbd>：時間をずらす</li>
  <li><kbd>D</kbd>：複製　<kbd>Delete</kbd>：削除　<kbd>Q</kbd>：グリッドに揃える</li>
  <li>下段のバー：音の強さ（ベロシティ）</li>
</ul>`,
      task: {
        text: "<kbd>↑</kbd> キーを押すか、音をドラッグして動かしてみましょう",
        done: (s, b) => s.revision > b.revision,
        when: (s) => s.notes > 0,
        auto: true,
      },
      whenMissing: "（音を置くか採用すると試せます）",
    },
    {
      target: ["#undo", "#redo"],
      chip: "手順4・手で直す",
      title: "元に戻す",
      body: `<p>間違えても大丈夫です。<b>元に戻す</b>（<kbd>Cmd/Ctrl</kbd>+<kbd>Z</kbd>）と<b>やり直す</b>で、編集を行き来できます。</p>`,
      task: {
        text: "元に戻すボタン（<kbd>Cmd/Ctrl</kbd>+<kbd>Z</kbd>）を押してみましょう",
        done: (s, b) => s.historyPos < b.historyPos,
        when: (s) => s.historyPos > 0,
        auto: true,
      },
    },
    {
      target: ["#exportMidi", "#exportWav"],
      chip: "手順5・書き出す",
      title: "書き出して完成",
      body: `<p>できたら <b>MIDI</b> で書き出して手元の DAW で続きを作るか、<b>WAV</b> で音として保存します。</p>
<p>これで一通りです。この案内は右上の <b>「使い方」</b> からいつでも見直せます。</p>`,
    },
  ];
}

export class Tutorial {
  private steps: TutorialStep[];
  private i = 0;
  private root: HTMLDivElement | null = null;
  private spot!: HTMLDivElement;
  private bubble!: HTMLDivElement;
  private raf = 0;
  private lastRect = "";
  private returnFocus: HTMLElement | null = null;
  /** ステップを開いたときの状態 */
  private base: AppState | null = null;
  /** いまのステップの task が済んだか（表示を切り替えたときだけ描き直す） */
  private taskState: "none" | "todo" | "done" | "na" = "none";
  private advanceTimer = 0;
  onClose?: () => void;

  constructor(private host: TutorialHost) {
    this.steps = buildSteps(host);
  }

  get open() { return !!this.root; }

  start(at = 0) {
    if (!this.root) this.mount();
    this.go(at);
  }

  close() {
    if (!this.root) return;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.advanceTimer);
    window.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("resize", this.onResize);
    this.root.remove();
    this.root = null;
    markSeen();
    this.returnFocus?.focus?.();
    this.onClose?.();
  }

  private mount() {
    this.returnFocus = document.activeElement as HTMLElement | null;
    const root = document.createElement("div");
    root.className = "tour";
    root.innerHTML = `<div class="tour-spot" aria-hidden="true"></div>
      <div class="tour-bubble" role="dialog" aria-modal="false" aria-labelledby="tourTitle" tabindex="-1"></div>`;
    document.body.append(root);
    this.root = root;
    this.spot = root.querySelector(".tour-spot")!;
    this.bubble = root.querySelector(".tour-bubble")!;
    window.addEventListener("keydown", this.onKey, true);
    window.addEventListener("resize", this.onResize);
    const loop = () => { this.tick(); this.place(); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }

  private onResize = () => { this.lastRect = ""; };

  private onKey = (e: KeyboardEvent) => {
    if (!this.root) return;
    // アプリ側の Esc（提案を見送る）が動かないよう、ここで止める
    if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); this.close(); return; }
    // 案内のボタンにフォーカスがあるときだけ、キーを案内の操作に使う。
    // それ以外（ピアノロールを触ったあとなど）は、Space や矢印をアプリに渡して実際に操作できるようにする
    const a = document.activeElement;
    if (!(a instanceof HTMLButtonElement) || !this.bubble.contains(a)) return;
    if (e.key === "ArrowRight") { e.preventDefault(); e.stopImmediatePropagation(); this.next(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); e.stopImmediatePropagation(); this.prev(); }
    else if (e.key === " " || e.key === "Enter" || e.key === "Tab" || /^[1-4]$/.test(e.key)) e.stopImmediatePropagation();
  };

  private next() {
    let k = this.i + 1;
    const s = this.host.state();
    while (k < this.steps.length && this.steps[k].skip?.(s)) k++;
    if (k < this.steps.length) this.go(k); else this.close();
  }
  private prev() {
    let k = this.i - 1;
    const s = this.host.state();
    while (k > 0 && this.steps[k].skip?.(s)) k--;
    if (k >= 0) this.go(k);
  }

  private targets(step: TutorialStep): HTMLElement[] {
    const pick = (sels?: string[]) => (sels ?? []).flatMap((s) => [...document.querySelectorAll<HTMLElement>(s)]).filter(visible);
    const found = pick(step.target);
    return found.length ? found : pick(step.fallback);
  }

  private currentTaskState(): "none" | "todo" | "done" | "na" {
    const t = this.steps[this.i].task;
    if (!t || !this.base) return "none";
    const now = this.host.state();
    // 開いた時点か、いまのどちらかで条件を満たせば使える。
    // （「確定」のように、済ませると条件そのものが消える操作があるため）
    if (t.when && !t.when(now) && !t.when(this.base)) return "na";
    return t.done(now, this.base) ? "done" : "todo";
  }

  /** 毎フレーム、操作が済んだかを見る */
  private tick() {
    if (!this.root || !this.base) return;
    const prev = this.taskState;
    const next = this.currentTaskState();
    if (next === prev) return;
    this.taskState = next;
    this.render();
    const t = this.steps[this.i].task;
    // ステップを開いた時点で済んでいたもの（prev === "none"）は、勝手に進めない
    if (next === "done" && prev !== "none" && t?.auto) {
      clearTimeout(this.advanceTimer);
      const at = this.i;
      this.advanceTimer = window.setTimeout(() => { if (this.root && this.i === at) this.next(); }, 900);
    }
  }

  private go(i: number) {
    clearTimeout(this.advanceTimer);
    this.i = i;
    const step = this.steps[i];
    if (step.pane && matchMedia("(max-width: 760px)").matches) this.host.showPane(step.pane);
    this.base = this.host.state();
    this.taskState = "none";
    this.taskState = this.currentTaskState();
    this.render();
    const els = this.targets(step);
    els[0]?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    this.lastRect = "";
    this.place();
    // 操作してもらうステップでは、ボタンではなく吹き出しにフォーカスを置く（Space で「次へ」が押されないように）
    if (this.taskState === "todo") this.bubble.focus({ preventScroll: true });
    else this.bubble.querySelector<HTMLButtonElement>("[data-tour=next]")?.focus({ preventScroll: true });
  }

  private render() {
    const i = this.i, step = this.steps[i], total = this.steps.length;
    const now = this.host.state();
    const ts = this.taskState;
    const missing = ts === "na" || (!step.task && !!step.target?.length && !this.targets({ ...step, fallback: [] }).length);
    const task = step.task && ts !== "na"
      ? `<div class="tour-task${ts === "done" ? " done" : ""}">
          <span class="tour-task-mark" aria-hidden="true">${ts === "done" ? `<svg><use href="#i-check" /></svg>` : ""}</span>
          <div><span class="tour-task-label">${ts === "done" ? "できました" : "やってみよう"}</span><span class="tour-task-text">${step.task.text}</span></div>
        </div>`
      : "";
    const showAction = step.action && !step.action.hidden?.(now) && ts !== "done";
    const last = i === total - 1;
    // 操作が済んでいないうちは「次へ」を控えめにして、「スキップ」と書く
    const nextLabel = i === 0 ? "はじめる" : last ? "閉じる" : ts === "todo" ? "スキップ" : "次へ";
    const nextClass = ts === "todo" ? "text-btn" : "primary";
    this.bubble.innerHTML = `
      <div class="tour-head">
        ${step.chip ? `<span class="tour-chip">${step.chip}</span>` : ""}
        <span class="tour-count">${i + 1} / ${total}</span>
        <button class="icon-btn tour-x" data-tour="close" aria-label="案内を閉じる" title="閉じる（Esc）">×</button>
      </div>
      <h2 id="tourTitle">${step.title}</h2>
      <div class="tour-body">${step.body}${missing && step.whenMissing ? `<p class="tour-note">${step.whenMissing}</p>` : ""}</div>
      ${task}
      ${showAction ? `<button class="text-btn tour-action" data-tour="action">${step.action!.label}</button><p class="tour-action-status" aria-live="polite"></p>` : ""}
      <div class="tour-dots" aria-hidden="true">${this.steps.map((_, k) => `<span${k === i ? ` class="on"` : k < i ? ` class="done"` : ""}></span>`).join("")}</div>
      <div class="tour-foot">
        ${i === 0 ? `<button class="text-btn" data-tour="close">あとで</button>` : `<button class="text-btn" data-tour="prev">戻る</button>`}
        <button class="${nextClass}" data-tour="next">${nextLabel}</button>
      </div>`;
    for (const b of this.bubble.querySelectorAll<HTMLButtonElement>("[data-tour]")) {
      const kind = b.dataset.tour;
      b.onclick = kind === "close" ? () => this.close() : kind === "prev" ? () => this.prev() : kind === "next" ? () => this.next() : () => void this.runAction(b);
    }
    this.lastRect = "";
  }

  private async runAction(btn: HTMLButtonElement) {
    const step = this.steps[this.i];
    const status = this.bubble.querySelector<HTMLElement>(".tour-action-status");
    btn.disabled = true;
    if (status) status.textContent = "読み込んでいます…";
    try {
      const at = this.i;
      await step.action!.run();
      if (this.i === at) this.render();
    } catch (e) {
      if (status) status.textContent = `うまくいきませんでした: ${(e as Error).message}`;
      btn.disabled = false;
    }
  }

  /** 毎フレーム呼ぶ。対象の位置が変わったときだけ動かす */
  private place() {
    if (!this.root) return;
    const els = this.targets(this.steps[this.i]);
    const r = union(els);
    const vw = innerWidth, vh = innerHeight;
    const b = this.bubble.getBoundingClientRect();
    const key = r ? `${r.left|0},${r.top|0},${r.width|0},${r.height|0},${vw},${vh},${b.width|0},${b.height|0}` : `c,${vw},${vh},${b.width|0},${b.height|0}`;
    if (key === this.lastRect) return;
    this.lastRect = key;

    const pad = 6, gap = 12, margin = 12;
    const width = (w: number | null) => { const v = w === null ? "" : `${w}px`; if (this.bubble.style.width !== v) this.bubble.style.width = v; };
    if (!r) {
      width(null);
      this.spot.style.cssText = `left:${vw / 2}px;top:${vh / 2}px;width:0;height:0;`;
      this.bubble.style.left = `${Math.max(margin, (vw - b.width) / 2)}px`;
      this.bubble.style.top = `${Math.max(margin, (vh - b.height) / 2)}px`;
      return;
    }
    // 画面外にはみ出した部分は、見えている範囲に切り詰めて囲む
    const sx = Math.max(4, r.left - pad), sy = Math.max(4, r.top - pad);
    const ex = Math.min(vw - 4, r.right + pad), ey = Math.min(vh - 4, r.bottom + pad);
    this.spot.style.cssText = `left:${sx}px;top:${sy}px;width:${Math.max(0, ex - sx)}px;height:${Math.max(0, ey - sy)}px;`;

    // 吹き出しは、対象の下 → 上 → 右 → 左 の順で入る場所に置く。どこにも入らなければ画面の下か上に重ねる。
    // 幅は、詰める前の本来の幅で判定する（詰めた幅で判定すると、詰める・戻すを繰り返してはみ出す）
    const MIN_W = 280, MAX_W = 380;
    const natW = Math.min(MAX_W, vw - 24);
    const fits = {
      below: vh - ey - gap >= b.height + margin,
      above: sy - gap >= b.height + margin,
      right: vw - ex - gap >= natW + margin,
      left: sx - gap >= natW + margin,
    };
    // 対象の横に、幅を詰めれば入る（280px 以上ある）なら、操作する場所を隠さないよう横に置く
    const sideRoom = Math.max(vw - ex - gap - margin, sx - gap - margin);
    if (!fits.below && !fits.above && !fits.right && !fits.left && sideRoom >= MIN_W && vw > 760) {
      const w = Math.min(MAX_W, sideRoom);
      width(w);
      const onRight = vw - ex >= sx;
      const h = this.bubble.getBoundingClientRect().height;
      this.bubble.style.left = `${onRight ? ex + gap : sx - gap - w}px`;
      this.bubble.style.top = `${Math.min(Math.max(margin, sy), vh - h - margin)}px`;
      return;
    }
    width(null);
    const clampX = (x: number) => Math.min(Math.max(margin, x), vw - b.width - margin);
    const clampY = (y: number) => Math.min(Math.max(margin, y), vh - b.height - margin);
    let x: number, y: number;
    if (fits.below) { x = clampX(sx + (ex - sx) / 2 - b.width / 2); y = ey + gap; }
    else if (fits.above) { x = clampX(sx + (ex - sx) / 2 - b.width / 2); y = sy - gap - b.height; }
    else if (fits.right) { x = ex + gap; y = clampY(sy + (ey - sy) / 2 - b.height / 2); }
    else if (fits.left) { x = sx - gap - b.width; y = clampY(sy + (ey - sy) / 2 - b.height / 2); }
    else {
      // 対象が大きいとき（ピアノロールなど）は、対象の右端に寄せて、上下の空いているほうに置く
      x = clampX(ex - b.width - margin);
      y = (sy + ey) / 2 > vh / 2 ? margin : vh - b.height - margin;
    }
    this.bubble.style.left = `${x}px`;
    this.bubble.style.top = `${y}px`;
  }
}

function visible(el: HTMLElement) {
  if (el.closest("[hidden]")) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function union(els: HTMLElement[]): DOMRect | null {
  if (!els.length) return null;
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const el of els) {
    const x = el.getBoundingClientRect();
    l = Math.min(l, x.left); t = Math.min(t, x.top); r = Math.max(r, x.right); b = Math.max(b, x.bottom);
  }
  return new DOMRect(l, t, r - l, b - t);
}
