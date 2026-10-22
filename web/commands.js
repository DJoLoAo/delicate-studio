const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || "") || !!(navigator.userAgentData && navigator.userAgentData.platform === "macOS");
const CODE_KEYS = { Equal: "=", Minus: "-", Backslash: "\\", BracketLeft: "[", BracketRight: "]", Period: ".", Comma: ",", Slash: "/", Semicolon: ";", Quote: "'", Backquote: "`" };
const NAMED_KEYS = { " ": "Space", Spacebar: "Space", Esc: "Escape", Del: "Delete", Left: "ArrowLeft", Right: "ArrowRight", Up: "ArrowUp", Down: "ArrowDown" };
const MOD_ONLY = ["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "OS", "Fn"];

function comboOf(e) {
  const code = e.code || "";
  const altGr = !!(e.getModifierState && e.getModifierState("AltGraph"));
  const mod = !altGr && (IS_MAC ? e.metaKey : e.ctrlKey);
  const ctrl = IS_MAC && e.ctrlKey;
  const alt = !altGr && e.altKey;
  let key, shift = true;
  if (code.startsWith("Numpad")) {
    const r = code.slice(6);
    key = "Num" + ({ Decimal: ".", Enter: "Enter", Add: "+", Subtract: "-", Multiply: "*", Divide: "/", Equal: "=", Comma: "." }[r] || r);
  } else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^Key[A-Z]$/.test(code)) {
    const k = e.key && e.key.length === 1 ? e.key.toUpperCase() : "";
    key = /^[A-Z]$/.test(k) && !(IS_MAC && alt) ? k : code.slice(3);
  } else if (e.key && e.key.length === 1 && e.key !== " ") {
    key = (alt || mod) && CODE_KEYS[code] ? CODE_KEYS[code] : e.key;
    shift = false;
  } else key = NAMED_KEYS[e.key] || e.key;
  if (!key || MOD_ONLY.includes(key) || key === "Unidentified" || key === "Dead") return null;
  return [mod && "Mod", ctrl && "Ctrl", alt && "Alt", shift && e.shiftKey && "Shift", key].filter(Boolean).join("+");
}

function symbolCombo(e) {
  if (!e.key || e.key.length !== 1 || /[\s\p{L}\p{N}]/u.test(e.key)) return null;
  const altGr = !!(e.getModifierState && e.getModifierState("AltGraph"));
  const mod = !altGr && (IS_MAC ? e.metaKey : e.ctrlKey);
  return [mod && "Mod", IS_MAC && e.ctrlKey && "Ctrl", e.key].filter(Boolean).join("+");
}

const KEY_GLYPH_MAC = { Mod: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" };
const KEY_NAME = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Escape: "Esc", PageUp: "PgUp", PageDown: "PgDn" };

function keyLabel(combo) {
  const pre = combo.match(/^(?:(?:Mod|Ctrl|Alt|Shift)\+)*/)[0];
  const parts = pre ? pre.slice(0, -1).split("+") : [];
  let key = combo.slice(pre.length) || "+";
  if (key.startsWith("Num") && key.length > 3) key = "Num " + key.slice(3);
  else if (IS_MAC) key = { Enter: "↩", Backspace: "⌫", Delete: "⌦", Tab: "⇥" }[key] || KEY_NAME[key] || key;
  else key = { Delete: "Del" }[key] || KEY_NAME[key] || key;
  if (IS_MAC) return parts.map(p => KEY_GLYPH_MAC[p] || p).join("") + key;
  if (["Del", "Space", "Home", "End"].includes(key)) key = t(key);
  return parts.map(p => p === "Mod" ? t("Ctrl") : p === "Shift" ? t("Shift") : p).concat([key]).join("+");
}

