# Delicate Studio — plan

Browser audio editor replacing Adobe Audition. Waveform editing first, multitrack later. Same stack as Delicate DJ. Built on what the professional tools do best: Pro Tools, WaveLab, iZotope RX, Sequoia/Pyramix, Reaper, Cubase/Nuendo, Logic, Audition.

## Stack

- Repo `/opt/delicate-studio` (GitHub `DJoLoAo/delicate-studio`, branch `main`), axum binary on `127.0.0.1:4541`, systemd unit `delicate-studio.service` (DynamicUser). Deploys never restart `dj-app.service`.
- nginx: own host studio.delicateaudio.com (site installed by `deploy/studio_site.py`, certificate via certbot webroot). `/api/studio/` and everything outside `/api/` go to 4541; the rest of `/api/` (login, search, Locker, stream) goes to the DJ app on 4540, so the DJ accounts work unchanged with a host-only session cookie per host. COOP/COEP come from both backends. The old address dj.delicateaudio.com/studio/ redirects permanently (`deploy/studio_redirect.py`), and its `sw.js` URL serves `deploy/legacy-sw.js`, which removes the old service worker and its cache.
- Auth: the studio forwards the cookie to `127.0.0.1:4540/api/me` (one helper, `current_user`). Login, 2FA and logout use the DJ app's endpoints. Plans free/pro/gold come from there.
- Frontend: vanilla JS like the DJ app — dialog.js, i18n with the World Picker (language shared with the DJ app via `djLang`), update banner, service worker scoped to the whole Studio host. Settings such as language and keys live per host, so they start fresh on studio.delicateaudio.com.
- Audio core: Rust/WASM. Reuse `engine/` (symphonia decoding) and the decoder/worklet SharedArrayBuffer pattern. New crate `studio-dsp`, built for wasm32 (browser) and native (server batch) so both run identical code. rustfft, rubato (resampling), an own FLAC encoder in `studio-dsp` (64-bit residual and Rice arithmetic; flacenc 0.5 dropped because its Rice tables wrap on loud 24-bit material).
- Server data: `studio.db` (SQLite) for projects, presets, jobs. Locker access through the DJ app's API.

## Engine design

- Working audio in OPFS as 32-bit float blocks (~64k frames), written by a worker with sync access handles.
- A clip is an ordered list of block references. Every edit makes a new list (copy-on-write); processing writes new blocks only for the changed range. Undo/redo and history panel for free; originals untouched.
- Every process is a parameterised operation on the clip, not a baked result: it can be reopened, reordered, bypassed or removed later. Rendered blocks are a cache of that list.
- Peak pyramid per block for instant zoom from whole file to samples.
- Playback: worker reads blocks into a SAB ring, worklet plays at the file's own sample rate.
- Project JSON autosaved in OPFS for crash recovery, plus rotating backups.
- Files from the Navidrome library open read-only; saving always creates a new file (Locker or download). Nothing is written back to `/home/navidrome/music`.

## Best practice from the professional tools

### Principles (apply from step 2 on)

1. **Never lose audio.** Recordings stream to storage while they run, with the WAV/RF64 header rewritten every few seconds so a crash leaves a playable file. Projects autosave and keep the last N versions (Pro Tools session file backups). Sources are never modified.
2. **Non-destructive, render on demand.** Processing lives as an editable stack per clip (Cubase/Nuendo Direct Offline Processing, WaveLab montage clip effects). Rendering is a cache; changing a parameter re-renders only that range.
3. **Handles.** Processed ranges are rendered with extra audio on both sides (Pro Tools AudioSuite handles), so later trims and crossfades never expose unprocessed audio.
4. **No clicks from edits.** Every cut snaps to a zero crossing or gets a short automatic crossfade (WaveLab 12 crossfade option on standard edits, Sequoia/Pyramix auto crossfades). A crossfade editor shows both sides with curve and length.
5. **Sample-accurate, numeric control.** Selection start, end and length editable as numbers in samples, h:m:s.ms, timecode, bars|beats and CD frames (Audition Selection/View panel, Pro Tools counters).
6. **Level-matched A/B.** Every before/after comparison is loudness-matched (RX Compare, WaveLab 12 reference-track loudness matching), so louder never wins by accident.
7. **Keyboard first.** Keymap presets for Audition, Pro Tools, WaveLab and Reaper so users keep their muscle memory. A searchable command palette lists every action (Reaper Actions list); actions can be chained into macros (Reaper custom actions, Pro Tools 2025.10 SoundFlow macros). The assistant on `/` drives the same action list.
8. **Measure, then process.** Analysis comes first: a global analysis produces an issue list (clipping, true-peak overs, DC offset, dropouts, clicks, silence) where every finding is a jump target (WaveLab Global Analysis and Error Correction). A repair assistant proposes a chain from the analysis (RX Repair Assistant).
9. **No lock-in.** Markers export as CSV/cue, metadata stays in BWF/iXML/Vorbis/ID3, sessions export to Audition `.sesx` and Reaper `.rpp` later. Same principle as the DJ app's exports.
10. **Background work.** Renders, analysis and batch jobs run in workers or on the server with progress, while editing continues (Reaper, WaveLab background tasks).

