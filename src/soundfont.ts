import * as Tone from "tone";
import { WorkletSynthesizer } from "spessasynth_lib";
import { SoundBankLoader, SpessaSynthProcessor } from "spessasynth_core";
import workletUrl from "spessasynth_lib/dist/spessasynth_processor.min.js?url";
import { trackRole } from "./state";
import type { Note, Project, Track, TrackId, TrackRole } from "./state";

const URL_SF = `${import.meta.env.BASE_URL}soundfonts/MuseScore_General.sf3`;
let bankBytes: Promise<ArrayBuffer> | undefined;
function bytes() {
  return bankBytes ??= fetch(URL_SF).then((r) => {
    if (!r.ok) throw new Error(`音源を読み込めませんでした（${r.status}）。再読み込みしてください`);
    return r.arrayBuffer();
  }).catch((e) => { bankBytes = undefined; throw e; });
}

export type SoundFontPreset = {
  id: string;
  name: string;
  group: string;
  program: number;
  role: TrackRole;
  instrument: string;
};

export const SOUNDFONT_PRESETS: SoundFontPreset[] = [
  // 鍵盤・マレット
  { id: "sf:0", name: "ピアノ (Grand Piano)", group: "鍵盤・マレット", program: 0, role: "lead", instrument: "acoustic_piano" },
  { id: "sf:1", name: "ブライトピアノ (Bright Piano)", group: "鍵盤・マレット", program: 1, role: "lead", instrument: "acoustic_piano" },
  { id: "sf:2", name: "エレキグランド (Electric Grand)", group: "鍵盤・マレット", program: 2, role: "lead", instrument: "electric_piano" },
  { id: "sf:3", name: "ホンキートンク (Honky-Tonk)", group: "鍵盤・マレット", program: 3, role: "lead", instrument: "acoustic_piano" },
  { id: "sf:4", name: "エレピ (Tine EP)", group: "鍵盤・マレット", program: 4, role: "lead", instrument: "electric_piano" },
  { id: "sf:5", name: "FMエレピ (FM EP)", group: "鍵盤・マレット", program: 5, role: "lead", instrument: "electric_piano" },
  { id: "sf:6", name: "ハープシコード (Harpsichord)", group: "鍵盤・マレット", program: 6, role: "lead", instrument: "acoustic_piano" },
  { id: "sf:7", name: "クラビネット (Clavinet)", group: "鍵盤・マレット", program: 7, role: "lead", instrument: "electric_piano" },
  { id: "sf:8", name: "チェレスタ (Celesta)", group: "鍵盤・マレット", program: 8, role: "lead", instrument: "chromatic_percussion" },
  { id: "sf:9", name: "グロッケン (Glockenspiel)", group: "鍵盤・マレット", program: 9, role: "lead", instrument: "chromatic_percussion" },
  { id: "sf:10", name: "オルゴール (Music Box)", group: "鍵盤・マレット", program: 10, role: "lead", instrument: "chromatic_percussion" },
  { id: "sf:11", name: "ヴィブラフォン (Vibraphone)", group: "鍵盤・マレット", program: 11, role: "lead", instrument: "chromatic_percussion" },
  { id: "sf:12", name: "マリンバ (Marimba)", group: "鍵盤・マレット", program: 12, role: "lead", instrument: "chromatic_percussion" },
  { id: "sf:13", name: "シロフォン (Xylophone)", group: "鍵盤・マレット", program: 13, role: "lead", instrument: "chromatic_percussion" },
  { id: "sf:14", name: "チューブラーベル (Tubular Bells)", group: "鍵盤・マレット", program: 14, role: "lead", instrument: "chromatic_percussion" },
  { id: "sf:15", name: "ダルシマー (Dulcimer)", group: "鍵盤・マレット", program: 15, role: "lead", instrument: "chromatic_percussion" },
  { id: "sf:16", name: "ドローバーオルガン (Drawbar Organ)", group: "鍵盤・マレット", program: 16, role: "lead", instrument: "organ" },
  { id: "sf:17", name: "パーカッシブオルガン (Percussive Organ)", group: "鍵盤・マレット", program: 17, role: "lead", instrument: "organ" },
  { id: "sf:18", name: "ロックオルガン (Rock Organ)", group: "鍵盤・マレット", program: 18, role: "lead", instrument: "organ" },
  { id: "sf:19", name: "チャーチオルガン (Church Organ)", group: "鍵盤・マレット", program: 19, role: "lead", instrument: "organ" },
  { id: "sf:20", name: "リードオルガン (Reed Organ)", group: "鍵盤・マレット", program: 20, role: "lead", instrument: "organ" },
  { id: "sf:21", name: "アコーディオン (Accordion)", group: "鍵盤・マレット", program: 21, role: "lead", instrument: "organ" },
  { id: "sf:22", name: "ハーモニカ (Harmonica)", group: "鍵盤・マレット", program: 22, role: "lead", instrument: "organ" },
  { id: "sf:23", name: "バンドネオン (Bandoneon)", group: "鍵盤・マレット", program: 23, role: "lead", instrument: "organ" },

  // ギター・ベース
  { id: "sf:24", name: "アコースティックギター (Nylon Guitar)", group: "ギター・ベース", program: 24, role: "lead", instrument: "acoustic_guitar" },
  { id: "sf:25", name: "スチールギター (Steel Guitar)", group: "ギター・ベース", program: 25, role: "lead", instrument: "acoustic_guitar" },
  { id: "sf:26", name: "ジャズギター (Jazz Guitar)", group: "ギター・ベース", program: 26, role: "lead", instrument: "clean_electric_guitar" },
  { id: "sf:27", name: "エレキギター (Clean Guitar)", group: "ギター・ベース", program: 27, role: "lead", instrument: "clean_electric_guitar" },
  { id: "sf:28", name: "ミュートギター (Muted Guitar)", group: "ギター・ベース", program: 28, role: "lead", instrument: "clean_electric_guitar" },
  { id: "sf:29", name: "オーバードライブギター (Overdrive)", group: "ギター・ベース", program: 29, role: "lead", instrument: "distorted_electric_guitar" },
  { id: "sf:30", name: "ディストーションギター (Distortion)", group: "ギター・ベース", program: 30, role: "lead", instrument: "distorted_electric_guitar" },
  { id: "sf:31", name: "ギターハーモニクス (Harmonics)", group: "ギター・ベース", program: 31, role: "lead", instrument: "clean_electric_guitar" },
  { id: "sf:32", name: "アコースティックベース (Acoustic Bass)", group: "ギター・ベース", program: 32, role: "bass", instrument: "acoustic_bass" },
  { id: "sf:33", name: "エレキベース (Fingered Bass)", group: "ギター・ベース", program: 33, role: "bass", instrument: "electric_bass" },
  { id: "sf:34", name: "ピックベース (Picked Bass)", group: "ギター・ベース", program: 34, role: "bass", instrument: "electric_bass" },
  { id: "sf:35", name: "フレットレスベース (Fretless Bass)", group: "ギター・ベース", program: 35, role: "bass", instrument: "electric_bass" },
  { id: "sf:36", name: "スラップベース 1 (Slap Bass 1)", group: "ギター・ベース", program: 36, role: "bass", instrument: "electric_bass" },
  { id: "sf:37", name: "スラップベース 2 (Slap Bass 2)", group: "ギター・ベース", program: 37, role: "bass", instrument: "electric_bass" },
  { id: "sf:38", name: "シンセベース 1 (Synth Bass 1)", group: "ギター・ベース", program: 38, role: "bass", instrument: "electric_bass" },
  { id: "sf:39", name: "シンセベース 2 (Synth Bass 2)", group: "ギター・ベース", program: 39, role: "bass", instrument: "electric_bass" },

  // ストリングス・オーケストラ
  { id: "sf:40", name: "バイオリン (Violin)", group: "ストリングス・オーケストラ", program: 40, role: "lead", instrument: "violin" },
  { id: "sf:41", name: "ビオラ (Viola)", group: "ストリングス・オーケストラ", program: 41, role: "lead", instrument: "viola" },
  { id: "sf:42", name: "チェロ (Cello)", group: "ストリングス・オーケストラ", program: 42, role: "lead", instrument: "cello" },
  { id: "sf:43", name: "コントラバス (Contrabass)", group: "ストリングス・オーケストラ", program: 43, role: "bass", instrument: "contrabass" },
  { id: "sf:44", name: "トレモロストリングス (Tremolo Strings)", group: "ストリングス・オーケストラ", program: 44, role: "lead", instrument: "string_ensemble" },
  { id: "sf:45", name: "ピッツィカート (Pizzicato Strings)", group: "ストリングス・オーケストラ", program: 45, role: "lead", instrument: "string_ensemble" },
  { id: "sf:46", name: "ハープ (Orchestral Harp)", group: "ストリングス・オーケストラ", program: 46, role: "lead", instrument: "orchestral_harp" },
  { id: "sf:47", name: "ティンパニ (Timpani)", group: "ストリングス・オーケストラ", program: 47, role: "lead", instrument: "timpani" },
  { id: "sf:48", name: "ストリングス (String Ensemble 1)", group: "ストリングス・オーケストラ", program: 48, role: "lead", instrument: "string_ensemble" },
  { id: "sf:49", name: "スローストリングス (String Ensemble 2)", group: "ストリングス・オーケストラ", program: 49, role: "lead", instrument: "string_ensemble" },
  { id: "sf:50", name: "シンセストリングス 1 (Synth Strings 1)", group: "ストリングス・オーケストラ", program: 50, role: "lead", instrument: "synth_strings" },
  { id: "sf:51", name: "シンセストリングス 2 (Synth Strings 2)", group: "ストリングス・オーケストラ", program: 51, role: "lead", instrument: "synth_strings" },
  { id: "sf:52", name: "クワイア (Choir Aahs)", group: "ストリングス・オーケストラ", program: 52, role: "lead", instrument: "voice" },
  { id: "sf:53", name: "ボイス (Voice Oohs)", group: "ストリングス・オーケストラ", program: 53, role: "lead", instrument: "voice" },
  { id: "sf:54", name: "シンセボイス (Synth Voice)", group: "ストリングス・オーケストラ", program: 54, role: "lead", instrument: "voice" },
  { id: "sf:55", name: "オーケストラヒット (Orchestra Hit)", group: "ストリングス・オーケストラ", program: 55, role: "lead", instrument: "orchestra_hit" },

  // 管楽器・リード
  { id: "sf:56", name: "トランペット (Trumpet)", group: "管楽器・リード", program: 56, role: "lead", instrument: "trumpet" },
  { id: "sf:57", name: "トロンボーン (Trombone)", group: "管楽器・リード", program: 57, role: "lead", instrument: "trombone" },
  { id: "sf:58", name: "チューバ (Tuba)", group: "管楽器・リード", program: 58, role: "bass", instrument: "tuba" },
  { id: "sf:59", name: "ミュートトランペット (Muted Trumpet)", group: "管楽器・リード", program: 59, role: "lead", instrument: "trumpet" },
  { id: "sf:60", name: "ホルン (French Horn)", group: "管楽器・リード", program: 60, role: "lead", instrument: "french_horn" },
  { id: "sf:61", name: "ブラスセクション (Brass Section)", group: "管楽器・リード", program: 61, role: "lead", instrument: "brass_section" },
  { id: "sf:62", name: "シンセブラス 1 (Synth Brass 1)", group: "管楽器・リード", program: 62, role: "lead", instrument: "brass_section" },
  { id: "sf:63", name: "シンセブラス 2 (Synth Brass 2)", group: "管楽器・リード", program: 63, role: "lead", instrument: "brass_section" },
  { id: "sf:64", name: "ソプラノサックス (Soprano Sax)", group: "管楽器・リード", program: 64, role: "lead", instrument: "soprano_and_alto_sax" },
  { id: "sf:65", name: "アルトサックス (Alto Sax)", group: "管楽器・リード", program: 65, role: "lead", instrument: "soprano_and_alto_sax" },
  { id: "sf:66", name: "テナーサックス (Tenor Sax)", group: "管楽器・リード", program: 66, role: "lead", instrument: "tenor_sax" },
  { id: "sf:67", name: "バリトンサックス (Baritone Sax)", group: "管楽器・リード", program: 67, role: "lead", instrument: "baritone_sax" },
  { id: "sf:68", name: "オーボエ (Oboe)", group: "管楽器・リード", program: 68, role: "lead", instrument: "oboe" },
  { id: "sf:69", name: "イングリッシュホルン (English Horn)", group: "管楽器・リード", program: 69, role: "lead", instrument: "english_horn" },
  { id: "sf:70", name: "ファゴット (Bassoon)", group: "管楽器・リード", program: 70, role: "lead", instrument: "bassoon" },
  { id: "sf:71", name: "クラリネット (Clarinet)", group: "管楽器・リード", program: 71, role: "lead", instrument: "clarinet" },
  { id: "sf:72", name: "ピッコロ (Piccolo)", group: "管楽器・リード", program: 72, role: "lead", instrument: "flutes" },
  { id: "sf:73", name: "フルート (Flute)", group: "管楽器・リード", program: 73, role: "lead", instrument: "flutes" },
  { id: "sf:74", name: "リコーダー (Recorder)", group: "管楽器・リード", program: 74, role: "lead", instrument: "flutes" },
  { id: "sf:75", name: "パンフルート (Pan Flute)", group: "管楽器・リード", program: 75, role: "lead", instrument: "flutes" },
  { id: "sf:76", name: "ボトルブロウ (Blown Bottle)", group: "管楽器・リード", program: 76, role: "lead", instrument: "flutes" },
  { id: "sf:77", name: "尺八 (Shakuhachi)", group: "管楽器・リード", program: 77, role: "lead", instrument: "flutes" },
  { id: "sf:78", name: "ホイッスル (Whistle)", group: "管楽器・リード", program: 78, role: "lead", instrument: "flutes" },
  { id: "sf:79", name: "オカリナ (Ocarina)", group: "管楽器・リード", program: 79, role: "lead", instrument: "flutes" },

  // シンセ・パッド・民族楽器
  { id: "sf:80", name: "シンセリード Square (Lead 1)", group: "シンセ・パッド・民族", program: 80, role: "lead", instrument: "synth_lead" },
  { id: "sf:81", name: "シンセリード Saw (Lead 2)", group: "シンセ・パッド・民族", program: 81, role: "lead", instrument: "synth_lead" },
  { id: "sf:82", name: "カリオペリード (Lead 3 Calliope)", group: "シンセ・パッド・民族", program: 82, role: "lead", instrument: "synth_lead" },
  { id: "sf:83", name: "チフリード (Lead 4 Chiff)", group: "シンセ・パッド・民族", program: 83, role: "lead", instrument: "synth_lead" },
  { id: "sf:84", name: "チャランゴリード (Lead 5 Charang)", group: "シンセ・パッド・民族", program: 84, role: "lead", instrument: "synth_lead" },
  { id: "sf:85", name: "ボイスリード (Lead 6 Voice)", group: "シンセ・パッド・民族", program: 85, role: "lead", instrument: "synth_lead" },
  { id: "sf:86", name: "フィフスリード (Lead 7 Fifths)", group: "シンセ・パッド・民族", program: 86, role: "lead", instrument: "synth_lead" },
  { id: "sf:87", name: "ベース＆リード (Lead 8 Bass+Lead)", group: "シンセ・パッド・民族", program: 87, role: "lead", instrument: "synth_lead" },
  { id: "sf:88", name: "ファンタジアパッド (Pad 1 Fantasia)", group: "シンセ・パッド・民族", program: 88, role: "lead", instrument: "synth_pad" },
  { id: "sf:89", name: "ウォームパッド (Pad 2 Warm)", group: "シンセ・パッド・民族", program: 89, role: "lead", instrument: "synth_pad" },
  { id: "sf:90", name: "ポリシンセパッド (Pad 3 Polysynth)", group: "シンセ・パッド・民族", program: 90, role: "lead", instrument: "synth_pad" },
  { id: "sf:91", name: "クワイアパッド (Pad 4 Choir)", group: "シンセ・パッド・民族", program: 91, role: "lead", instrument: "synth_pad" },
  { id: "sf:92", name: "グラスパッド (Pad 5 Bowed)", group: "シンセ・パッド・民族", program: 92, role: "lead", instrument: "synth_pad" },
  { id: "sf:93", name: "メタリックパッド (Pad 6 Metallic)", group: "シンセ・パッド・民族", program: 93, role: "lead", instrument: "synth_pad" },
  { id: "sf:94", name: "ハローパッド (Pad 7 Halo)", group: "シンセ・パッド・民族", program: 94, role: "lead", instrument: "synth_pad" },
  { id: "sf:95", name: "スウィープパッド (Pad 8 Sweep)", group: "シンセ・パッド・民族", program: 95, role: "lead", instrument: "synth_pad" },
  { id: "sf:96", name: "アイスレイン (FX 1 Rain)", group: "シンセ・パッド・民族", program: 96, role: "lead", instrument: "synth_pad" },
  { id: "sf:97", name: "サウンドトラック (FX 2 Soundtrack)", group: "シンセ・パッド・民族", program: 97, role: "lead", instrument: "synth_pad" },
  { id: "sf:98", name: "クリスタル (FX 3 Crystal)", group: "シンセ・パッド・民族", program: 98, role: "lead", instrument: "chromatic_percussion" },
  { id: "sf:99", name: "アトモスフィア (FX 4 Atmosphere)", group: "シンセ・パッド・民族", program: 99, role: "lead", instrument: "synth_pad" },
  { id: "sf:100", name: "ブライトネス (FX 5 Brightness)", group: "シンセ・パッド・民族", program: 100, role: "lead", instrument: "synth_lead" },
  { id: "sf:101", name: "ゴブリン (FX 6 Goblins)", group: "シンセ・パッド・民族", program: 101, role: "lead", instrument: "synth_pad" },
  { id: "sf:102", name: "エコードロップス (FX 7 Echoes)", group: "シンセ・パッド・民族", program: 102, role: "lead", instrument: "synth_pad" },
  { id: "sf:103", name: "スターテーマ (FX 8 Sci-Fi)", group: "シンセ・パッド・民族", program: 103, role: "lead", instrument: "synth_pad" },
  { id: "sf:104", name: "シタール (Sitar)", group: "シンセ・パッド・民族", program: 104, role: "lead", instrument: "acoustic_guitar" },
  { id: "sf:105", name: "バンジョー (Banjo)", group: "シンセ・パッド・民族", program: 105, role: "lead", instrument: "acoustic_guitar" },
  { id: "sf:106", name: "三味線 (Shamisen)", group: "シンセ・パッド・民族", program: 106, role: "lead", instrument: "acoustic_guitar" },
  { id: "sf:107", name: "琴 (Koto)", group: "シンセ・パッド・民族", program: 107, role: "lead", instrument: "orchestral_harp" },
  { id: "sf:108", name: "カリンバ (Kalimba)", group: "シンセ・パッド・民族", program: 108, role: "lead", instrument: "chromatic_percussion" },
  { id: "sf:109", name: "バグパイプ (Bagpipe)", group: "シンセ・パッド・民族", program: 109, role: "lead", instrument: "oboe" },
  { id: "sf:110", name: "フィドル (Fiddle)", group: "シンセ・パッド・民族", program: 110, role: "lead", instrument: "violin" },
  { id: "sf:111", name: "シャナイ (Shanai)", group: "シンセ・パッド・民族", program: 111, role: "lead", instrument: "oboe" },
  { id: "sf:112", name: "ティンカーベル (Tinkle Bell)", group: "シンセ・パッド・民族", program: 112, role: "lead", instrument: "chromatic_percussion" },
  { id: "sf:113", name: "アゴゴ (Agogo)", group: "シンセ・パッド・民族", program: 113, role: "lead", instrument: "chromatic_percussion" },
  { id: "sf:114", name: "スティールドラム (Steel Drums)", group: "シンセ・パッド・民族", program: 114, role: "lead", instrument: "chromatic_percussion" },
  { id: "sf:115", name: "ウッドブロック (Woodblock)", group: "シンセ・パッド・民族", program: 115, role: "lead", instrument: "chromatic_percussion" },
  { id: "sf:116", name: "太鼓 (Taiko Drum)", group: "シンセ・パッド・民族", program: 116, role: "lead", instrument: "timpani" },
  { id: "sf:117", name: "メロディックタム (Melodic Tom)", group: "シンセ・パッド・民族", program: 117, role: "lead", instrument: "timpani" },
  { id: "sf:118", name: "シンセドラム (Synth Drum)", group: "シンセ・パッド・民族", program: 118, role: "lead", instrument: "timpani" },

  // ドラムキット (Bank 128)
  { id: "drum:0", name: "ドラム (Standard Kit)", group: "ドラムキット", program: 0, role: "drums", instrument: "drums" },
  { id: "drum:8", name: "ドラム (Room Kit)", group: "ドラムキット", program: 8, role: "drums", instrument: "drums" },
  { id: "drum:16", name: "ドラム (Power Kit)", group: "ドラムキット", program: 16, role: "drums", instrument: "drums" },
  { id: "drum:24", name: "ドラム (Electronic Kit)", group: "ドラムキット", program: 24, role: "drums", instrument: "drums" },
  { id: "drum:25", name: "ドラム (TR-808 Kit)", group: "ドラムキット", program: 25, role: "drums", instrument: "drums" },
  { id: "drum:32", name: "ドラム (Jazz Kit)", group: "ドラムキット", program: 32, role: "drums", instrument: "drums" },
  { id: "drum:40", name: "ドラム (Brush Kit)", group: "ドラムキット", program: 40, role: "drums", instrument: "drums" },
  { id: "drum:48", name: "ドラム (Orchestra Kit)", group: "ドラムキット", program: 48, role: "drums", instrument: "drums" },
];

