// Keep instrument groups, polyphony and one shared clock. Do not force all notes into a lead range.
// Canonical 35 MuScriptor instrument groups (MT3_FULL_PLUS_GROUP_NAMES) mapped to MuScriptor's canonical GM programs.
export const INSTRUMENTS = {
  acoustic_piano: [0, 'ピアノ'],
  electric_piano: [4, 'エレピ'],
  chromatic_percussion: [9, 'グロッケン / マレット'],
  organ: [19, 'オルガン'],
  acoustic_guitar: [24, 'アコースティックギター'],
  clean_electric_guitar: [27, 'エレキギター'],
  distorted_electric_guitar: [30, 'ディストーションギター'],
  acoustic_bass: [32, 'アコースティックベース'],
  electric_bass: [33, 'エレキベース'],
  violin: [40, 'バイオリン'],
  viola: [41, 'ビオラ'],
  cello: [42, 'チェロ'],
  contrabass: [43, 'コントラバス'],
  orchestral_harp: [46, 'ハープ'],
  timpani: [47, 'ティンパニ'],
  string_ensemble: [48, 'ストリングス'],
  synth_strings: [50, 'シンセストリングス'],
  voice: [52, '声'],
  orchestra_hit: [55, 'オーケストラヒット'],
  trumpet: [56, 'トランペット'],
  trombone: [57, 'トロンボーン'],
  tuba: [58, 'チューバ'],
  french_horn: [60, 'ホルン'],
  brass_section: [61, 'ブラス'],
  soprano_and_alto_sax: [65, 'サックス'],
  tenor_sax: [66, 'テナーサックス'],
  baritone_sax: [67, 'バリトンサックス'],
  oboe: [68, 'オーボエ'],
  english_horn: [69, 'イングリッシュホルン'],
  bassoon: [70, 'ファゴット'],
  clarinet: [71, 'クラリネット'],
  flutes: [73, 'フルート'],
  synth_lead: [80, 'シンセリード'],
  synth_pad: [89, 'パッド'],
  drums: [0, 'ドラム'],
};

const BASS_INSTRUMENTS = new Set(['acoustic_bass', 'electric_bass', 'contrabass', 'tuba']);

export function roundStep(step) {
  return Math.round(step * 960) / 960;
}

/** Map an audio timestamp (seconds) to steps using tracked beat timestamps (piecewise linear, 4 steps/beat). */
export function timeToStepWithBeats(timeSec, windowBeats) {
  const n = windowBeats.length;
  if (n < 2) return 0;
  if (timeSec <= windowBeats[0]) {
    const dt = Math.max(1e-6, windowBeats[1] - windowBeats[0]);
    return ((timeSec - windowBeats[0]) / dt) * 4;
  }
  if (timeSec >= windowBeats[n - 1]) {
    const dt = Math.max(1e-6, windowBeats[n - 1] - windowBeats[n - 2]);
    return (n - 1 + (timeSec - windowBeats[n - 1]) / dt) * 4;
  }
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (windowBeats[mid] <= timeSec) lo = mid;
    else hi = mid;
  }
  const dt = Math.max(1e-6, windowBeats[hi] - windowBeats[lo]);
  return (lo + (timeSec - windowBeats[lo]) / dt) * 4;
}

export function instrumentInfo(instrument) {
  const m = /^program_(\d+)$/.exec(instrument);
  if (m) {
    const prog = Math.max(0, Math.min(127, Number(m[1])));
    const entry = Object.entries(INSTRUMENTS).find(([k, [p]]) => k !== 'drums' && p === prog);
    const role = (prog >= 32 && prog <= 39) || prog === 43 || prog === 58 ? 'bass' : 'lead';
    return { program: prog, name: entry ? entry[1] : `Program ${prog}`, role };
  }
  const [program, name] = INSTRUMENTS[instrument] ?? [0, instrument];
  return {
    program,
    name,
    role: instrument === 'drums' ? 'drums' : BASS_INSTRUMENTS.has(instrument) ? 'bass' : 'lead',
  };
}

export function notesToParts(hits, { bpm, bars, startSec = 0, transpose = 0, windowBeats = null, subdivision = null, quantizeStrength = 0 }) {
  const groups = new Map(), stepSec = 60 / bpm / 4, total = bars * 16;
  const hasBeats = Array.isArray(windowBeats) && windowBeats.length >= 2;
  const toStep = (t) => hasBeats ? timeToStepWithBeats(t, windowBeats) : (t - startSec) / stepSec;
  const isTriplet = subdivision && subdivision % 3 === 0;
  const gridStep = subdivision
    ? 4 / (isTriplet ? Math.max(6, subdivision) : Math.max(8, subdivision))
    : null;
  const earlyMargin = hasBeats || subdivision ? 0.25 : 0;

  for (const h of hits) {
    let rawStart = toStep(h.start);
    let rawEnd = toStep(h.end);
    if (rawStart >= -earlyMargin && rawStart < 0) rawStart = 0;
    if (rawStart < 0 || rawStart >= total - (earlyMargin ? 0.12 : 0)) continue;

    let step = rawStart;
    if (gridStep && quantizeStrength > 0) {
      const snapped = Math.round(step / gridStep) * gridStep;
      if (Math.abs(step - snapped) <= gridStep * 0.45) {
        step = roundStep(step + quantizeStrength * (snapped - step));
      } else {
        step = roundStep(step);
      }
      if (step >= total) continue;
    }

    const instrument = h.instrument || 'unknown';
    const info = instrumentInfo(instrument);
    const pitch = info.role === 'drums' ? h.pitch : h.pitch + transpose;
    if (pitch < 0 || pitch > 127) continue;

    const rawDur = Math.max(1 / 960, rawEnd - rawStart);
    const minLen = info.role === 'drums' && (hasBeats || subdivision) ? 0.25 : 1 / 960;
    const len = Math.max(minLen, Math.min(total - step, gridStep && quantizeStrength > 0 ? roundStep(rawDur) : rawDur));

    let g = groups.get(instrument);
    if (!g) {
      g = { instrument, ...info, notes: [] };
      groups.set(instrument, g);
    }
    const duplicate = g.notes.find((n) => Math.abs(n.step - step) < 1e-6 && n.pitch === pitch);
    if (duplicate) duplicate.len = Math.max(duplicate.len, len);
    else g.notes.push({ step, len, pitch, vel: 0.8 });
  }
  return [...groups.values()].map((g) => ({
    ...g,
    notes: g.notes.sort((a, b) => a.step - b.step || a.pitch - b.pitch),
  }));
}