### Editing and display

- Edit modes: Slip, Shuffle/ripple, Grid, Spot (Pro Tools); ripple on by default in the waveform view, as in Audition.
- Zoom presets 1–5 and memory locations that store selection, zoom and view, not just a time (Pro Tools memory locations); view snapshots (WaveLab).
- Waveform display: linear or dB scale, rectified view, clip indicators, spectrally coloured waveform (WaveLab 12 multi-colour waveforms, same band colouring as the DJ app).
- Transient markers with Tab to jump and snap selections to transients (WaveLab 12).
- Mid/Side as editable channels next to L/R — select and process only Mid or only Side (WaveLab, RX 11 Mid/Side mode).
- Pencil tool at sample zoom to redraw a click by hand (WaveLab pen restoration, Audition).
- Volume envelope on the clip; clip gain line in multitrack (Pro Tools clip gain).

### Recording

- Pre-record buffer: keep the last N seconds before Record is pressed, as field recorders do.
- Start and stop on input level, markers dropped by hotkey while recording, auto-split by silence afterwards.
- Punch-in/out with pre- and post-roll (Pro Tools QuickPunch) once multitrack exists.
- Loop recording into takes with swipe comping (Pro Tools playlists, Logic take folders and Quick Swipe, Reaper take lanes) — multitrack phase.
- Per-channel input meters with peak hold and clip latch; record-safe per track.

### Restoration and spectral

- Spectral display with modes attenuate, replace/interpolate and pattern on time-frequency selections (RX spectral repair); waveform/spectrogram blend slider (RX).
- Saved module chains as presets, runnable in batch (RX module chain and batch processor).
- Declick, decrackle, denoise with noise print, dehum, declip — each with a "listen to what's removed" switch (RX output-noise-only).
- Stem split and vocal/instrumental rebalance via Stemina (RX 11 Music Rebalance).
- Bleep/censor on a selection (WaveLab 12).

### Metering and loudness

- EBU R128 / ITU BS.1770: momentary, short-term, integrated, loudness range, true peak; loudness curve overlaid on the waveform (WaveLab loudness overlay).
- Phase correlation, vectorscope, spectrum analyser, bit meter; meters before and after the master section.
- Streaming preview: how Spotify, Apple Music, YouTube and others would turn the file down (RX 11 Streaming Preview).
- Loudness and peak reports per file and per album, exportable (WaveLab 12 reports).
- Null test between two versions to prove an edit or export changed only what it should (WaveLab 12 null test tracks).

### Master section and rendering

- One master chain used for both monitoring and render: effects → final level → dither (WaveLab Master Section). Dither only as the last stage, with noise shaping choices, off automatically for 32-bit float.
- Render queue running in the background; several formats in one go (WAV master + FLAC + MP3); file naming templates with tokens such as `$artist`, `$title`, `$index`, `$side` (Reaper wildcards, WaveLab naming).
- Destination presets with loudness targets (streaming, broadcast EBU −23 LUFS, podcast, club).
- Metadata embedded on export: BWF `bext` (description, originator, time reference, loudness fields), iXML, Vorbis comments, ID3, cover art; markers written to the WAV cue chunk.

### Album assembly (montage)

- Sequence tracks with gaps and crossfades, album-wide loudness consistency, CD track markers, ISRC/UPC, CD-Text, DDP export with checksum (WaveLab Montage, Sequoia CD projects).
- Vinyl pre-mastering checks for label work: side length against level, low-frequency mono/correlation, sibilance and high-frequency energy warnings, A/B side balance.
- Digital release export: tagged FLAC/WAV per track ready for Bandcamp and distributors.