const CMDS = [
  { id: "play", g: "Transport", label: "Play / stop", run: () => togglePlay(), doc: true },
  { id: "stop", g: "Transport", label: "Stop", run: () => stopPlay(), doc: true },
  { id: "loop", g: "Transport", label: "Loop on / off", run: () => toggleLoop(), doc: true },
  { id: "home", g: "Transport", label: "Cursor to start", run: () => cursorHome(), doc: true },
  { id: "end", g: "Transport", label: "Cursor to end", run: () => cursorEnd(), doc: true },
  { id: "prevMark", g: "Transport", label: "Previous marker", run: () => stepTo(-1, false), doc: true, kw: "location jump back" },
  { id: "nextMark", g: "Transport", label: "Next marker", run: () => stepTo(1, false), doc: true, kw: "location jump forward" },
  { id: "prevEdge", g: "Transport", label: "Cursor to the previous marker or selection edge", run: () => stepTo(-1, true), doc: true },
  { id: "nextTransient", g: "Transport", label: "Next transient", run: () => tnStep(1, false), doc: true, when: () => tn.on, kw: "tab onset beat hit attack drum jump forward" },
  { id: "prevTransient", g: "Transport", label: "Previous transient", run: () => tnStep(-1, false), doc: true, when: () => tn.on, kw: "tab onset beat hit attack drum jump back" },
  { id: "nextEdge", g: "Transport", label: "Cursor to the next marker or selection edge", run: () => stepTo(1, true), doc: true },
  { id: "zoomIn", g: "View", label: "Zoom in", run: () => zoomAt(0.5), doc: true },
  { id: "zoomOut", g: "View", label: "Zoom out", run: () => zoomAt(2), doc: true },
  { id: "zoomFull", g: "View", label: "Zoom to the whole file", run: () => zoomFit(), doc: true },
  { id: "zoomSel", g: "View", label: "Zoom to the selection", run: () => zoomSel(), doc: true, when: () => selOn() },
  { id: "zoomToggle", g: "View", label: "Zoom toggle (selection and back)", run: () => zoomToggle(), doc: true, when: () => selOn() || !!ed.zoomBack },
  { id: "zp1", g: "View", label: "Zoom preset 1", labelT: () => t("Zoom preset") + " 1", run: () => zpRecall(0), doc: true },
  { id: "zp2", g: "View", label: "Zoom preset 2", labelT: () => t("Zoom preset") + " 2", run: () => zpRecall(1), doc: true },
  { id: "zp3", g: "View", label: "Zoom preset 3", labelT: () => t("Zoom preset") + " 3", run: () => zpRecall(2), doc: true },
  { id: "zp4", g: "View", label: "Zoom preset 4", labelT: () => t("Zoom preset") + " 4", run: () => zpRecall(3), doc: true },
  { id: "zp5", g: "View", label: "Zoom preset 5", labelT: () => t("Zoom preset") + " 5", run: () => zpRecall(4), doc: true },
  { id: "zs1", g: "View", label: "Store zoom preset 1", labelT: () => t("Store zoom preset") + " 1", run: () => zpStore(0), doc: true },
  { id: "zs2", g: "View", label: "Store zoom preset 2", labelT: () => t("Store zoom preset") + " 2", run: () => zpStore(1), doc: true },
  { id: "zs3", g: "View", label: "Store zoom preset 3", labelT: () => t("Store zoom preset") + " 3", run: () => zpStore(2), doc: true },
  { id: "zs4", g: "View", label: "Store zoom preset 4", labelT: () => t("Store zoom preset") + " 4", run: () => zpStore(3), doc: true },
  { id: "zs5", g: "View", label: "Store zoom preset 5", labelT: () => t("Store zoom preset") + " 5", run: () => zpStore(4), doc: true },
  { id: "transients", g: "View", label: "Transient markers on / off", run: () => tnToggle(), doc: true, kw: "transients onsets beats hits attacks drums detect snap tab" },
  { id: "scale", g: "View", label: "Linear / dB amplitude", run: () => scaleToggle(), doc: true },
  { id: "colour", g: "View", label: "Spectral / plain colour", run: () => colourToggle(), doc: true },
  { id: "spec", g: "View", label: "Spectrogram on / off", run: () => spToggle(), doc: true, kw: "spectral frequency display spectrum view frequencies" },
  { id: "specScale", g: "View", label: "Spectrogram: logarithmic / linear frequency scale", run: () => spScaleToggle(), doc: true, when: () => SPV.on, kw: "spectral frequency display log linear" },
  { id: "selAll", g: "Selection", label: "Select all", run: () => selectAll(), doc: true },
  { id: "deselect", g: "Selection", label: "Clear the selection", run: () => deselect(), doc: true },
  { id: "chanL", g: "Selection", label: "Left channel only / both", run: () => chanOnly(0), doc: true, when: () => ed.doc.channels > 1 },
  { id: "chanR", g: "Selection", label: "Right channel only / both", run: () => chanOnly(1), doc: true, when: () => ed.doc.channels > 1 },
  { id: "selNextTransient", g: "Selection", label: "Extend the selection to the next transient", run: () => tnStep(1, true), doc: true, when: () => tn.on, kw: "onset beat hit attack tab" },
  { id: "selPrevTransient", g: "Selection", label: "Extend the selection to the previous transient", run: () => tnStep(-1, true), doc: true, when: () => tn.on, kw: "onset beat hit attack tab" },
  { id: "zcIn", g: "Selection", label: "Selection to zero crossings, inward", run: () => adjustZero("in"), doc: true, when: () => selOn() },
  { id: "zcOut", g: "Selection", label: "Selection to zero crossings, outward", run: () => adjustZero("out"), doc: true, when: () => selOn() },
  { id: "undo", g: "Edit", label: "Undo", run: () => undo(), doc: true, when: () => ed.histIdx > 0 },
  { id: "redo", g: "Edit", label: "Redo", run: () => redo(), doc: true, when: () => ed.histIdx < ed.hist.length - 1 },
  { id: "cut", g: "Edit", label: "Cut", run: () => edit("cut"), doc: true, when: () => selOn() },
  { id: "copy", g: "Edit", label: "Copy", run: () => edit("copy"), doc: true, when: () => selOn() },
  { id: "paste", g: "Edit", label: "Paste", run: () => edit("paste"), doc: true, when: () => !!ed.clipInfo },
  { id: "delete", g: "Edit", label: "Delete the selection", run: () => spSelLive() ? spEdit("spdel", SPV.sel.shapes, "sel") : edit("delete"), doc: true, when: () => selOn() },
  { id: "silence", g: "Edit", label: "Silence the selection", run: () => spSelLive() ? spEdit("spdel", SPV.sel.shapes, "sel") : edit("silence"), doc: true, when: () => selOn() },
  { id: "crop", g: "Edit", label: "Crop to the selection", run: () => edit("crop"), doc: true, when: () => selOn() },
  { id: "insert", g: "Edit", label: "Insert silence…", run: () => insertSilenceDlg(), doc: true },
  { id: "hist", g: "Edit", label: "History", run: () => toggleHist(), doc: true, kw: "undo list steps" },
  { id: "loud", g: "Edit", label: "Loudness panel", run: () => toggleLoud(), doc: true, kw: "lufs loudness level loud louder volume gain master" },
  { id: "midi", g: "Edit", label: "Convert to MIDI…", run: () => toggleMidi(), doc: true, kw: "midi melody notes transcribe pitch audio to midi convert piano roll tune" },
  { id: "tracks", g: "Locations", label: "Split into tracks…", run: () => toggleTracks(), doc: true, kw: "split tracks side vinyl gaps auto split auto mark discogs tracklist cue ranges rip" },
  { id: "ldLoud", g: "Edit", label: "Match loudness…", run: () => ldOpen("loud"), doc: true, kw: "lufs loudness target limiter louder master streaming ebu r128" },
  { id: "ldNorm", g: "Edit", label: "Normalize…", run: () => ldOpen("norm"), doc: true, kw: "normalise peak level maximize" },
  { id: "ldAmp", g: "Edit", label: "Amplify…", run: () => ldOpen("amp"), doc: true, kw: "gain volume louder quieter level" },
  { id: "fadeIn", g: "Process", label: "Fade in…", run: () => pxFadeDlg("in"), doc: true, when: () => selOn(), kw: "fade in ramp curve envelope volume rise" },
  { id: "fadeOut", g: "Process", label: "Fade out…", run: () => pxFadeDlg("out"), doc: true, when: () => selOn(), kw: "fade out ramp curve envelope volume fall" },
  { id: "dcOff", g: "Process", label: "Remove DC offset", run: () => pxRun("dc"), doc: true, kw: "dc offset bias centre center zero line" },
  { id: "reverse", g: "Process", label: "Reverse", run: () => pxRun("reverse"), doc: true, kw: "backwards backward reversed play back" },
  { id: "invert", g: "Process", label: "Invert", run: () => pxRun("invert"), doc: true, kw: "polarity phase flip upside down inverse" },
  { id: "swap", g: "Process", label: "Swap channels", run: () => pxRun("swap"), doc: true, when: () => ed.doc.channels === 2, kw: "swap left right channels stereo flip exchange" },
  { id: "lToR", g: "Process", label: "Copy left channel to right", run: () => pxRun("lr"), doc: true, when: () => ed.doc.channels === 2, kw: "both left mono duplicate channel dual" },
  { id: "rToL", g: "Process", label: "Copy right channel to left", run: () => pxRun("rl"), doc: true, when: () => ed.doc.channels === 2, kw: "both right mono duplicate channel dual" },
  { id: "mono", g: "Process", label: "Mix to mono", run: () => pxRun("mono"), doc: true, when: () => ed.doc.channels === 2, kw: "mono sum downmix average both channels fold down" },
  { id: "msEnc", g: "Process", label: "Mid/Side encode (L/R to M/S)", run: () => pxRun("msenc"), doc: true, when: () => ed.doc.channels === 2, kw: "mid side ms stereo width sum difference" },
  { id: "msDec", g: "Process", label: "Mid/Side decode (M/S to L/R)", run: () => pxRun("msdec"), doc: true, when: () => ed.doc.channels === 2, kw: "mid side ms stereo width sum difference" },
  { id: "repair", g: "Repair", label: "Repair panel", run: () => toggleRepair(), doc: true, kw: "restore restoration diagnostics noise hum clicks clipping vinyl" },
  { id: "diag", g: "Repair", label: "Diagnostics: DeClicker…", run: () => toggleDiag("click"), doc: true, kw: "declick decrackle click pop crackle vinyl scan repair restore" },
  { id: "declip", g: "Repair", label: "Diagnostics: DeClipper…", run: () => toggleDiag("clip"), doc: true, kw: "declip clipping clipped distortion overload peaks restore repair" },
  { id: "hum", g: "Repair", label: "DeHummer…", run: () => toggleHum(), doc: true, kw: "dehum hum buzz mains 50 60 hz ground loop notch" },
  { id: "nr", g: "Repair", label: "Noise Reduction…", run: () => toggleNr(), doc: true, kw: "denoise noise reduction hiss surface noise vinyl print process" },
  { id: "nrCap", g: "Repair", label: "Capture noise print", run: () => nrCapture(), doc: true, when: () => selOn(), kw: "noise print profile learn denoise" },
  { id: "pencil", g: "Repair", label: "Pencil: redraw samples", run: () => penToggle(), doc: true, kw: "pencil pen draw redraw samples click waveform hand repair" },
  { id: "heal", g: "Repair", label: "Heal the selection", run: () => spSelLive() ? spEdit("spheal", SPV.sel.shapes, "sel") : edit("heal"), doc: true, when: () => selOn(), kw: "automatic heal repair click pop fix interpolate spectral" },
  { id: "toolTime", g: "Repair", label: "Time selection tool", run: () => spSetTool("time"), doc: true, when: () => SPV.on, kw: "spectrogram select time" },
  { id: "toolRect", g: "Repair", label: "Marquee selection tool", run: () => spSetTool("rect", true), doc: true, kw: "spectrogram spectral rectangle frequency select" },
  { id: "toolLasso", g: "Repair", label: "Lasso selection tool", run: () => spSetTool("lasso", true), doc: true, kw: "spectrogram spectral freehand frequency select" },
  { id: "toolBrush", g: "Repair", label: "Spot Healing Brush", run: () => spSetTool("brush", true), doc: true, kw: "spectrogram spectral paint heal repair click thump whistle cough" },
  { id: "markAdd", g: "Locations", label: "Add marker (or a range from the selection)", run: () => recBusy() ? recMark() : addMarker(false), when: () => !!ed.doc || recBusy(), kw: "cue memory location" },
  { id: "rangeAdd", g: "Locations", label: "Add a range from the selection", run: () => addMarker(true), doc: true, when: () => selOn(), kw: "region memory location" },
  { id: "locAdd", g: "Locations", label: "New memory location…", run: () => addLocationDlg(), doc: true, kw: "marker zoom view named" },
  { id: "locs", g: "Locations", label: "Locations", run: () => toggleLocs(), doc: true, kw: "markers memory locations list" },
  { id: "cueImport", g: "Locations", label: "Import cue sheet…", run: () => ftCuePick(), doc: true, kw: "cue cuesheet tracklist tracks import ranges eac foobar" },
  { id: "open", g: "File", label: "Open a file…", run: () => pickFiles() },
  { id: "recPanel", g: "File", label: "Record…", run: () => recToggle(), kw: "record recording input microphone vinyl rip turntable guitar capture" },
  { id: "rec", g: "Transport", label: "Record / stop recording", run: () => recGo(), kw: "record recording start stop capture" },
  { id: "export", g: "File", label: "Export…", run: () => openExport(), doc: true, kw: "render bounce save wav flac master dither" },
  { id: "newMono", g: "File", label: "New mono file from this one…", run: () => pxMonoDlg(), doc: true, when: () => ed.doc.channels > 1, kw: "convert mono downmix channels new file save as" },
  { id: "newStereo", g: "File", label: "New stereo file from this one", run: () => pxNewFile("stereo"), doc: true, when: () => ed.doc.channels === 1, kw: "convert stereo channels new file dual mono save as" },
  { id: "albums", g: "File", label: "Albums", run: () => openFiles("albums"), kw: "album record sides lp vinyl discogs release export all tracks" },
  { id: "albumNew", g: "File", label: "New album from this file…", run: () => alNew(), doc: true, when: () => !alOf(ed.doc.id), kw: "album record sides lp vinyl join both sides" },
  { id: "albumOpen", g: "File", label: "Album of this file…", run: () => alOpenFor(ed.doc.id), doc: true, when: () => !!alOf(ed.doc.id), kw: "album record sides lp vinyl" },
  { id: "tags", g: "File", label: "File tags…", run: () => ftOpen(false), doc: true, kw: "metadata meta id3 vorbis info bwf title artist album cover art tag edit discogs" },
  { id: "files", g: "File", label: "Files", run: () => openFiles(), kw: "library locker studio" },
  { id: "close", g: "File", label: "Close file", run: () => closeDoc(), doc: true },
  { id: "settings", g: "File", label: "Settings", run: () => openSettings() },
  { id: "palette", g: "Help", label: "Command palette", run: () => palOpen() },
  { id: "keys", g: "Help", label: "Keyboard shortcuts", run: () => shortcuts() },
  { id: "tour", g: "Help", label: "Show the tour", run: () => tourAll(), kw: "tour onboarding welcome introduction guide help" }
];
for (let i = 1; i <= 10; i++) CMDS.push({ id: "loc" + i, g: "Locations", label: "Go to location " + i, labelT: () => t("Go to location") + " " + i, run: () => recallNumber(i), doc: true, hidden: true });
const CMD = Object.fromEntries(CMDS.map(c => [c.id, c]));
const GROUPS = ["Transport", "View", "Selection", "Edit", "Process", "Repair", "Locations", "File", "Help"];

