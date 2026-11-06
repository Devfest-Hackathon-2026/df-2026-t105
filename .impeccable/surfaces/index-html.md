---
version: 1
slug: "index-html"
primary_target: "index.html"
related_targets: ["src/main.ts"]
---

# Ghostnotes editor (index.html / src/main.ts)

Scope: the single editor screen. Visitor mode: Operate.

Audience and task: DTM beginners write a 4–8 bar loop, ask Lyria for two takes, compare them, and comp the parts they want into their own MIDI, recording why. Hackathon judges try it for a few minutes. Constraints: three fixed tracks, 50–120 s generation wait, OS light/dark both required (user answer 2026-11-06).

## Direction contract

THESIS: A DAW editor that people who have used Ableton Live, Logic Pro, BandLab or the author's yuna-daw read instantly: transport on top, track headers left, piano roll with keyboard, bar ruler and velocity lane in the middle, inspector right. Refuses the "chat app with a piano roll" layout of the old screen, where the AI panel was the page and the editor a widget.

OWN-WORLD: Graphite studio ground in dark, paper-white in light; one cool accent for transport and selection; per-track colours (drums amber, bass teal, lead blue) on headers and notes; proposals in violet, dashed when uncertain. System UI type, tabular numerals for time and BPM. Drawn SVG icons, one stroke weight.

STORY: Play the loop, see where melody is missing, write the intent, get Take A and Take B as lanes, audition each, comp bars from either take onto the track, write the reason.

FIRST VIEWPORT: Transport with position counter and BPM, three track headers with mini clip overview, the selected track's piano roll filling the centre, the proposal inspector on the right with the intent box ready.

SIGNATURE: Take comping. The two proposals sit as take lanes above the roll; clicking a bar in a take lane (or dragging across bars) comps that bar onto the track, like Logic's quick swipe comping, and the lanes show which bars came from which take.

RISK: Narrow screens; the inspector collapses below the roll under 1100 px.

seed: none (canon path; user asked for familiar DAW conventions with named references)