### Source–destination editing

- Two areas: source (all takes and rips) and destination (the programme). Set in/out in the source and a position or in/out in the destination (3- and 4-point editing), then cut; material after the edit moves along on all tracks (Sequoia, Pyramix).
- Use case: build the best version from several vinyl rips or live takes.

### Batch and automation

- Batch processor with watch folders: drop files into a Locker folder, a saved recipe runs on the server, results land in an output folder (WaveLab Batch Processor, RX batch).
- Recipes use the same chain format as the rack, so anything built interactively can be batched.

### Projects and safety

- Project bundle export as ZIP (JSON, sources, optional render cache) for backup and moving between machines (WaveLab 12 project backup as folder/ZIP).
- Start templates: "Digitise vinyl", "Master a track", "Clean a recording", "Podcast" — each sets sample rate, meters, chains and export presets (WaveLab 12 Startup Assistant).

### Speech

- Speech-to-text transcript next to the waveform, offline and in batch (Pro Tools 2025.6/2025.10); whisper on rcn.
- Later: edit spoken audio by editing the transcript.

### Web-only advantages

- Review links: a read-only player with waveform and timecoded comments, so a client or label approves a master from a link.
- Same account, Locker and library as the DJ app; open a DJ set recording with its tracklist as markers.

### Deliberately left out for now

- Surround, Dolby Atmos and 360 Reality Audio (Pro Tools 2025.10), video/ADR, sample-library integrations. Revisit after multitrack is solid.

## Phases

### Phase 1 — Waveform editor MVP
1. Skeleton: binary, nginx location, auth via `/api/me`, shell with World Picker, dialogs, update banner. **Done, live 2026-10-21.** Moved the same day to its own host studio.delicateaudio.com.
2. Open and view. **2a done 2026-10-21:** local files (drop, Open, Ctrl/⌘ O) decoded by `studio-dsp` (WASM) into OPFS blocks, peak pyramid with band colours, overview, ruler, zoom/scroll to sample level, dB/linear, numeric selection panel (time, samples, CD frames), L/R/L+R, play/stop/loop through a worklet at the file's own rate, peak+RMS meters with clip lights, Files list with reopen and remove. **2b done 2026-10-21:** Files panel with In Studio / Library / Locker tabs; library search and Locker list stream the original into Studio with download progress and cancel; items already in Studio reopen without downloading; Library and Locker files are marked read-only originals.
3. Edit. **3a done 2026-10-21:** clip = per-channel segment lists over the read-only pool plus a per-file heap for new audio (crossfades, pasted audio), each with its own peak pyramid; waveform peaks are range queries clamped to segment edges, so edits never show cut-away audio. Cut/copy/paste/delete, silence, crop (T), insert silence; paste replaces the selection, a partial channel selection overwrites in place (Silence/Delete on L or R only keep length); 5 ms auto crossfade on every join (Off/1/3/5/10/20 ms), equal-power or linear for correlated material, silence fades kept inside the range; optional zero-crossing snap (±10 ms, same direction for both edges); undo/redo and History panel (H) with jump to any step, selection restored per step; history saved after every edit as A/B files plus rotating backups, with fallback and a notice if a save was damaged; clipboard survives file switches (stored in OPFS), cross-file paste with channel mapping (mono → both, stereo → mono average), different sample rates refused until export brings conversion; editing during playback keeps playing. **3b done 2026-10-21:** memory locations in the edit history — markers (M, also during playback), ranges from the selection, view-only locations with stored zoom (New memory location…, Pro Tools time/zoom properties); they move with the audio on every edit and come back on undo; ruler marker lane with drag to move, click to go, double-click to rename; Locations panel; recall by period-number-period, [ ] and Audition Ctrl+←/→ stepping; zoom presets 1–5 (store with Shift/Ctrl/⌘-click); command palette (Ctrl/⌘ K) with fuzzy search, recent commands, time jump, locations and files; keymap presets Adobe Audition (default), Pro Tools (incl. Commands Focus keys) and REAPER from the vendors' published lists, with any key reassignable in the palette; keys the browser reserves (Ctrl/⌘ T, Ctrl+PgUp/PgDn, Win+1–5, ⌘⌥ arrows) get a close alternative, flagged in the shortcut list. WaveLab has no published default list, so instead of a guessed preset its users set their keys in the palette; a preset follows once someone exports theirs. Right-click menu on the waveform (long-press on touch, Ctrl-click on Mac) with play, edit, selection, channel and location actions, keys of the active preset and the marker under the pointer. Ripple/slip modes move to the multitrack phase (the waveform view is always ripple).
4. Export. **4a done 2026-10-21:** Export panel (Ctrl+Shift+E, Pro Tools Ctrl+Alt+B, REAPER Ctrl+Alt+R) with whole file, selection or one file per range; several formats per render (WAV 16/24/32-bit float, RF64 above 4 GB; FLAC 16/24); resampling to 44.1–192 kHz (rubato FFT, flat to 21.8 kHz, stopband below −140 dB); master section with gain, then dither last: TPDF with noise shaping off/light/strong (Lipshitz, light above 50 kHz), none for 32-bit float; naming templates with `$name $range $index $artist $title $album $date $rate $bits`, clashing names get suffixes; background render queue that renders the audio as it was when the job started while editing, playback and file switches go on, with progress, peak and clip count, cancel and re-download; Download or straight into a Locker folder (sha256, chunked upload, duplicate detection, (2) names). Own FLAC encoder: fixed and LPC up to order 12, wasted bits, adaptive stereo decorrelation, partitioned Rice with 64-bit sums and verbatim fallback, MD5; same size as `flac -5`, bit-exact with libFLAC's test. Every OPFS write is checked, so full browser storage fails the render or edit cleanly instead of leaving a short file. **4b next:** tags (Vorbis comments, RIFF LIST, ID3), cover art, BWF `bext`, iXML, markers in the WAV cue chunk and FLAC cuesheet, destination presets with loudness targets.
5. Processes: amplify, normalize (peak/LUFS), fade handles with curves, DC offset, reverse, invert, mono/stereo/swap, Mid/Side channels; non-destructive process stack per clip with handles; level-matched A/B; pencil tool; transient markers; markers and ranges (M), export ranges as files, .cue sheet.