const BASE_KEYS = {
  play: ["Space"], loop: ["L"], home: ["Home"], end: ["End"], prevMark: ["["], nextMark: ["]"],
  zoomIn: ["=", "+", "Num+"], zoomOut: ["-", "Num-"], zoomFull: ["\\"], zoomSel: ["Z"],
  zp1: ["1"], zp2: ["2"], zp3: ["3"], zp4: ["4"], zp5: ["5"],
  selAll: ["Mod+A"], deselect: ["Escape"],
  undo: ["Mod+Z"], redo: ["Mod+Shift+Z", "Mod+Y"], cut: ["Mod+X"], copy: ["Mod+C"], paste: ["Mod+V"],
  delete: ["Delete", "Backspace"], silence: ["Shift+Delete", "Shift+Backspace"], crop: ["T"], hist: ["H"], heal: ["Mod+U"], nrCap: ["Shift+P"],
  markAdd: ["M"], locAdd: ["Shift+M"], locs: ["J"], spec: ["Shift+D"], toolRect: ["E"], toolLasso: ["D"], toolBrush: ["B"], pencil: ["P"], transients: ["Shift+T"], nextTransient: ["Tab"], prevTransient: ["Shift+Tab"],
  open: ["Mod+O"], export: ["Mod+Shift+E"], palette: ["Mod+K", "Mod+Shift+P"], keys: ["?"], rec: ["Shift+Space"]
};

