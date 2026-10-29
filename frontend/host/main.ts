import type { MetronomeConfig, SignalMessage } from "../../shared/types.ts";
import QRCode from "qrcode";
import { nowSeconds } from "./clockSync.ts";
import { beatPositionAt, HostMetronomeScheduler } from "./metronome.ts";
import { SignalingClient } from "./signaling.ts";
import { SongEditor } from "./songEditor.ts";
import { hostPlaybackState, songStartMessage } from "./songPlayback.ts";
import { connectedPeerCount, participantSummary, peerStatusLabel } from "./status.ts";
import { HostWebRTC } from "./webrtc.ts";
import {
  METER_PRESETS,
  normalizeBeatsPerBar,
  normalizeBeatUnit,
  normalizeBpm,
  recordTap,
  stepBpm,
  tapTempoBpm,
} from "../shared/controlValues.ts";
import { NO_ANCHOR } from "../shared/metronome/configChange.ts";
import {
  buildPlaybackPlan,
  planCountInBars,
  planPositionAt,
  planStartPosition,
  type PlaybackPlan,
} from "../shared/song/plan.ts";
import { browserSongStorage, loadLibrary, saveLibrary } from "../shared/song/storage.ts";
import { BeatDisplay } from "../shared/ui/beatDisplay.ts";
import { planSongLine, signalingErrorLabel, songStartLabel, type SongLine, type StatusLabel } from "../shared/ui/labels.ts";
import { bindOutputOffsetControl } from "../shared/ui/outputOffsetControl.ts";
import { playbackPhase } from "../shared/ui/playback.ts";
import { ScreenWakeLock } from "../shared/wakeLock.ts";

const bpmInput = document.querySelector<HTMLInputElement>("#bpmInput")!;
const bpmRange = document.querySelector<HTMLInputElement>("#bpmRange")!;
const tapButton = document.querySelector<HTMLButtonElement>("#tapButton")!;
const beatInput = document.querySelector<HTMLInputElement>("#beatInput")!;
const beatUnitInput = document.querySelector<HTMLSelectElement>("#beatUnitInput")!;
const meterPresetButtons = METER_PRESETS.map((preset) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary";
  button.textContent = `${preset.beatsPerBar}/${preset.beatUnit}`;
  button.dataset.requiresRoom = "";
  button.addEventListener("click", () => {
    beatInput.value = String(preset.beatsPerBar);
    beatUnitInput.value = String(preset.beatUnit);
    broadcastConfig();
  });
  return { preset, button };
});
document.querySelector<HTMLElement>("#meterPresets")!.append(...meterPresetButtons.map(({ button }) => button));
const roomControls = document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>("[data-requires-room]");
const playButton = document.querySelector<HTMLButtonElement>("#playButton")!;
const audioNotice = document.querySelector<HTMLElement>("#audioNotice")!;
const createRoomButton = document.querySelector<HTMLButtonElement>("#createRoomButton")!;
const outputOffsetInput = document.querySelector<HTMLInputElement>("#outputOffsetInput")!;
const outputOffsetRange = document.querySelector<HTMLInputElement>("#outputOffsetRange")!;
const vibrationToggle = document.querySelector<HTMLInputElement>("#vibrationToggle")!;
const vibrationNote = document.querySelector<HTMLElement>("#vibrationNote")!;
const connectionStatus = document.querySelector<HTMLElement>("#connectionStatus")!;
const beatDisplay = new BeatDisplay(document.querySelector<HTMLElement>("#beatDisplay")!);
const participantsButton = document.querySelector<HTMLButtonElement>("#participantsButton")!;
const participantsButtonLabel = document.querySelector<HTMLElement>("#participantsButtonLabel")!;
const participantsDot = document.querySelector<HTMLElement>("#participantsDot")!;
const participantsDialog = document.querySelector<HTMLDialogElement>("#participantsDialog")!;
const participantsCloseButton = document.querySelector<HTMLButtonElement>("#participantsCloseButton")!;
const participantUrl = document.querySelector<HTMLInputElement>("#participantUrl")!;
const participantQr = document.querySelector<HTMLElement>("#participantQr")!;
const copyUrlButton = document.querySelector<HTMLButtonElement>("#copyUrlButton")!;
const copyStatus = document.querySelector<HTMLElement>("#copyStatus")!;
const participantCount = document.querySelector<HTMLElement>("#participantCount")!;
const participantList = document.querySelector<HTMLUListElement>("#participantList")!;
const participantsEmpty = document.querySelector<HTMLElement>("#participantsEmpty")!;
const tabs = {
  metronome: { tab: document.querySelector<HTMLButtonElement>("#metronomeTab")!, panel: document.querySelector<HTMLElement>("#metronomePanel")! },
  song: { tab: document.querySelector<HTMLButtonElement>("#songTab")!, panel: document.querySelector<HTMLElement>("#songPanel")! },
};
type HostTab = keyof typeof tabs;