### Phase 2 — Vinyl and recording
6. Record from RME UC input pairs at 96 kHz/24-bit: crash-safe streaming to storage, pre-record buffer, level-triggered start/stop, hotkey markers, input meters with clip latch.
7. Auto-split by silence → range markers; Discogs release via INTAKE fills names (A1, A2, B1…) and tags; export all as FLAC to the Locker.
8. Analysis and restoration. Moved ahead of step 5 on request. **R1 done 2026-10-21:** DeClicker in a Diagnostics panel like Audition's: scan the selection or the whole file (sensitivity, longest click 1–20 ms, channels linked or each on its own), list of every click with time, length, channels and strength, click a row to zoom there, Repair the picked ones or Repair All as one undoable step, Listen to Original / Repaired / Removed only while playing, marks on the waveform; Heal the selection (Ctrl/⌘ U, also in the right-click menu) for up to 0.1 s. Native Rust in studio-dsp: AR-model click detector with a matched filter and median threshold, re-estimated without the clicks, two-sided residuals for tight edges; repair by least-squares AR interpolation from a Burg model with a noise floor, solved jointly for neighbouring clicks with a banded Cholesky; textured fill for longer heals so they keep their level. Repairs are length-preserving patches into one heap block, so the rest of the file stays bit-exact; results that an edit touched are marked changed and never applied. Measured on real CC music with injected damage: 95–100 % of clicks found with no false detections on clean audio at 44.1 and 96 kHz. **R2a done 2026-10-21:** Noise Reduction tab in the same Repair panel, modelled on Audition's Noise Reduction (process): Capture noise print from the selection (Shift+P, also in the right-click menu), kept in the browser across files and reloads (up to 20 s, refused for another sample rate); graph of the print (average with the 10–90 % band, threshold and where the noise ends up) on a log or linear frequency axis with an editable reduction curve (drag to add or move points, double-click to remove); Noise reduction %, Reduce by (dB), and under Advanced Threshold, Spectral decay rate, Precision factor (3–16 overlap), FFT size (auto by sample rate) and linked or separate channels; Listen to Original / Processed / Noise only while playing, with changes heard within a fraction of a second; Apply to the selection or the whole file in the background with progress and cancel as one undoable step, selected channels only, 20 ms blends at the edges, rest of the file bit-exact. Opened with Ctrl/⌘ Shift P in the Audition keymap. Native Rust in studio-dsp: streaming STFT with Hann windows and any overlap (exact reconstruction), Ephraim–Malah log-spectral-amplitude gain with decision-directed a-priori SNR, floor and a time constant that grows with the reduction depth so deeper settings stay free of musical noise. Chosen by measurement on real music with vinyl-like noise (signal distortion, residual-noise kurtosis, pre-echo): about 35 dB signal fidelity at 12 dB reduction with no musical noise; the browser result matches the native build to 2·10⁻⁷; about 30× real time for 44.1 kHz stereo. **R2b done 2026-10-21:** the Repair panel has the tabs Diagnostics, Noise Reduction and DeHummer. Diagnostics switches between DeClicker and DeClipper like Audition's Effect menu. DeClipper: tolerance and minimum clip size, scan finds runs at the clip level per channel and polarity and only reports clipping when the peaks are flat (bit-exact tops) or pile up at the extreme, so unclipped files say so; rebuilds each run with least-squares AR interpolation constrained to stay beyond the clipped value (order about sr/350), solved jointly with neighbours; list, Listen and Repair All as for clicks; reports the clip level and how far the rebuilt peaks go above full scale. Measured on real music: at 1–3 dB of overdrive the clipped samples typically come back 8–25 dB closer to the original (less on drums and dense mixes), 1–15 dB at 6 dB; no false alarms on unclipped music. DeHummer: base frequency with 50/60 Hz presets and Find (measures the hum to a few hundredths of a hertz from a low-percentile spectrum, only near 50 and 60 Hz so bass notes are not mistaken for hum, and counts the harmonics that stand out), harmonics, Q, Reduce by and harmonic slope; constant-width notches with finite depth in double precision; response graph over the measured spectrum; Listen Original / Processed / Hum only; apply in the background as one undo step. Music loses about 0.1–0.7 dB at the defaults. **Noise profile from quiet parts done 2026-10-21:** Noise Reduction has a Noise profile switch, Noise print or Quiet parts. Quiet parts finds the stretches with only noise by itself (lead-in, gaps between tracks, run-out: 1 s windows near the quietest level of the file and of the 10 s around them, so a noise floor that rises over a side is still found), takes a print from each and lets the profile follow the noise from one to the next, so the reduction stays at the set depth where a single print from the lead-in falls short; the graph marks the stretches it used and the panel says how many and how long, and warns when the music has no clear noise-only stretch. Measured on music whose noise rises 6 dB over the file: 12.0 / 12.0 / 11.6 dB off in lead-in, gap and run-out at Reduce by 12 dB, against 12.0 / 4.8 dB with a lead-in print. Capturing a print switches back to Noise print. **R3a done 2026-10-21:** spectrogram (Audition's spectral frequency display) under the waveform, Shift+D or the Spectrogram button, with a divider to share the space (double-click shows only the spectrogram); one lane per channel, logarithmic or linear frequency scale with labels, resolution (FFT size, auto by sample rate) and range in Settings, pointer readout of frequency and level, time selection, cursor, markers and playhead as on the waveform, kept on across reloads. Native Rust in studio-dsp computes 128-column tiles in the worker (Hann window, real FFT, one window per column when zoomed in and up to four averaged when zoomed out, peak per row on the log scale); tiles are cached, drawn as they arrive over a stretched copy of the previous view, and an edit only redraws the tiles whose audio changed. **R3b done 2026-10-22:** spectral tools in a bar on the spectrogram, like Audition's: Time selection, Marquee (E), Lasso (D) and Spot Healing Brush (B) with a size slider, pressing the key again goes back to time selection; marquee and lasso make a spectral selection (Shift adds to it) on the lane drawn in, or on all lanes with L+R, and select its time; Heal (Ctrl/⌘ U) heals the spectral selection, Delete removes the selected frequencies, each as one undo step, right-click menu has both; the brush heals on release. Heal on a time selection now goes up to 4 s: up to 0.1 s by AR interpolation as before, longer ones in the spectrum. Native Rust in studio-dsp (sheal): STFT at a quarter-window hop on the spectrogram's resolution, each marked cell estimated from the nearest unmarked cells in time and in frequency weighted by the inverse square of the gap, so stripes across time and across frequency both fill from the short side; cells louder than twice that estimate are replaced, the rest stay; held partials continue with their measured phase advance, noise-like cells get random phase with the level corrected for incoherent overlap; only frames with a change are resynthesised and the rest of the file stays bit-exact. Short marks first look for a click (DeClicker detector) and rebuild it by AR interpolation, which beats the spectrum for clicks. Measured on real music with injected damage: thumps 12–24 dB closer to the original (not under a kick drum), whistles 16–40 dB with the noise level kept, clicks under the brush 9–36 dB, dropouts refilled at the level around them; music marked by mistake changes by about −25 dB. **Next:** step 4b (tags, BWF, cue) or step 5 processes (amplify, normalize).

