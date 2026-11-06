# 耳コピ結果を鳴らした音（*.ghost.wav）と、元の Lyria の音声の同じ区間が、音の高さの成分（クロマ）でどれだけ一致するかを測る。
# 基準値として、ゴーストを1拍ずらしたものと、音高をランダムに入れ替えたものとの一致度も出す。
# usage: uv run --with librosa==0.11.0 python scripts/match.py out/eval/xxx  (xxx.wav, xxx.ghost.wav, xxx.ghost.json がある前提)
import sys, json, numpy as np, librosa
base = sys.argv[1]
meta = json.load(open(base + ".ghost.json"))
bpm, start = meta.get("sourceBpm", meta["bpm"]), meta["startSec"]
dur = 60 / bpm * 4 * 4
sr = 22050
orig, _ = librosa.load(base + ".wav", sr=sr, mono=True, offset=max(0, start), duration=dur)
ghost, _ = librosa.load(base + ".ghost.wav", sr=sr, mono=True, duration=dur)
n = min(len(orig), len(ghost))
orig, ghost = orig[:n], ghost[:n]
hop = 512
def chroma(y):
    c = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop)
    return c / (np.linalg.norm(c, axis=0, keepdims=True) + 1e-9)
co, cg = chroma(orig), chroma(ghost)
rms_o = librosa.feature.rms(y=orig, hop_length=hop)[0][: co.shape[1]]
rms_g = librosa.feature.rms(y=ghost, hop_length=hop)[0][: cg.shape[1]]
m = min(co.shape[1], cg.shape[1])
# 両方が鳴っているフレームだけで比べる
active = (rms_o[:m] > np.percentile(rms_o[:m], 30)) & (rms_g[:m] > 1e-3)
def score(a, b):
    sim = (a[:, :m] * b[:, :m]).sum(axis=0)
    return float(sim[active].mean()) if active.any() else float("nan")
beat_frames = int(round(60 / bpm * sr / hop))
shifted = np.roll(cg, beat_frames, axis=1)
rng = np.random.default_rng(0)
perm = np.stack([np.roll(cg[:, i], rng.integers(1, 12)) for i in range(cg.shape[1])], axis=1)
# 音の出だしの一致: 両者のオンセット強度の相関
oo = librosa.onset.onset_strength(y=orig, sr=sr, hop_length=hop)
og = librosa.onset.onset_strength(y=ghost, sr=sr, hop_length=hop)
k = min(len(oo), len(og))
onset_corr = float(np.corrcoef(oo[:k], og[:k])[0, 1])
# 音符単位の出だしの照合: 元の音声から検出した出だしと、ゴーストの各音の開始時刻を ±50ms で対応付けた F 値。
# 基準値は、同じ数の音を16分音符の格子上にランダムに置いた場合の F 値（20回の平均）。
def f1(ref, est, tol=0.05):
    ref, est = sorted(ref), sorted(est)
    used, hit = set(), 0
    for t in est:
        best = None
        for i, r in enumerate(ref):
            if i not in used and abs(r - t) <= tol and (best is None or abs(r - t) < abs(ref[best] - t)):
                best = i
        if best is not None:
            used.add(best); hit += 1
    p = hit / len(est) if est else 0.0
    r = hit / len(ref) if ref else 0.0
    return 2 * p * r / (p + r) if p + r else 0.0
step_sec = 60 / bpm / 4
ref_on = librosa.onset.onset_detect(y=orig, sr=sr, hop_length=hop, units="time", backtrack=True).tolist()
est_on = sorted({n["step"] * step_sec for n in meta["notes"]})
rand_f1 = float(np.mean([f1(ref_on, sorted(rng.choice(64, size=min(64, len(est_on)), replace=False) * step_sec)) for _ in range(20)]))
print(json.dumps({
    "base": base, "notes": len(meta["notes"]), "activeFrames": int(active.sum()),
    "chroma_match": round(score(co, cg), 3),
    "baseline_shift1beat": round(score(co, shifted), 3),
    "baseline_randompitch": round(score(co, perm), 3),
    "onset_corr": round(onset_corr, 3),
    "onset_f1": round(f1(ref_on, est_on), 3),
    "onset_f1_random_grid": round(rand_f1, 3),
    "detected_onsets": len(ref_on),
}))