const LEGACY_PRESET_MAP: Record<string, string> = {
  square: "sf:80",
  saw: "sf:81",
  soft: "sf:89",
  pluck: "sf:45",
  sub: "sf:38",
};

export function normalizePresetId(role: TrackRole, preset?: string): string {
  if (preset && LEGACY_PRESET_MAP[preset]) return LEGACY_PRESET_MAP[preset];
  if (preset && (/^sf:\d+$/.test(preset) || /^drum:\d+$/.test(preset))) return preset;
  if (role === "drums") return "drum:0";
  if (role === "bass") return "sf:33";
  return "sf:0";
}

export function findSoundFontPreset(role: TrackRole, preset?: string): SoundFontPreset {
  const norm = normalizePresetId(role, preset);
  return SOUNDFONT_PRESETS.find((p) => p.id === norm) ?? (role === "drums" ? SOUNDFONT_PRESETS.find((p) => p.id === "drum:0")! : SOUNDFONT_PRESETS[0]);
}

export function shortPresetName(preset: SoundFontPreset): string {
  return preset.name.replace(/\s*\([^)]*\)\s*$/, "");
}

export function programFor(id: TrackId, preset?: string): number {
  const role: TrackRole = id === "drums" || preset?.startsWith("drum:") ? "drums" : id === "bass" ? "bass" : "lead";
  const norm = normalizePresetId(role, preset);
  if (norm.startsWith("drum:")) return Number(norm.slice(5)) || 0;
  if (norm.startsWith("sf:")) return Number(norm.slice(3)) || 0;
  return role === "drums" ? 0 : role === "bass" ? 33 : 0;
}