### Phase 3 — Spectral, effects, metering, batch
9. Spectral display (STFT tiles in WASM, WebGL), time-frequency selection (marquee, lasso), attenuate/interpolate/pattern repair, waveform/spectrogram blend.
10. Effects rack with live preview: EQ, compressor, limiter, de-esser, reverb/delay, stretch/pitch; presets per user. Full metering: BS.1770 loudness with overlay, true peak, LRA, correlation, vectorscope, spectrum, bit meter; streaming preview; loudness/peak reports; null test.
11. Batch recipes and watch folders on the Locker, run server-side with the native build; macros from the command palette.

### Phase 4 — Multitrack, album, tie-ins
12. DJ app: open a master recording with History markers → tracklist/cue sheet; send edits to a crate; stems via Stemina.
13. Multitrack: clips with clip gain, fades/crossfades, edit modes, buses, automation, freeze/commit, mixdown; take lanes with swipe comping; punch with pre/post-roll.
14. Source–destination (3/4-point) editing.
15. Album montage: sequencing, album loudness, CD markers, ISRC/UPC, CD-Text, DDP; vinyl pre-mastering checks; release export.
16. Speech-to-text transcript; review links with timecoded comments.

## VST/AU plugins — Delicate Plugin Bridge

Native Rust helper on the user's computer (like link-bridge/stream-bridge, but native for the realtime audio thread).