const KEYMAPS = {
  audition: {
    label: "Adobe Audition",
    keys: {
      play: ["Space"], home: ["Home"], end: ["End"], loop: ["Mod+L"],
      prevEdge: ["Mod+ArrowLeft"], nextEdge: ["Mod+ArrowRight"],
      prevMark: [{ mac: { k: "[", native: "Mod+Alt+ArrowLeft" }, win: "Mod+Alt+ArrowLeft" }], nextMark: [{ mac: { k: "]", native: "Mod+Alt+ArrowRight" }, win: "Mod+Alt+ArrowRight" }],
      zoomIn: ["="], zoomOut: ["-"], zoomFull: ["Mod+\\"], zoomSel: ["Shift+S"],
      undo: ["Mod+Z"], redo: ["Mod+Shift+Z"], cut: ["Mod+X"], copy: ["Mod+C"], paste: ["Mod+V"],
      delete: ["Delete", "Backspace"], crop: [{ k: "T", native: "Mod+T" }], selAll: ["Mod+A"], deselect: ["Mod+Shift+A"],
      markAdd: ["M", "*", "Num*"], locs: ["Alt+8"], chanL: ["ArrowUp"], chanR: ["ArrowDown"],
      zcIn: ["Shift+I"], zcOut: ["Shift+O"], open: ["Mod+O"], heal: ["Mod+U"], nr: ["Mod+Shift+P"], nrCap: ["Shift+P"]
    }
  },
  protools: {
    label: "Pro Tools",
    keys: {
      play: ["Space", "Num0"], home: ["Enter", "Home"], end: [{ mac: "Alt+Enter", win: "Mod+Enter" }, "End"], loop: ["Mod+Shift+L"],
      zoomIn: ["Mod+]", "T"], zoomOut: ["Mod+[", "R"], zoomSel: ["Alt+F"], zoomToggle: [{ mac: "Ctrl+E" }, "E"],
      zp1: [{ mac: "Ctrl+1", win: { k: "1", native: "Win+1" } }, "1"], zp2: [{ mac: "Ctrl+2", win: { k: "2", native: "Win+2" } }, "2"], zp3: [{ mac: "Ctrl+3", win: { k: "3", native: "Win+3" } }, "3"], zp4: [{ mac: "Ctrl+4", win: { k: "4", native: "Win+4" } }, "4"], zp5: [{ mac: "Ctrl+5", win: { k: "5", native: "Win+5" } }, "5"],
      undo: ["Mod+Z", "Z"], redo: ["Mod+Shift+Z", "Shift+Z"], cut: ["Mod+X", "X"], copy: ["Mod+C", "C"], paste: ["Mod+V", "V"],
      delete: ["Delete", "Backspace"], silence: ["Mod+B"], crop: [{ k: "Shift+T", native: "Mod+T" }], insert: ["Mod+Shift+E"], selAll: ["Mod+A"],
      locAdd: ["NumEnter"], markAdd: [{ mac: "Mod+Enter" }], locs: ["Mod+Num5"], open: ["Mod+O"], export: ["Mod+Alt+B"], pencil: ["F10"], nextTransient: ["Tab"], prevTransient: [{ mac: "Alt+Tab" }], selNextTransient: ["Shift+Tab"], selPrevTransient: [{ mac: "Alt+Shift+Tab" }], rec: ["F12", "Num3", { k: "Shift+Space", native: "Mod+Space" }]
    }
  },
  reaper: {
    label: "REAPER",
    keys: {
      play: ["Space"], home: ["Home", "W"], end: ["End"], loop: ["R"],
      zoomIn: ["=", "+", "Num+"], zoomOut: ["-", "Num-"], zoomSel: [{ mac: "Mod+PageUp", win: { k: "Z", native: "Ctrl+PageUp" } }], zoomFull: [{ mac: "Mod+PageDown", win: { k: "\\", native: "Ctrl+PageDown" } }],
      undo: ["Mod+Z"], redo: ["Mod+Shift+Z"], cut: ["Mod+X"], copy: ["Mod+C"], paste: ["Mod+V"], delete: ["Delete"], selAll: ["Mod+A"], deselect: ["Escape"],
      markAdd: ["M"], locAdd: ["Shift+M"], rangeAdd: ["Shift+R"], prevMark: ["["], nextMark: ["]"], locs: ["Mod+J"], palette: ["?"], export: ["Mod+Alt+R"],
      rec: [{ k: "Shift+Space", native: "Mod+R" }],
      loc1: ["1", "Num1"], loc2: ["2", "Num2"], loc3: ["3", "Num3"], loc4: ["4", "Num4"], loc5: ["5", "Num5"], loc6: ["6", "Num6"], loc7: ["7", "Num7"], loc8: ["8", "Num8"], loc9: ["9", "Num9"], loc10: ["0", "Num0"]
    }
  }
};

const kb = { preset: "audition", user: {}, map: null, seq: null, capture: null };

function kbLoad() {
  try { const p = localStorage.getItem("studioKeymap"); if (p && KEYMAPS[p]) kb.preset = p; } catch {}
  try { const u = JSON.parse(localStorage.getItem("studioKeys") || "{}"); if (u && typeof u === "object") kb.user = u; } catch {}
  kb.map = null;
}

function kbSave() {
  try { localStorage.setItem("studioKeymap", kb.preset); localStorage.setItem("studioKeys", JSON.stringify(kb.user)); } catch {}
  kb.map = null;
  applyTitles();
}

function resolveKey(item) {
  if (typeof item === "string") return { k: item };
  if (item.mac !== undefined || item.win !== undefined) { const v = IS_MAC ? item.mac : item.win; return v === undefined ? null : resolveKey(v); }
  return item.k ? { k: item.k, native: item.native || null } : null;
}

