# 音声の拍の位置とテンポを librosa で推定し、指定した BPM の格子にどれだけ乗っているかを見る。
import sys, json, numpy as np, librosa
path, target = sys.argv[1], float(sys.argv[2])
y, sr = librosa.load(path, sr=22050, mono=True)
tempo, beats = librosa.beat.beat_track(y=y, sr=sr, start_bpm=target, units="time")
onset_env = librosa.onset.onset_strength(y=y, sr=sr)
# 指定BPMのテンポグラム上の強さ（自己相関）を周辺のBPMと比べる
ac = librosa.autocorrelate(onset_env, max_size=int(sr/512*4))
def strength(bpm):
    lag = 60/bpm*sr/512
    return float(np.interp(lag, np.arange(len(ac)), ac))/float(ac[0])
cands = {b: round(strength(b),3) for b in [target*0.5, target*2/3, target*0.9, target, target*1.1, target*1.5, target*2]}
ibi = np.diff(beats)
print(json.dumps({"file": path, "librosa_bpm": round(float(np.atleast_1d(tempo)[0]),1),
  "beat_interval_ms_median": round(float(np.median(ibi))*1000,1) if len(ibi) else None,
  "beat_interval_ms_std": round(float(np.std(ibi))*1000,1) if len(ibi) else None,
  "target_interval_ms": round(60000/target,1), "autocorr_at": cands}))