- Apply: selection blocks (+ handles and tail) go to the bridge over `ws://127.0.0.1`, rendered faster than realtime, returned as an undoable edit.
- Preview: while connected, the bridge owns playback (CoreAudio to the RME UC); the studio streams blocks ahead, the bridge runs the chain and reports the playhead. No browser round trip.
- Plugin GUIs open as native windows; parameters streamed to the studio for the rack and later automation.
- State blobs saved in the project and the user's preset library; missing plugins stay in the project, bypassed.
- Plugin delay compensation from each plugin's reported latency; freeze/commit renders a chain to free CPU.
- Out-of-process scanning with a crash blacklist (AU, VST3, CLAP folders); later each plugin in its own process so one crash doesn't take the rest down.
- Security: 127.0.0.1 only, Origin must be studio.delicateaudio.com, one-time pairing code. (link-bridge needs the same.)
- Tech: AU via `rack`; VST3 GUI via the MIT-licensed VST 3 SDK if `rack` lacks it; CLAP via `clack-host`; no VST2; JUCE as fallback.
- Later: the bridge core becomes the audio core of the desktop wrapper.
- No bridge (phones/tablets): open-source Linux plugins (LV2/CLAP) on rcn for Apply only.

Steps after step 5: B1 skeleton + pairing + scan → B2 Apply with one AU → B3 rack, latency compensation, tails → B4 realtime preview through the bridge → B5 VST3 GUI, CLAP → B6 signing, auto-update, desktop wrapper.

## References

- WaveLab 12 release notes: https://sonicstate.com/news/2024/01/26/namm24-steinberg-releases-wavelab-12/
- Pro Tools 2025.6: https://www.provideocoalition.com/avid-announces-pro-tools-2025-6-a-game-changing-update/
- Pro Tools 2025.10: https://www.redsharknews.com/pro-tools-2025-10-adds-360-reality-audio-and-soundflow-automation
- iZotope RX 11: https://www.mixonline.com/technology/izotope-announces-rx-11
- Sequoia source–destination cut: https://cdn.borisfx.com/borisfx/Documentation/sequoia-2026/en/Content/Source-Destination-Schnitt.htm
- VST 3 SDK under MIT: https://sonicstate.com/news/2025/10/30/vst-3-now-available-under-mit-license