export function midiProgram(id: TrackId, preset?: string): number {
  return programFor(id, preset);
}

const channel = (id: TrackId, ghost = false) => (id === "drums" ? 9 : id === "bass" ? 1 : 0) + (ghost ? (id === "drums" ? 1 : 2) : 0);

export class SoundFontPlayer {
  private synths: WorkletSynthesizer[] = [];
  private loading?: Promise<void>;
  private moduleReady?: Promise<void>;
  private version = 0;
  private extraChannels = new Map<string,number>();
  private nextChannel = 4;
  private channelFor(track:Track,ghost=false) {
    if(!track.id.startsWith("part:")&&!track.id.startsWith("track:"))return channel(track.id,ghost);
    const key=track.id+"/"+ghost;
    if(!this.extraChannels.has(key)) {
      while([9,10].includes(this.nextChannel))this.nextChannel++;
      this.extraChannels.set(key,this.nextChannel++);
    }
    return this.extraChannels.get(key)!;
  }
  async ready(tracks:Track[] = []) {
    for(const t of tracks){this.channelFor(t);this.channelFor(t,true)}
    if(this.loading)await this.loading;
    const needed=Math.floor(Math.max(10,...this.extraChannels.values())/16)+1;
    if(this.synths.length>=needed){
      for(const t of tracks)for(const ghost of [false,true]){const index=this.channelFor(t,ghost);this.synths[Math.floor(index/16)].midiChannels[index%16].setDrums((t.role??t.id)==="drums")}
      return;
    }
    this.loading=this.prepare(needed,tracks).finally(()=>{this.loading=undefined});
    return this.loading;
  }
  private async prepare(needed:number,tracks:Track[]) {
    const data=await bytes(),ctx=Tone.getContext();
    this.moduleReady ??= ctx.addAudioWorkletModule(workletUrl);
    await this.moduleReady;
    // Keep each worklet at its native 16 channels. The library emits reset events before
    // channelAdded when expanding, so multiple fixed banks avoid its state-sync race.
    while(this.synths.length<needed) {
      const synth=new WorkletSynthesizer(ctx.rawContext as AudioContext,{
        audioNodeCreators:{worklet:(_ctx,name,opts)=>ctx.createAudioWorkletNode(name,opts)},
      });
      try {
        synth.connect(ctx.rawContext.destination);await synth.isReady;
        await synth.soundBankManager.addSoundBank(data.slice(0),"MuseScore_General");
        this.synths.push(synth);
      } catch(e){synth.destroy();throw e}
    }
    for(const t of tracks)for(const ghost of [false,true]) {
      const index=this.channelFor(t,ghost),synth=this.synths[Math.floor(index/16)];
      synth.midiChannels[index%16].setDrums((t.role??t.id)==="drums");
    }
  }
  play(track:Track,n:Note,time:number,duration:number,ghost=false) {
    const isDrums=(track.role??track.id)==="drums"||track.preset?.startsWith("drum:");
    const program=programFor(isDrums?"drums":(track.role??track.id),track.preset);
    const index=this.channelFor(track,ghost),synth=this.synths[Math.floor(index/16)],ch=index%16;
    if(!synth)return true;
    synth.midiChannels[ch].setDrums(!!isDrums);
    synth.programChange(ch,program,{time});
    synth.controllerChange(ch,7,Math.min(127,Math.round(90*10**((track.volume??0)/20))),{time});
    synth.noteOn(ch,n.pitch,Math.round((.3+.7*n.vel)*100),{time});
    synth.noteOff(ch,n.pitch,{time:time+duration});return true;
  }
  stop(){const version=++this.version;for(const s of this.synths)s.stopAll(true);setTimeout(()=>{if(this.version===version)for(const s of this.synths)s.stopAll(true)},150)}
  resume(){++this.version}
}