const autoCreateRoomStorageKey = "p2p-metronome:auto-create-room";
const hostTabStorageKey = "p2p-metronome:host-tab";
const vibrationSupported = "vibrate" in navigator;
// Playback starts this long after it is asked for, so every participant hears of it in time.
const START_LEAD_SECONDS = 2;

let isPlaying = false;
let hasRoom = false;
let startHostTime: number | null = null;
let latestSentHostTime = nowSeconds();
let beatFrame: number | null = null;
// Set when the browser stops the audio (screen lock, a call, another app) after it has run.
let audioInterrupted = false;
// The tab whose playback the play button starts: the plain metronome or the song.
let activeTab: HostTab = "metronome";
// The song being played, from start to stop; null for the plain metronome and while stopped.
let activePlan: PlaybackPlan | null = null;
const scheduler = new HostMetronomeScheduler();
const wakeLock = new ScreenWakeLock();
const readOutputOffsetMs = bindOutputOffsetControl(outputOffsetInput, outputOffsetRange, (offsetMs) => {
  scheduler.setOutputOffsetMs(offsetMs);
});
const songStorage = browserSongStorage();
// Editing a song needs no room; only playing it does.
const songEditor = new SongEditor(tabs.song.panel, loadLibrary(songStorage), {
  onLibraryChange: (library) => {
    saveLibrary(songStorage, library);
    renderBeat();
  },
  onStartChange: () => renderBeat(),
});

function applyVibrationSetting(): void {
  scheduler.setVibrationEnabled(vibrationSupported && vibrationToggle.checked);
}

function readConfig(): MetronomeConfig {
  return {
    bpm: normalizeBpm(bpmInput.value),
    beatsPerBar: normalizeBeatsPerBar(beatInput.value),
    beatUnit: normalizeBeatUnit(beatUnitInput.value),
  };
}

// The last committed settings. The scheduler, broadcasts and late-join snapshots use these,
// never a value still being typed or dragged in the controls.
let appliedConfig = readConfig();

function setStatus(label: StatusLabel): void {
  connectionStatus.textContent = label.text;
  // Non-error statuses are cut to one line, so the full text stays available on hover.
  connectionStatus.title = label.text;
  connectionStatus.dataset.tone = label.tone;
}

function setPlaying(nextPlaying: boolean): void {
  isPlaying = nextPlaying;
  roomControls.forEach((control) => {
    control.disabled = !hasRoom;
  });
  vibrationToggle.disabled = !hasRoom || !vibrationSupported;
  playButton.textContent = nextPlaying ? "停止" : "再生";
  playButton.classList.toggle("is-playing", nextPlaying);
  // Playback belongs to the tab it started from, so the tabs and the song stay as they are until it stops.
  for (const { tab } of Object.values(tabs)) tab.disabled = nextPlaying;
  songEditor.setPlaying(nextPlaying);
}

function showTab(name: HostTab): void {
  activeTab = name;
  for (const [key, { tab, panel }] of Object.entries(tabs)) {
    const selected = key === name;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    panel.hidden = !selected;
  }
}

function selectTab(name: HostTab): void {
  if (isPlaying || name === activeTab) return;
  showTab(name);
  try {
    localStorage.setItem(hostTabStorageKey, name);
  } catch {
    // The tab is still switched; it is just not remembered for the next visit.
  }
  renderBeat();
}

const signaling = new SignalingClient();
const webRTC = new HostWebRTC(
  (message) => signaling.send(message),
  () => hostPlaybackState({ isPlaying, appliedConfig, startHostTime, activePlan }, scheduler, nowSeconds()),
);

function formatMs(label: string, seconds: number | null): string {
  return seconds === null ? `${label} --` : `${label} ${(seconds * 1000).toFixed(1)}ms`;
}

