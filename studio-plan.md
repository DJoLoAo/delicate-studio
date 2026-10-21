# Delicate Studio — plan

Browser audio editor replacing Adobe Audition. Waveform editing first, multitrack later. Same stack as Delicate DJ.

## Stack

- Repo `/opt/delicate-studio` (GitHub `DJoLoAo/delicate-studio`), axum binary on `127.0.0.1:4541`, systemd unit `delicate-studio.service`. Deploys never restart `dj-app.service`.
- nginx: `location /studio/` on dj.delicateaudio.com proxies to 4541. Same origin as the DJ app, so the DJ session cookie, COOP/COEP and SharedArrayBuffer work as-is.
- Auth: the studio forwards the cookie to `127.0.0.1:4540/api/me` (one helper, `current_user`). Login, 2FA and logout use the DJ app's endpoints. Plans free/pro/gold come from there.
- Frontend: vanilla JS like the DJ app — dialog.js, i18n with the World Picker (language shared with the DJ app via `djLang`), update banner, service worker scoped to `/studio/`.
- Audio core: Rust/WASM. Reuse `engine/` (symphonia decoding) and the decoder/worklet SharedArrayBuffer pattern. New crate `studio-dsp`, built for wasm32 (browser) and native (server batch) so both run identical code. rustfft, rubato (resampling), flacenc (FLAC export).
- Server data: `studio.db` (SQLite) for projects, presets, jobs. Locker access through the DJ app's API.

## Engine design

- Working audio in OPFS as 32-bit float blocks (~64k frames), written by a worker with sync access handles.
- A clip is an ordered list of block references. Every edit makes a new list (copy-on-write); processing writes new blocks only for the changed range. Undo/redo and history panel for free; originals untouched.
- Peak pyramid per block for instant zoom from whole file to samples.
- Playback: worker reads blocks into a SAB ring, worklet plays at the file's own sample rate.
- Project JSON autosaved in OPFS for crash recovery.
- Files from the Navidrome library open read-only; saving always creates a new file (Locker or download). Nothing is written back to `/home/navidrome/music`.

## Phases

### Phase 1 — Waveform editor MVP
1. Skeleton: binary, nginx location, auth via `/api/me`, shell with World Picker, dialogs, update banner. ← this commit
2. Open and view: drop/local/Locker/library, decode to OPFS, waveform zoom/scroll, ruler, play/stop/loop selection, peak+RMS meters, L/R channel editing.
3. Edit: select, cut/copy/paste/delete, silence, crop, insert silence, history panel, autosave.
4. Export: WAV 16/24 (TPDF dither) / 32f, FLAC, resample, tags + cover; Locker or download.
5. Processes: amplify, normalize (peak/LUFS), fade handles with curves, DC offset, reverse, invert, mono/stereo/swap; markers and ranges (M), export ranges as files, .cue sheet; Audition default shortcuts.

### Phase 2 — Vinyl and recording
6. Record from RME UC input pairs at 96 kHz/24-bit (recorder-worklet/record-writer), input meters.
7. Auto-split by silence → range markers; Discogs release via INTAKE fills names (A1, A2, B1…) and tags; export all as FLAC to the Locker.
8. Restoration: declick/decrackle/rumble (CLEAN ffmpeg chain first, native Rust later), noise print + noise reduction (STFT), hum notch 50/60 Hz + harmonics.

### Phase 3 — Spectral and effects
9. Spectral display (STFT tiles in WASM, WebGL), time-frequency selection (marquee, lasso), attenuate/heal.
10. Effects rack with live preview: EQ, compressor, limiter, de-esser, reverb/delay, stretch/pitch; presets per user; BS.1770 LUFS + true peak meter, Match Loudness.
11. Batch recipes run server-side on Locker folders (native build).

### Phase 4 — Tie-ins and multitrack
12. DJ app: open a master recording with History markers → tracklist/cue sheet; send edits to a crate; stems via Stemina.
13. Multitrack: clips, fades/crossfades, buses, automation, mixdown (own plan).

## VST/AU plugins — Delicate Plugin Bridge

Native Rust helper on the user's computer (like link-bridge/stream-bridge, but native for the realtime audio thread).

- Apply: selection blocks (+ tail) go to the bridge over `ws://127.0.0.1`, rendered faster than realtime, returned as an undoable edit.
- Preview: while connected, the bridge owns playback (CoreAudio to the RME UC); the studio streams blocks ahead, the bridge runs the chain and reports the playhead. No browser round trip.
- Plugin GUIs open as native windows; parameters streamed to the studio for the rack and later automation.
- State blobs saved in the project and the user's preset library; missing plugins stay in the project, bypassed.
- Out-of-process scanning with a crash blacklist (AU, VST3, CLAP folders).
- Security: 127.0.0.1 only, Origin must be dj.delicateaudio.com, one-time pairing code. (link-bridge needs the same.)
- Tech: AU via `rack`; VST3 GUI via the MIT-licensed VST 3 SDK if `rack` lacks it; CLAP via `clack-host`; no VST2; JUCE as fallback.
- Later: the bridge core becomes the audio core of the desktop wrapper.
- No bridge (phones/tablets): open-source Linux plugins (LV2/CLAP) on rcn for Apply only.

Steps after step 5: B1 skeleton + pairing + scan → B2 Apply with one AU → B3 rack, latency compensation, tails → B4 realtime preview through the bridge → B5 VST3 GUI, CLAP → B6 signing, auto-update, desktop wrapper.
