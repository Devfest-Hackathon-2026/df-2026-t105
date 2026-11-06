const ONSET_SUBDIVISIONS = [1, 2, 3, 4, 6, 8, 12, 16, 24];
const MAX_ONSET_DELAY_S = 0.04;

/** Savitzky-Golay degree-2 smoothing over tracked beats (matches muscriptor/utils/midi.py smoothed_beats). */
export function smoothedBeats(beats) {
  const n = beats.length;
  if (n < 4) return [...beats];
  const width = Math.min(9, n);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.min(Math.max(0, i - (width >> 1)), n - width);
    // Least-squares parabola y = a*x^2 + b*x + c evaluated at x = 0 (which is just c).
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, sy = 0, sxy = 0, sx2y = 0;
    for (let j = lo; j < lo + width; j++) {
      const x = j - i, x2 = x * x, y = beats[j];
      s0++; s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2;
      sy += y; sxy += x * y; sx2y += x2 * y;
    }
    const det = s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s2 * s3) + s2 * (s1 * s3 - s2 * s2);
    out[i] = Math.abs(det) > 1e-12
      ? (sy * (s2 * s4 - s3 * s3) - sxy * (s1 * s4 - s2 * s3) + sx2y * (s1 * s3 - s2 * s2)) / det
      : beats[i];
  }
  return out;
}

function nearestBeatIndex(beats, time) {
  let best = 0;
  for (let i = 1; i < beats.length; i++) {
    if (Math.abs(beats[i] - time) < Math.abs(beats[best] - time)) best = i;
  }
  return best;
}

function beatTimeAtIndex(beats, index) {
  const n = beats.length;
  if (index >= 0 && index < n && Number.isInteger(index)) return beats[index];
  const head = beats[1] - beats[0];
  const tail = beats[n - 1] - beats[n - 2];
  if (index < 0) return beats[0] + index * head;
  if (index >= n - 1) return beats[n - 1] + (index - (n - 1)) * tail;
  const lo = Math.floor(index), frac = index - lo;
  return beats[lo] + frac * (beats[lo + 1] - beats[lo]);
}

function beatPositionAtTime(beats, time) {
  const n = beats.length;
  const head = Math.max(1e-6, beats[1] - beats[0]);
  const tail = Math.max(1e-6, beats[n - 1] - beats[n - 2]);
  if (time <= beats[0]) return (time - beats[0]) / head;
  if (time >= beats[n - 1]) return n - 1 + (time - beats[n - 1]) / tail;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] <= time) lo = mid;
    else hi = mid;
  }
  return lo + (time - beats[lo]) / Math.max(1e-6, beats[hi] - beats[lo]);
}

/** Measure onset delay and beat subdivision (binary vs triplet/shuffle) from note onsets. */
export function estimateSubdivisionAndDelay(notes, beats, bpm) {
  if (!notes.length || !beats || beats.length < 2) return { delay: 0, subdivision: null, concentration: 0 };
  const periodS = 60 / bpm;
  const uniqueTimes = [...new Set(notes.map((n) => Math.round(n.start * 1000) / 1000))].sort((a, b) => a - b);
  const inside = uniqueTimes.filter((t) => t >= beats[0] - periodS && t <= beats[beats.length - 1] + periodS);
  if (inside.length < 6) return { delay: 0, subdivision: null, concentration: 0 };
  const phaseBeats = inside.map((t) => beatPositionAtTime(beats, t));
  const candidates = ONSET_SUBDIVISIONS.filter((s) => periodS / (2 * s) >= MAX_ONSET_DELAY_S);
  if (!candidates.length) return { delay: 0, subdivision: null, concentration: 0 };

  let bestSub = candidates[0], bestConc = -1, bestDelayBeats = 0;
  for (const s of candidates) {
    let re = 0, im = 0;
    for (const pb of phaseBeats) {
      const frac = ((pb * s) % 1 + 1) % 1;
      const ang = 2 * Math.PI * frac;
      re += Math.cos(ang);
      im += Math.sin(ang);
    }
    re /= phaseBeats.length;
    im /= phaseBeats.length;
    const conc = Math.hypot(re, im);
    const delayBeats = Math.atan2(im, re) / (2 * Math.PI * s);
    // Prefer simpler subdivisions unless a finer/triplet subdivision is meaningfully tighter.
    if (conc > bestConc + 0.04) {
      bestConc = conc;
      bestSub = s;
      bestDelayBeats = delayBeats;
    }
  }
  if (bestConc < 0.35) return { delay: 0, subdivision: null, concentration: bestConc };
  return {
    delay: bestDelayBeats * periodS,
    subdivision: bestSub,
    concentration: bestConc,
  };
}