const SUMMARY_DESCRIPTIONS = {
  neutral: "まだ参加者はいません",
  ok: "全員同期済み",
  warn: "接続中または同期中の参加者がいます",
  error: "切断された参加者がいます",
} as const;

function renderParticipants(): void {
  const summary = participantSummary(webRTC.peers.values());
  participantsButtonLabel.textContent = `参加者 ${summary.count}`;
  participantsDot.dataset.tone = summary.tone;
  participantsButton.setAttribute("aria-label", `参加者 ${summary.count}人、${SUMMARY_DESCRIPTIONS[summary.tone]}`);

  participantList.innerHTML = "";
  participantCount.textContent = `${connectedPeerCount(webRTC.peers.values())}人接続中`;
  participantsEmpty.hidden = webRTC.peers.size > 0;
  participantList.hidden = webRTC.peers.size === 0;

  for (const peer of webRTC.peers.values()) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    const status = document.createElement("span");
    const metrics = document.createElement("span");
    const label = peerStatusLabel(peer);
    name.className = "participant-name";
    name.textContent = peer.name;
    status.className = "status-chip";
    status.dataset.tone = label.tone;
    status.textContent = label.text;
    metrics.className = "metric";
    metrics.textContent = [formatMs("RTT", peer.rtt), formatMs("offset", peer.offset), formatMs("jitter", peer.jitter)].join(" / ");
    item.append(name, status, metrics);
    participantList.append(item);
  }
}

signaling.onMessage((message: SignalMessage) => {
  if (message.type === "registered") {
    hasRoom = true;
    createRoomButton.disabled = true;
    createRoomButton.hidden = true;
    participantsButton.hidden = false;
    // Inviting is the host's next step, so the dialog opens once right after the room is created.
    void renderParticipantInvite(message.participantUrl ?? "").then(openParticipants);
    setStatus({ text: "部屋を作成しました", tone: "ok" });
    setPlaying(false);
    return;
  }

  if (message.type === "client_joined") {
    void webRTC.addClient(message.clientId, message.name);
    return;
  }

  if (message.type === "client_left") {
    webRTC.removeClient(message.clientId);
    return;
  }

  if (message.type === "answer" || message.type === "ice") {
    void webRTC.handleSignal(message);
    return;
  }

  if (message.type === "error") {
    setStatus({ text: signalingErrorLabel(message.message), tone: "error" });
    if (!hasRoom) createRoomButton.disabled = false;
  }
});

webRTC.onChange(renderParticipants);

async function renderParticipantInvite(url: string): Promise<void> {
  participantUrl.value = url;
  participantQr.innerHTML = await QRCode.toString(url, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 2,
    color: {
      dark: "#111111",
      light: "#ffffff",
    },
  });
}

function openParticipants(): void {
  copyStatus.textContent = "";
  if (!participantsDialog.open) participantsDialog.showModal();
}

let copyStatusTimer: number | null = null;
function showCopyStatus(text: string): void {
  copyStatus.textContent = text;
  if (copyStatusTimer !== null) window.clearTimeout(copyStatusTimer);
  copyStatusTimer = window.setTimeout(() => {
    copyStatus.textContent = "";
    copyStatusTimer = null;
  }, 2000);
}

participantsButton.addEventListener("click", openParticipants);
participantsCloseButton.addEventListener("click", () => participantsDialog.close());
participantsDialog.addEventListener("click", (event) => {
  // The dialog element itself only receives clicks on its backdrop.
  if (event.target === participantsDialog) participantsDialog.close();
});

copyUrlButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(participantUrl.value);
    showCopyStatus("コピーしました");
  } catch {
    // The Clipboard API is unavailable on plain-HTTP LAN addresses; leave the URL selected instead.
    participantUrl.select();
    showCopyStatus("URLを選択しました。コピーして共有してください");
  }
});

/** The open song as it would start now, for the display while stopped on the song tab. */
function songPreviewPlan(): PlaybackPlan {
  return buildPlaybackPlan(songEditor.song, { ...songEditor.startOptions(), startHostTime: 0 });
}

