# drums.js の結果を、librosa の帯域別の出だし検出と照合する（どちらも完璧ではないので、一致度は目安）。
# usage: node scripts/drums-diag.mjs x.wav 120 | uv run --with librosa==0.11.0 python scripts/drums-ref.py
import sys, json, numpy as np, librosa
d = json.loads(sys.stdin.read())
y, sr = librosa.load(d["path"], sr=22050, mono=True)
S = np.abs(librosa.stft(y, n_fft=2048, hop_length=256))
freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
step = 60 / d["bpm"] / 4
def ref_steps(lo, hi):
    band = S[(freqs >= lo) & (freqs < hi)]
    env = librosa.onset.onset_strength(S=librosa.amplitude_to_db(band), sr=sr, hop_length=256)
    on = librosa.onset.onset_detect(onset_envelope=env, sr=sr, hop_length=256, units="time")
    out = set()
    for t in on:
        s = (t - d["startSec"]) / step
        k = int(round(s))
        if 0 <= k < 64 and abs(s - k) < 0.35: out.add(k)
    return out
res = {"path": d["path"]}
for name, lo, hi in [("kick", 20, 120), ("snare", 150, 2500), ("hat", 6000, 11000)]:
    ref, est = ref_steps(lo, hi), set(d[name])
    tp = len(ref & est)
    p = tp / len(est) if est else 0
    r = tp / len(ref) if ref else 0
    res[name] = {"ref": len(ref), "est": len(est), "f1": round(2 * p * r / (p + r), 2) if p + r else 0}
print(json.dumps(res))