function keymap() {
  if (kb.map) return kb.map;
  const P = KEYMAPS[kb.preset].keys, U = kb.user[kb.preset] || {};
  const byKey = new Map(), byCmd = {};
  const add = (cmd, item) => {
    const it = resolveKey(item);
    if (!it || !CMD[cmd] || byKey.has(it.k)) return;
    byKey.set(it.k, cmd);
    (byCmd[cmd] = byCmd[cmd] || []).push(it);
  };
  for (const cmd in U) for (const k of U[cmd]) add(cmd, k);
  for (const cmd in P) if (!(cmd in U)) for (const k of P[cmd]) add(cmd, k);
  for (const cmd in BASE_KEYS) if (!(cmd in U)) for (const k of BASE_KEYS[cmd]) add(cmd, k);
  kb.map = { byKey, byCmd };
  return kb.map;
}

function cmdKeys(id) { return (keymap().byCmd[id] || []); }
function cmdKeyText(id) { const k = cmdKeys(id)[0]; return k ? keyLabel(k.k) : ""; }
function cmdLabel(c) { return c.labelT ? c.labelT() : t(c.label); }
function cmdEnabled(c) { if (c.doc && !ed.doc) return false; try { return !c.when || !!c.when(); } catch { return false; } }

function runCmd(c) {
  if (!c || !cmdEnabled(c)) return false;
  c.run();
  return true;
}

function runCmdById(id) { return runCmd(CMD[id]); }

const TIP_IDS = { homeBtn: "home", playBtn: "play", stopBtn: "stop", loopBtn: "loop", zinBtn: "zoomIn", zoutBtn: "zoomOut", zselBtn: "zoomSel", zfitBtn: "zoomFull", keysBtn: "keys", palBtn: "palette", specBtn: "spec", spToolTime: "toolTime", spToolRect: "toolRect", spToolLasso: "toolLasso", spToolBrush: "toolBrush" };

function applyTitles() {
  const set = (el, id) => {
    const c = CMD[id];
    if (!el || !c) return;
    const k = cmdKeyText(id), label = id === "paste" ? t("Paste — replaces the selection") : cmdLabel(c);
    el.title = k ? label + " (" + k + ")" : label;
    el.setAttribute("aria-label", cmdLabel(c));
  };
  document.querySelectorAll("#edTools [data-cmd]").forEach(el => { if (el.id !== "histX") set(el, el.dataset.cmd); });
  for (const id in TIP_IDS) set($(id), TIP_IDS[id]);
  document.querySelectorAll("#zpSeg button").forEach((b, i) => {
    const k = cmdKeyText("zp" + (i + 1)), desc = zpDesc(zpGet()[i]);
    b.title = t("Zoom preset") + " " + (i + 1) + " · " + desc + (k ? " (" + k + ")" : "") + "\n" + t("Shift-click or Ctrl/⌘-click stores the current zoom");
  });
}

const ZP_DEFAULT = [{ fit: 1 }, { spx: 0.05 }, { spx: 0.005 }, { spx: 0.0005 }, { spp: 0.125 }];

function zpGet() {
  try { const v = JSON.parse(localStorage.getItem("studioZoomPresets") || "null"); if (Array.isArray(v) && v.length === 5 && v.every(x => x && (x.fit || x.spx > 0 || x.spp > 0))) return v; } catch {}
  return ZP_DEFAULT.map(x => Object.assign({}, x));
}

function zpSpp(p) {
  if (!ed.doc) return 0;
  if (p.fit) return ed.doc.frames / viewWidth();
  return p.spp || p.spx * ed.doc.sampleRate;
}

function zpDesc(p) {
  if (p.fit) return t("whole file");
  if (p.spp && p.spp < 1) return t("samples");
  const spx = p.spx || (ed.doc ? p.spp / ed.doc.sampleRate : 0);
  const sec = spx * 1000;
  return sec >= 1000 ? (sec / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 }) + " s / 1000 px" : Math.round(sec) + " ms / 1000 px";
}

function zpRecall(i) {
  const p = zpGet()[i];
  if (p.fit) { zoomFit(); return; }
  zoomAt(zpSpp(p) / ed.view.spp);
}

function zpStore(i) {
  const arr = zpGet();
  arr[i] = { spx: ed.view.spp / ed.doc.sampleRate };
  try { localStorage.setItem("studioZoomPresets", JSON.stringify(arr)); } catch {}
  applyTitles();
  zpMark();
  flash(t("Zoom preset") + " " + (i + 1) + " " + t("stored"));
}

function zpMark() {
  if (!ed.doc) return;
  const arr = zpGet();
  document.querySelectorAll("#zpSeg button").forEach((b, i) => { const s = zpSpp(arr[i]); b.classList.toggle("on", s > 0 && Math.abs(ed.view.spp / s - 1) < 0.01); });
}

function seqKey(combo) {
  const s = kb.seq;
  const digit = /^(Num)?\d$/.test(combo) ? combo.slice(-1) : null;
  s.t = performance.now();
  if (digit !== null && s.n.length < 3) { s.n += digit; flash(t("Location") + " " + s.n + "_"); return; }
  if (combo === "Backspace") { s.n = s.n.slice(0, -1); flash(t("Location") + " " + s.n + "_"); return; }
  const done = combo === "." || combo === "Num." || combo === "Enter" || combo === "NumEnter";
  kb.seq = null;
  if (done && s.n) recallNumber(Number(s.n));
  else flash("");
}

function wireCommands() {
  kbLoad();
  wireCtx();
  document.addEventListener("keydown", onKey);
  const seg = $("zpSeg");
  seg.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b || !ed.doc) return;
    b.blur();
    const i = Number(b.dataset.zp);
    if (e.shiftKey || e.metaKey || e.ctrlKey) zpStore(i); else zpRecall(i);
  });
  $("palBtn").addEventListener("click", ev => { ev.stopPropagation(); palOpen(); });
  palBuild();
  ddInit($("keymapDd"), kbPresets(), kb.preset, v => kbPreset(v));
  $("keysShow").addEventListener("click", () => { closeSettings(); shortcuts(); });
  $("keysReset").addEventListener("click", async () => {
    if (!(await ask(t("Reset keys?"), t("This removes the keys you changed for") + " " + KEYMAPS[kb.preset].label + ".", { ok: t("reset") }))) return;
    delete kb.user[kb.preset];
    kbSave();
    keysInfo();
  });
  keysInfo();
  document.addEventListener("i18n", () => { applyTitles(); keysInfo(); if (ed.doc) editButtons(); });
  applyTitles();
}

function keysInfo() {
  const n = Object.keys(kb.user[kb.preset] || {}).length;
  $("keysNote").textContent = n ? n + " " + t(n === 1 ? "key changed" : "keys changed") : t("Change any key in the command palette by clicking its shortcut.");
  $("keysReset").disabled = !n;
}

function closePopovers() {
  if (!$("files").classList.contains("hidden")) { closeFiles(); return true; }
  if (!$("hist").classList.contains("hidden")) { closeHist(); return true; }
  if (!$("locs").classList.contains("hidden")) { closeLocs(); return true; }
  if (rc.open && !recBusy()) { recClose(); return true; }
  return false;
}