function renderBeat(): void {
  // Draw what is being heard: a click sounds a little after its beat's host time.
  const hostNow = nowSeconds();
  // The countdown ends as the first click is heard, using the delay it was reserved with.
  const start = isPlaying ? startHostTime : null;
  // A song shows as stopped once its end is heard, even before the animation loop stops it.
  const end = isPlaying ? activePlan?.endHostTime ?? null : null;
  const phase = playbackPhase(
    hostNow,
    start === null ? null : scheduler.heardHostTimeFor(start),
    end === null ? null : scheduler.heardHostTimeFor(end),
  );
  const heardHostTime = hostNow - scheduler.audibleDelaySeconds();
  // Stopped on the song tab, the display shows the tempo, meter and bar the song will start on.
  const preview = !isPlaying && activeTab === "song" ? songPreviewPlan() : null;
  // A change shows once its first beat is heard.
  const config = (phase.kind === "playing" ? scheduler.configHeardAt(hostNow) : null) ?? (activePlan ?? preview)?.config ?? appliedConfig;
  const beat = phase.kind === "playing"
    ? scheduler.beatPositionHeardAt(hostNow) ?? beatPositionAt(heardHostTime, startHostTime, config)
    : null;
  const previewStart = preview && planStartPosition(preview);
  const song: SongLine | null = activePlan
    ? planSongLine(activePlan, phase, heardHostTime)
    : previewStart ? { position: songStartLabel(previewStart) } : null;
  beatDisplay.update({ phase, beat, config, song });
  const heard = activePlan && phase.kind === "playing" ? planPositionAt(activePlan, heardHostTime) : null;
  songEditor.showPlayback(heard, activePlan ? planCountInBars(activePlan) : 0);
}

function animateBeat(): void {
  // A song ends on its own once its end is heard; stopping also tells the participants.
  if (activePlan !== null && nowSeconds() >= scheduler.heardHostTimeFor(activePlan.endHostTime)) stopPlayback();
  else renderBeat();
  beatFrame = isPlaying ? requestAnimationFrame(animateBeat) : null;
}

function startPlayback(): void {
  scheduler.setOutputOffsetMs(readOutputOffsetMs());
  latestSentHostTime = nowSeconds();
  const startAt = latestSentHostTime + START_LEAD_SECONDS;
  // The song tab plays the open song from the chosen start; the metronome's settings stay as they are.
  activePlan = activeTab === "song"
    ? buildPlaybackPlan(songEditor.song, { ...songEditor.startOptions(), startHostTime: startAt })
    : null;
  startHostTime = activePlan?.startHostTime ?? startAt;
  setPlaying(true);
  if (beatFrame === null) animateBeat();
  if (activePlan) {
    const { config, changes, endHostTime } = activePlan;
    void scheduler.start(config, activePlan.startHostTime, latestSentHostTime, { changes, endHostTime });
    webRTC.broadcastControl(songStartMessage(activePlan, latestSentHostTime));
  } else {
    const config = appliedConfig;
    void scheduler.start(config, startHostTime, latestSentHostTime);
    webRTC.broadcastControl({ type: "start", ...config, startHostTime, sentHostTime: latestSentHostTime });
  }
  void wakeLock.acquire();
}

function stopPlayback(): void {
  latestSentHostTime = nowSeconds();
  startHostTime = null;
  activePlan = null;
  setPlaying(false);
  renderBeat();
  scheduler.stop();
  void wakeLock.release();
  audioNotice.hidden = true;
  webRTC.broadcastControl({ type: "stop", sentHostTime: latestSentHostTime });
}

function togglePlayback(): void {
  if (isPlaying) stopPlayback();
  else startPlayback();
}

playButton.addEventListener("click", togglePlayback);

// While the audio is stopped the scheduler keeps the beat grid without sending clicks, so the
// clicks continue in place once it runs again. Starting playback resumes it as well.
scheduler.onAudioStateChange((state) => {
  audioInterrupted = state !== "running";
  audioNotice.hidden = !(isPlaying && audioInterrupted);
});

function resumeInterruptedAudio(): void {
  // A refused resume leaves the notice up for the next try.
  if (audioInterrupted) void scheduler.resumeAudio().catch(() => {});
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") resumeInterruptedAudio();
});
// Browsers resume audio only from a user gesture, so any tap or key press tries again. A touch counts
// as a gesture on pointerup, a mouse on pointerdown.
for (const type of ["pointerdown", "pointerup", "keydown"]) document.addEventListener(type, resumeInterruptedAudio);

// Space toggles playback unless focus is on a control that uses the key itself.
document.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat || event.isComposing) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target instanceof Element && event.target.closest("input, select, textarea, button, summary, a")) return;
  if (playButton.disabled || participantsDialog.open) return;
  event.preventDefault();
  togglePlayback();
});