/** Select only complete audio windows and prefer notes distributed across the requested bars. */
export function selectAlignedWindow(notes, { bpm, bars, audioDuration, firstDownbeat = 0, onsetDelay = 0, beatGrid = null }) {
  const effectiveBpm = beatGrid?.bpm > 0 ? beatGrid.bpm : bpm;
  const rawBeats = Array.isArray(beatGrid?.beats) && beatGrid.beats.length >= 2 ? smoothedBeats(beatGrid.beats) : null;
  const downbeatSec = Number.isFinite(beatGrid?.first_downbeat) ? beatGrid.first_downbeat : firstDownbeat;

  if (rawBeats) {
    const measured = estimateSubdivisionAndDelay(notes, rawBeats, effectiveBpm);
    const delay = Number.isFinite(beatGrid?.onset_delay) && beatGrid.onset_delay !== 0
      ? beatGrid.onset_delay
      : measured.delay;
    const subdivision = beatGrid?.beat_subdivision ?? measured.subdivision ?? null;
    const d0 = nearestBeatIndex(rawBeats, downbeatSec);
    const meter = beatGrid?.beats_per_bar && beatGrid.beats_per_bar > 0 ? beatGrid.beats_per_bar : 4;
    const windowBeatsCount = bars * 4;
    // When beats_per_bar is unknown (null), evaluate all 4 beat phases so downbeats/backbeats lock in.
    const phaseOffsets = beatGrid?.beats_per_bar ? [0] : [0, 1, 2, 3];
    const candidates = [];
    for (const phase of phaseOffsets) {
      const anchor = d0 + phase;
      const minK = Math.ceil((-anchor) / meter);
      for (let k = minK; ; k++) {
        const bStart = anchor + k * meter;
        const s0 = beatTimeAtIndex(rawBeats, bStart);
        const sEnd = beatTimeAtIndex(rawBeats, bStart + windowBeatsCount);
        if (s0 < -0.02) continue;
        if (sEnd > audioDuration + 0.05) break;
        candidates.push({ bStart, s0, sEnd });
      }
    }
    if (!candidates.length) {
      const s0 = Math.max(0, beatTimeAtIndex(rawBeats, d0));
      const sEnd = beatTimeAtIndex(rawBeats, d0 + windowBeatsCount);
      candidates.push({ bStart: d0, s0, sEnd });
    }
    let best = { ...candidates[0], score: -Infinity };
    for (const c of candidates) {
      const at = notes.filter((n) => n.start - delay >= c.s0 - 0.04 && n.start - delay < c.sEnd);
      const occupied = new Set();
      let metricBonus = 0;
      for (const n of at) {
        const relBeat = beatPositionAtTime(rawBeats, n.start - delay) - c.bStart;
        const barIdx = Math.max(0, Math.min(bars - 1, Math.floor(relBeat / 4)));
        occupied.add(barIdx);
        const beatInBar = ((relBeat % 4) + 4) % 4;
        const nearBeat = Math.abs(beatInBar - Math.round(beatInBar));
        if (nearBeat < 0.18) {
          const b = Math.round(beatInBar) % 4;
          if (n.pitch === 35 || n.pitch === 36) metricBonus += b === 0 || b === 2 ? 2.5 : 0.5;
          else if (n.pitch >= 37 && n.pitch <= 40) metricBonus += b === 1 || b === 3 ? 2.5 : 0.5;
          else metricBonus += b === 0 ? 1.5 : 0.5;
        }
      }
      const score = occupied.size * 1000 + Math.min(300, at.length) + metricBonus - c.s0 * 0.001;
      if (score > best.score) best = { ...c, score };
    }
    const windowBeats = Array.from({ length: windowBeatsCount + 1 }, (_, k) => beatTimeAtIndex(rawBeats, best.bStart + k));
    const windowDur = Math.max(0.1, best.sEnd - best.s0);
    return {
      startSec: best.s0,
      endSec: best.sEnd,
      sourceBpm: (windowBeatsCount * 60) / windowDur,
      onsetDelay: delay,
      subdivision,
      windowBeats,
      completeAudio: audioDuration - best.s0 >= windowDur - 0.05,
    };
  }

  const delay = Number.isFinite(beatGrid?.onset_delay) ? beatGrid.onset_delay : onsetDelay;
  const barSec = 240 / effectiveBpm, windowSec = bars * barSec;
  const last = Math.max(0, audioDuration - windowSec);
  const candidates = [];
  const startBase = downbeatSec >= 0 ? downbeatSec % barSec : 0;
  for (let s = downbeatSec >= 0 ? downbeatSec : startBase; s <= last + 0.001; s += barSec) {
    if (s >= 0) candidates.push(s);
  }
  if (!candidates.length) candidates.push(Math.max(0, downbeatSec));
  let best = { startSec: candidates[0], score: -Infinity };
  for (const startSec of candidates) {
    const at = notes.filter((n) => n.start - delay >= startSec - 0.04 && n.start - delay < startSec + windowSec);
    const occupied = new Set(at.map((n) => Math.max(0, Math.floor((n.start - delay - startSec) / barSec))));
    const score = occupied.size * 1000 + Math.min(300, at.length) - startSec * 0.001;
    if (score > best.score) best = { startSec, score };
  }
  const synthBeats = Array.from({ length: Math.ceil(audioDuration * effectiveBpm / 60) + 2 }, (_, k) => best.startSec + (k * 60) / effectiveBpm);
  const measured = estimateSubdivisionAndDelay(notes, synthBeats, effectiveBpm);
  return {
    startSec: best.startSec,
    endSec: best.startSec + windowSec,
    sourceBpm: effectiveBpm,
    onsetDelay: delay,
    subdivision: beatGrid?.beat_subdivision ?? measured.subdivision ?? null,
    windowBeats: null,
    completeAudio: audioDuration - best.startSec >= windowSec - 0.05,
  };
}