function onKey(e) {
  if (kb.capture) { captureKey(e); return; }
  if (!$("ctx").classList.contains("hidden")) { if (e.key === "Escape") { e.preventDefault(); ctxClose(); } return; }
  if (!$("pal").classList.contains("hidden")) {
    if (e.key === "Escape") { e.preventDefault(); palClose(); }
    else if (e.target !== $("palQ") && !MOD_ONLY.includes(e.key)) $("palQ").focus();
    return;
  }
  const modal = ($("dlg") && !$("dlg").classList.contains("hidden")) || !$("settings").classList.contains("hidden") || !$("exp").classList.contains("hidden");
  if (typing(e) || modal) return;
  if (!$("app") || $("app").classList.contains("hidden")) return;
  const combo = comboOf(e);
  if (!combo) return;
  if (kb.seq && performance.now() - kb.seq.t > 4000) { kb.seq = null; flash(""); }
  if (kb.seq) { e.preventDefault(); seqKey(combo); return; }
  if (combo === "Escape" && pen.stroke) { e.preventDefault(); penCancel(); return; }
  if (combo === "Escape" && closePopovers()) { e.preventDefault(); return; }
  const map = keymap(), sym = symbolCombo(e);
  const id = map.byKey.get(combo) || (sym && sym !== combo ? map.byKey.get(sym) : undefined);
  if (!id) {
    if ((combo === "." || combo === "Num.") && ed.doc) { e.preventDefault(); kb.seq = { n: "", t: performance.now() }; flash(t("Location") + " _"); }
    return;
  }
  const c = CMD[id];
  if (c.doc && !ed.doc) return;
  if (/(^|\+)Tab$/.test(combo)) {
    const a = document.activeElement;
    if ((a && a !== document.body && a.tagName !== "CANVAS") || !cmdEnabled(c)) return;
  }
  e.preventDefault();
  runCmd(c);
}

function kbPresets() { return Object.keys(KEYMAPS).map(k => ({ v: k, label: KEYMAPS[k].label })); }

function kbPreset(v) {
  if (!KEYMAPS[v]) return;
  kb.preset = v;
  kbSave();
  keysInfo();
  for (const id of ["keymapDd", "kbDlgDd"]) {
    const el = $(id);
    if (el) { el.querySelector(".cur").textContent = KEYMAPS[v].label; el.dataset.v = v; }
  }
  const l = $("kbList");
  if (l) l.innerHTML = keyRows();
}

function keyRows() {
  const map = keymap();
  const rows = [];
  for (const g of GROUPS) {
    const items = CMDS.filter(c => c.g === g && map.byCmd[c.id] && (!c.hidden || map.byCmd[c.id]));
    if (!items.length) continue;
    rows.push(`<div class="kgroup">${esc(t(g))}</div>`);
    for (const c of items) {
      const ks = map.byCmd[c.id];
      const notes = ks.filter(k => k.native).map(k => keyLabel(k.native) + " " + t("is taken by the browser"));
      rows.push(`<div><kbd>${ks.map(k => esc(keyLabel(k.k))).join(" · ")}</kbd><span>${esc(cmdLabel(c))}${notes.length ? `<em>${esc(notes.join(" · "))}</em>` : ""}</span></div>`);
    }
  }
  if (!map.byKey.has(".") && !map.byKey.has("Num.")) rows.push(`<div class="kgroup">${esc(t("Locations"))}</div><div><kbd>. 1 .</kbd><span>${esc(t("Go to a location by number (period, number, period)"))}</span></div>`);
  rows.push(`<div class="kgroup">${esc(t("Mouse"))}</div><div><kbd>Shift + ${esc(t("click"))}</kbd><span>${esc(t("Extend the selection"))}</span></div><div><kbd>${esc(t("Wheel"))}</kbd><span>${esc(t("Zoom · Shift+wheel scrolls"))}</span></div>`);
  return rows.join("");
}

function shortcuts() {
  const pick = `<div class="krow"><span>${esc(t("Keys like"))}</span><div class="dd down" id="kbDlgDd" title="${esc(t("Shortcut preset"))}"><div class="cur"></div><div class="list"></div></div></div>`;
  askForm(t("Keyboard shortcuts"), `${pick}<div class="keys" id="kbList">${keyRows()}</div><div class="dnote">${esc(t("The same choice is in Settings → Keyboard. Change any key in the command palette."))}</div>`, { ok: t("close") });
  const c = document.querySelector("#dlg .dcancel");
  if (c) c.style.display = "none";
  ddInit($("kbDlgDd"), kbPresets(), kb.preset, v => kbPreset(v));
}

const pal = { items: [], shown: [], idx: 0, recent: [] };

function palBuild() {
  try { pal.recent = JSON.parse(localStorage.getItem("studioRecentCmds") || "[]"); } catch { pal.recent = []; }
  const q = $("palQ");
  q.addEventListener("input", () => { pal.idx = 0; palRender(); });
  q.addEventListener("keydown", e => {
    if (kb.capture) { captureKey(e); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); pal.idx = Math.min(pal.shown.length - 1, pal.idx + 1); palRender(true); }
    else if (e.key === "ArrowUp") { e.preventDefault(); pal.idx = Math.max(0, pal.idx - 1); palRender(true); }
    else if (e.key === "Enter") { e.preventDefault(); palRun(pal.shown[pal.idx]); }
    else if (e.key === "Escape") { e.preventDefault(); palClose(); }
    e.stopPropagation();
  });
  $("pal").addEventListener("pointerdown", e => { if (e.target === $("pal")) palClose(); });
}

function palOpen() {
  closePopovers();
  $("pal").classList.remove("hidden");
  $("palQ").value = "";
  pal.idx = 0;
  palRender();
  setTimeout(() => $("palQ").focus(), 0);
}

function palClose() {
  kb.capture = null;
  $("palQ").blur();
  $("pal").classList.add("hidden");
}