/** Writes the applied values back to every control so they all agree with what is sent. */
function showConfig(config: MetronomeConfig): void {
  bpmInput.value = String(config.bpm);
  // The slider moves in whole BPM; a decimal typed into the number field sits at the nearest step.
  bpmRange.value = String(Math.round(config.bpm));
  beatInput.value = String(config.beatsPerBar);
  beatUnitInput.value = String(config.beatUnit);
  for (const { preset, button } of meterPresetButtons) {
    const selected = preset.beatsPerBar === config.beatsPerBar && preset.beatUnit === config.beatUnit;
    button.setAttribute("aria-pressed", String(selected));
  }
}

// A change must reach every device before it reserves the beat the change starts on. Devices reserve
// clicks 0.18s ahead (further by their output latency compensation), check every 25ms, and hear of the
// change one network delay after it is sent: 0.18 + 0.025 + ~0.1 delay + ~0.1 latency is about 0.4s.
// A device that still hears of it late continues on the same new grid from its next unreserved beat.
const CONFIG_CHANGE_LEAD_SECONDS = 0.4;

function broadcastConfig(): void {
  // A song plays its own settings; the metronome's controls are hidden then, and a change is dropped.
  if (activePlan !== null) {
    showConfig(appliedConfig);
    return;
  }
  appliedConfig = readConfig();
  showConfig(appliedConfig);
  // While playing, every device switches on the same announced beat; stopped, there is none to switch on.
  const anchor = isPlaying ? scheduler.anchorForConfigChange(appliedConfig, nowSeconds() + CONFIG_CHANGE_LEAD_SECONDS) : null;
  scheduler.updateConfig(appliedConfig, anchor ?? undefined);
  webRTC.broadcastControl({ type: "config", ...appliedConfig, ...(anchor ?? NO_ANCHOR) });
  renderBeat();
}

function setBpm(bpm: number): void {
  bpmInput.value = String(bpm);
  broadcastConfig();
}

document.querySelectorAll<HTMLButtonElement>("[data-bpm-step]").forEach((button) => {
  button.addEventListener("click", () => setBpm(stepBpm(appliedConfig.bpm, Number(button.dataset.bpmStep))));
});

// While dragging only the number field follows; the tempo is applied and sent once the slider is released.
bpmRange.addEventListener("input", () => {
  bpmInput.value = bpmRange.value;
});
bpmRange.addEventListener("change", broadcastConfig);

let taps: number[] = [];
tapButton.addEventListener("click", () => {
  taps = recordTap(taps, performance.now());
  const bpm = tapTempoBpm(taps);
  if (bpm !== null) setBpm(bpm);
});

bpmInput.addEventListener("change", broadcastConfig);
beatInput.addEventListener("change", broadcastConfig);
beatUnitInput.addEventListener("change", broadcastConfig);

vibrationToggle.addEventListener("change", applyVibrationSetting);

function createRoom(): void {
  if (hasRoom || createRoomButton.disabled) return;

  createRoomButton.disabled = true;
  setStatus({ text: "部屋を作成中…", tone: "neutral" });
  signaling.connect();
}

createRoomButton.addEventListener("click", createRoom);

for (const [name, { tab }] of Object.entries(tabs) as [HostTab, (typeof tabs)[HostTab]][]) {
  tab.addEventListener("click", () => selectTab(name));
}
// Arrow keys move between the two tabs, as in other tab lists.
document.querySelector<HTMLElement>(".tabs")!.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || isPlaying) return;
  event.preventDefault();
  const next: HostTab = event.key === "Home" ? "metronome" : event.key === "End" ? "song" : activeTab === "song" ? "metronome" : "song";
  selectTab(next);
  tabs[next].tab.focus();
});

try {
  if (localStorage.getItem(hostTabStorageKey) === "song") showTab("song");
} catch {
  // Without storage the metronome tab opens, as on a first visit.
}

setPlaying(false);
showConfig(appliedConfig);
renderBeat();
renderParticipants();
vibrationNote.hidden = vibrationSupported;
vibrationToggle.checked = false;
applyVibrationSetting();

try {
  const shouldAutoCreateRoom = sessionStorage.getItem(autoCreateRoomStorageKey) === "1";
  sessionStorage.removeItem(autoCreateRoomStorageKey);
  if (shouldAutoCreateRoom) createRoom();
} catch {
  // The manual room creation button remains available when storage is inaccessible.
}