/** Render the same SF3 presets and track gains used during playback. */
export async function renderSoundFont(p: Project, tracks: Track[], loops: number, duration: number): Promise<AudioBuffer> {
  const sr = 44100;
  const synth = new SpessaSynthProcessor(sr, { effectsEnabled: false });
  try {
    await synth.ready;
    synth.soundBankManager.addSoundBank(SoundBankLoader.fromArrayBuffer((await bytes()).slice(0)), "MuseScore_General");
    const buffer = new AudioBuffer({ numberOfChannels: 2, length: Math.ceil(duration * sr), sampleRate: sr });
    const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
    const sixteenth = 60 / p.bpm / 4, loopSec = sixteenth * p.bars * 16;
    const events: { sample: number; on: boolean; ch: number; note: Note }[] = [];
    let nextChannel = 0;
    for (const t of tracks) {
      const isDrums = trackRole(p, t.id) === "drums" || t.preset?.startsWith("drum:");
      const program = programFor(isDrums ? "drums" : trackRole(p,t.id), t.preset);
      if(nextChannel===9)nextChannel++;
      const ch = nextChannel++;
      while(ch>=synth.midiChannels.length)synth.createMIDIChannel();
      if(isDrums)synth.midiChannels[ch].setDrums(true);
      synth.programChange(ch, program);
      synth.controllerChange(ch, 7, Math.min(127, Math.round(90 * 10 ** ((t.volume ?? 0) / 20))));
      for (let k = 0; k < loops; k++) for (const note of t.notes) {
        if (note.step >= p.bars * 16) continue;
        const start = k * loopSec + note.step * sixteenth;
        events.push({ sample: Math.round(start * sr), on: true, ch, note }, { sample: Math.round((start + note.len * sixteenth * 0.95) * sr), on: false, ch, note });
      }
    }
    events.sort((a, b) => a.sample - b.sample || Number(a.on) - Number(b.on));
    let i = 0;
    for (let pos = 0; pos < buffer.length;) {
      while (i < events.length && events[i].sample <= pos) {
        const e = events[i++];
        if (e.on) synth.noteOn(e.ch, e.note.pitch, Math.round((0.3 + 0.7 * e.note.vel) * 100));
        else synth.noteOff(e.ch, e.note.pitch);
      }
      const size = Math.min(128, buffer.length - pos, i < events.length ? events[i].sample - pos : 128);
      synth.process(left, right, pos, size);
      pos += size;
    }
    return buffer;
  } finally { synth.destroy(); }
}