function fuzzy(q, text) {
  if (!q) return 1;
  const s = text.toLowerCase();
  let score = 0;
  for (const tok of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    const i = s.indexOf(tok);
    if (i >= 0) { score += (i === 0 || /[\s·(,/-]/.test(s[i - 1]) ? 30 : 12) + tok.length; continue; }
    let j = 0, k = 0, gap = 0;
    for (; k < s.length && j < tok.length; k++) { if (s[k] === tok[j]) j++; else if (j) gap++; }
    if (j < tok.length) return 0;
    score += Math.max(1, 8 - gap);
  }
  return score;
}

function palEntries(q) {
  const out = [];
  if (ed.doc && q.trim()) {
    const f = parseTime(q.trim(), ed.fmt) ?? parseTime(q.trim(), "time");
    if (f !== null && f >= 0 && /^[\d:.,\s]+$/.test(q.trim())) out.push({ kind: "time", label: t("Go to") + " " + fmtTime(Math.min(f, ed.doc.frames)), score: 1000, run: () => jumpTo(Math.min(f, ed.doc.frames)) });
  }
  for (const c of CMDS) {
    if (c.hidden) continue;
    const label = cmdLabel(c), hay = [label, t(c.g), c.label, c.kw || ""].join(" · ");
    const sc = fuzzy(q, hay);
    if (!sc) continue;
    const r = pal.recent.indexOf(c.id);
    out.push({ kind: "cmd", c, label, group: t(c.g), score: sc + (r >= 0 ? (q ? 6 : 200) - r : 0), enabled: cmdEnabled(c) });
  }
  if (ed.doc) for (const m of ed.marks || []) {
    const label = t("Location") + " " + m.n + (m.name ? " · " + m.name : "");
    const sc = fuzzy(q, label + " " + markTime(m) + " marker");
    if (sc) out.push({ kind: "loc", label, group: markTime(m), score: sc + (q ? 2 : -50), run: () => recallMark(m) });
  }
  if (q.trim()) for (const d of ed.docs || []) {
    const label = t("Open") + " · " + d.name;
    const sc = fuzzy(q, label + " file");
    if (sc && (!ed.doc || d.id !== ed.doc.id)) out.push({ kind: "doc", label, group: t("Files"), score: sc - 5, run: () => openDoc(d.id) });
  }
  out.sort((a, b) => b.score - a.score || (a.c && b.c ? GROUPS.indexOf(a.c.g) - GROUPS.indexOf(b.c.g) : 0));
  return out.slice(0, 60);
}

function palRender(keepScroll) {
  const q = $("palQ").value;
  pal.shown = palEntries(q);
  if (pal.idx >= pal.shown.length) pal.idx = Math.max(0, pal.shown.length - 1);
  const box = $("palList");
  box.innerHTML = "";
  pal.shown.forEach((it, i) => {
    const row = document.createElement("div");
    row.className = "prow" + (i === pal.idx ? " on" : "") + (it.kind === "cmd" && !it.enabled ? " off" : "");
    row.innerHTML = `<span class="pl"></span><span class="pg"></span><button class="pk" type="button"></button>`;
    row.querySelector(".pl").textContent = it.label;
    row.querySelector(".pg").textContent = it.group || "";
    const kbtn = row.querySelector(".pk");
    if (it.kind === "cmd") {
      const ks = cmdKeys(it.c.id);
      kbtn.textContent = kb.capture === it.c.id ? t("Press a key…") : ks.length ? ks.slice(0, 2).map(k => keyLabel(k.k)).join("  ") : t("set key");
      kbtn.classList.toggle("none", !ks.length && kb.capture !== it.c.id);
      kbtn.classList.toggle("cap", kb.capture === it.c.id);
      kbtn.title = t("Click, then press the new key. Esc cancels, Backspace removes the key.");
      kbtn.addEventListener("click", ev => { ev.stopPropagation(); kb.capture = it.c.id; palRender(true); });
    } else kbtn.remove();
    row.addEventListener("pointerdown", ev => { if (ev.target.closest(".pk")) return; ev.preventDefault(); pal.idx = i; palRun(it); });
    box.appendChild(row);
  });
  if (!pal.shown.length) { const p = document.createElement("div"); p.className = "fempty"; p.textContent = t("No matches."); box.appendChild(p); }
  const cur = box.querySelector(".prow.on");
  if (cur) cur.scrollIntoView({ block: "nearest" });
  if (!keepScroll && !q) box.scrollTop = 0;
}

function palRun(it) {
  if (!it) return;
  if (it.kind === "cmd") {
    if (!it.enabled) return;
    pal.recent = [it.c.id].concat(pal.recent.filter(x => x !== it.c.id)).slice(0, 8);
    try { localStorage.setItem("studioRecentCmds", JSON.stringify(pal.recent)); } catch {}
    palClose();
    runCmd(it.c);
    return;
  }
  palClose();
  it.run();
}

function captureKey(e) {
  if (MOD_ONLY.includes(e.key)) return;
  e.preventDefault();
  e.stopPropagation();
  const id = kb.capture;
  kb.capture = null;
  const combo = comboOf(e);
  if (combo === "Escape" || !combo) { palRender(true); $("palQ").focus(); return; }
  const U = kb.user[kb.preset] = kb.user[kb.preset] || {};
  if (combo === "Backspace" || combo === "Delete") U[id] = [];
  else {
    const prev = keymap().byKey.get(combo);
    if (prev && prev !== id) {
      U[prev] = cmdKeys(prev).filter(k => k.k !== combo).map(k => k.k);
      flash(keyLabel(combo) + ": " + cmdLabel(CMD[prev]) + " → " + cmdLabel(CMD[id]));
    }
    U[id] = [combo];
  }
  kbSave();
  keysInfo();
  palRender(true);
  $("palQ").focus();
}

function ctxClose() {
  const el = $("ctx");
  if (!el || el.classList.contains("hidden")) return;
  if (el.contains(document.activeElement)) document.activeElement.blur();
  el.classList.add("hidden");
}

const ctxState = { fresh: true, pid: null, at: null, back: null };

function ctxOpen(x, y, items, touch, pid, back, first) {
  closePopovers();
  const el = $("ctx");
  ctxState.fresh = !touch;
  ctxState.pid = touch && pid !== undefined ? pid : null;
  ctxState.at = { x, y, touch, items };
  ctxState.back = back || null;
  el.innerHTML = "";
  let lastSep = true;
  for (const it of items) {
    if (it === "-") { if (!lastSep) { const d = document.createElement("div"); d.className = "csep"; el.appendChild(d); lastSep = true; } continue; }
    const b = document.createElement("button");
    b.type = "button";
    b.className = "citem";
    b.disabled = !it.enabled;
    b.innerHTML = `<span class="cl"></span><span class="ck"></span>`;
    b.querySelector(".cl").textContent = it.label;
    b.querySelector(".ck").textContent = it.sub ? "›" : it.key || "";
    if (it.id) b.dataset.cmd = it.id;
    if (it.sub) { b.classList.add("csub"); b.dataset.sub = it.subId || ""; }
    b._it = it;
    b.addEventListener("click", ev => {
      ev.stopPropagation();
      const fromOpener = ev.pointerId !== undefined && ev.pointerId >= 0 ? ev.pointerId === ctxState.pid : !ctxState.fresh && ev.detail !== 0;
      if (fromOpener) return;
      if (it.sub) { ctxSub(it, false); return; }
      if (it.stay) { it.run(); return; }
      ctxClose();
      it.run();
    });
    el.appendChild(b);
    lastSep = false;
  }
  if (el.lastChild && el.lastChild.className === "csep") el.lastChild.remove();
  el.style.left = "0px";
  el.style.top = "0px";
  el.classList.remove("hidden");
  const r = el.getBoundingClientRect(), W = window.innerWidth, H = window.innerHeight, gap = touch ? 14 : 0;
  el.style.left = Math.max(4, Math.min(x, W - r.width - 4)) + "px";
  const below = y + gap, above = y - gap - r.height;
  el.style.top = (below + r.height + 4 <= H ? below : above >= 4 ? above : Math.max(4, H - r.height - 4)) + "px";
  el.tabIndex = -1;
  el.focus({ preventScroll: true });
  if (first) { const f = el.querySelector(".citem:not(:disabled)"); if (f) f.focus({ preventScroll: true }); }
}

function ctxSub(it, first) {
  const at = ctxState.at;
  if (!at) return;
  const up = () => ctxOpen(at.x, at.y, at.items, at.touch, undefined, null, first);
  const items = [{ label: "‹ " + t("Back"), enabled: true, stay: true, run: up }, "-"].concat(it.sub);
  ctxOpen(at.x, at.y, items, at.touch, undefined, up, first);
}

function ctxKey(e) {
  const el = $("ctx");
  const items = [...el.querySelectorAll(".citem:not(:disabled)")];
  const i = items.indexOf(document.activeElement);
  if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); ctxClose(); return; }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const n = items.length;
    if (!n) return;
    items[e.key === "ArrowDown" ? (i + 1) % n : i < 0 ? n - 1 : (i - 1 + n) % n].focus({ preventScroll: true });
    return;
  }
  if (e.key === "ArrowRight" && i >= 0 && items[i]._it && items[i]._it.sub) { e.preventDefault(); ctxSub(items[i]._it, true); return; }
  if (e.key === "ArrowLeft" && ctxState.back) { e.preventDefault(); ctxState.back(); return; }
  if (e.key === "Home" || e.key === "End") { e.preventDefault(); if (items.length) items[e.key === "Home" ? 0 : items.length - 1].focus({ preventScroll: true }); return; }
  if (e.key === "Enter" || e.key === " ") return;
  e.preventDefault();
}

function ctxCmd(id, label) {
  const c = CMD[id];
  return { id, label: label || cmdLabel(c), key: cmdKeyText(id), enabled: cmdEnabled(c), run: () => runCmd(c) };
}

function waveMenuAt(clientX, clientY, touch, pid, spec) {
  if (!ed.doc) return;
  const r = $("wv").getBoundingClientRect(), x = clientX - r.left;
  const f = Math.round(Math.max(0, Math.min(ed.doc.frames, frameAt(x))));
  const inside = selOn() && f >= ed.sel.a && f <= ed.sel.b;
  if (!inside) { ed.sel = { a: 0, b: 0 }; ed.cursor = f; redraw(); }
  let mk = null;
  for (const m of shownMarks()) {
    const d = Math.min(Math.abs(xOf(m.a) - x), m.kind === "range" ? Math.abs(xOf(m.b) - x) : Infinity);
    if (d <= 5 && (!mk || d < mk.d)) mk = { m, d };
  }
  const stereo = ed.doc.channels > 1;
  const items = [
    ed.play.on ? ctxCmd("stop") : { label: selOn() ? t("Play the selection") : t("Play from here"), key: cmdKeyText("play"), enabled: true, run: () => startPlay(selOn() ? ed.sel.a : ed.cursor) },
    "-",
    ctxCmd("undo"), ctxCmd("redo"),
    "-",
    ctxCmd("cut"), ctxCmd("copy"), ctxCmd("paste", selOn() ? t("Paste — replaces the selection") : t("Paste")),
    ctxCmd("delete"), ctxCmd("silence"), ctxCmd("crop"), ctxCmd("insert"), ctxCmd("heal"), ctxCmd("nrCap"), ctxCmd("midi"), ctxCmd("tracks"),
    { label: t("Process"), enabled: true, subId: "process", sub: pxMenu(stereo) },
    "-",
    ctxCmd("selAll"), ctxCmd("deselect"), ctxCmd("zoomSel"), ctxCmd("zcIn"), ctxCmd("zcOut")
  ];
  if (stereo) items.push(ctxCmd("chanL"), ctxCmd("chanR"));
  if (!spec) items.push("-", ctxCmd("pencil", pen.on ? t("Pencil off") : t("Pencil: redraw samples")), ctxCmd("transients", tn.on ? t("Hide transient markers") : t("Show transient markers")));
  items.push("-", ctxCmd("markAdd", selOn() ? t("Add a range from the selection") : t("Add marker")), ctxCmd("locAdd"), ctxCmd("cueImport"));
  if (spec && spSelLive()) items.splice(1, 0, "-", ctxCmd("heal", t("Heal the spectral selection")), ctxCmd("delete", t("Remove the selected frequencies")));
  if (spec) items.push("-", ctxCmd("toolTime"), ctxCmd("toolRect"), ctxCmd("toolLasso"), ctxCmd("toolBrush"), "-", ctxCmd("specScale", SPV.log ? t("Linear frequency scale") : t("Logarithmic frequency scale")), ctxCmd("spec", t("Hide the spectrogram")));
  if (mk) {
    const m = mk.m, name = m.n + (m.name ? " · " + m.name : "");
    items.push("-",
      { label: t("Go to location") + " " + name, enabled: true, run: () => recallMark(m) },
      { label: t("Rename location") + " " + m.n + "…", enabled: true, run: () => renameMark(m) },
      { label: t("Delete location") + " " + m.n, enabled: true, run: () => markEdit("markdel", m.id) });
  }
  ctxOpen(clientX, clientY, items, touch, pid);
}

function pxMenu(stereo) {
  const out = [ctxCmd("fadeIn"), ctxCmd("fadeOut"), "-", ctxCmd("dcOff"), ctxCmd("reverse"), ctxCmd("invert")];
  if (stereo && ed.doc.channels === 2) out.push("-", ctxCmd("swap"), ctxCmd("lToR"), ctxCmd("rToL"), ctxCmd("mono"), ctxCmd("msEnc"), ctxCmd("msDec"));
  out.push("-", ed.doc.channels > 1 ? ctxCmd("newMono") : ctxCmd("newStereo"));
  return out;
}

function wireCtx() {
  const el = $("ctx");
  el.addEventListener("keydown", e => { e.stopPropagation(); ctxKey(e); });
  el.addEventListener("contextmenu", e => e.preventDefault());
  document.addEventListener("pointerdown", e => { if (!el.classList.contains("hidden") && !el.contains(e.target)) ctxClose(); }, true);
  el.addEventListener("pointerdown", () => { ctxState.fresh = true; }, true);
  window.addEventListener("resize", ctxClose);
  window.addEventListener("blur", ctxClose);
}
