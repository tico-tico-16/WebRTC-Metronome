import type { MetronomeConfig, SignalMessage } from "../../shared/types.ts";
import QRCode from "qrcode";
import { nowSeconds } from "./clockSync.ts";
import { beatPositionAt, HostMetronomeScheduler } from "./metronome.ts";
import { SignalingClient } from "./signaling.ts";
import { connectedPeerCount, peerStatusLabel } from "./status.ts";
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
import { BeatDisplay } from "../shared/ui/beatDisplay.ts";
import { signalingErrorLabel, type StatusLabel } from "../shared/ui/labels.ts";
import { bindOutputOffsetControl } from "../shared/ui/outputOffsetControl.ts";
import { playbackPhase } from "../shared/ui/playback.ts";

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
const createRoomButton = document.querySelector<HTMLButtonElement>("#createRoomButton")!;
const outputOffsetInput = document.querySelector<HTMLInputElement>("#outputOffsetInput")!;
const outputOffsetRange = document.querySelector<HTMLInputElement>("#outputOffsetRange")!;
const vibrationToggle = document.querySelector<HTMLInputElement>("#vibrationToggle")!;
const vibrationNote = document.querySelector<HTMLElement>("#vibrationNote")!;
const connectionStatus = document.querySelector<HTMLElement>("#connectionStatus")!;
const beatDisplay = new BeatDisplay(document.querySelector<HTMLElement>("#beatDisplay")!);
const inviteButton = document.querySelector<HTMLButtonElement>("#inviteButton")!;
const emptyInviteButton = document.querySelector<HTMLButtonElement>("#emptyInviteButton")!;
const inviteDialog = document.querySelector<HTMLDialogElement>("#inviteDialog")!;
const inviteCloseButton = document.querySelector<HTMLButtonElement>("#inviteCloseButton")!;
const participantUrl = document.querySelector<HTMLInputElement>("#participantUrl")!;
const participantQr = document.querySelector<HTMLElement>("#participantQr")!;
const copyUrlButton = document.querySelector<HTMLButtonElement>("#copyUrlButton")!;
const copyStatus = document.querySelector<HTMLElement>("#copyStatus")!;
const participantCount = document.querySelector<HTMLElement>("#participantCount")!;
const participantList = document.querySelector<HTMLUListElement>("#participantList")!;
const participantsEmpty = document.querySelector<HTMLElement>("#participantsEmpty")!;

const autoCreateRoomStorageKey = "p2p-metronome:auto-create-room";
const vibrationSupported = "vibrate" in navigator;

let isPlaying = false;
let hasRoom = false;
let startHostTime: number | null = null;
let latestSentHostTime = nowSeconds();
let beatFrame: number | null = null;
const scheduler = new HostMetronomeScheduler();
const readOutputOffsetMs = bindOutputOffsetControl(outputOffsetInput, outputOffsetRange, (offsetMs) => {
  scheduler.setOutputOffsetMs(offsetMs);
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
}

const signaling = new SignalingClient();
const webRTC = new HostWebRTC(
  (message) => signaling.send(message),
  () => ({
    isPlaying,
    config: appliedConfig,
    startHostTime: isPlaying ? scheduler.nextStrongBeatHostTime(nowSeconds()) ?? startHostTime : startHostTime,
    sentHostTime: nowSeconds(),
  }),
);

function formatMs(label: string, seconds: number | null): string {
  return seconds === null ? `${label} --` : `${label} ${(seconds * 1000).toFixed(1)}ms`;
}

function renderParticipants(): void {
  participantList.innerHTML = "";
  participantCount.textContent = `${connectedPeerCount(webRTC.peers.values())}人接続中`;
  participantsEmpty.hidden = webRTC.peers.size > 0;

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
    inviteButton.hidden = false;
    emptyInviteButton.hidden = false;
    // Inviting is the host's next step, so the dialog opens once right after the room is created.
    void renderParticipantInvite(message.participantUrl ?? "").then(openInvite);
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

function openInvite(): void {
  copyStatus.textContent = "";
  if (!inviteDialog.open) inviteDialog.showModal();
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

inviteButton.addEventListener("click", openInvite);
emptyInviteButton.addEventListener("click", openInvite);
inviteCloseButton.addEventListener("click", () => inviteDialog.close());
inviteDialog.addEventListener("click", (event) => {
  // The dialog element itself only receives clicks on its backdrop.
  if (event.target === inviteDialog) inviteDialog.close();
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

function renderBeat(): void {
  // Draw what is being heard: a click sounds a little after its beat's host time.
  const hostNow = nowSeconds();
  const heardTime = hostNow - scheduler.audibleDelaySeconds();
  const phase = playbackPhase(heardTime, isPlaying ? startHostTime : null);
  const config = appliedConfig;
  const beat = phase.kind === "playing"
    ? scheduler.beatPositionHeardAt(hostNow) ?? beatPositionAt(heardTime, startHostTime, config)
    : null;
  beatDisplay.update({ phase, beat, config });
}

function animateBeat(): void {
  renderBeat();
  beatFrame = isPlaying ? requestAnimationFrame(animateBeat) : null;
}

function startPlayback(): void {
  const config = appliedConfig;
  scheduler.setOutputOffsetMs(readOutputOffsetMs());
  startHostTime = nowSeconds() + 2;
  latestSentHostTime = nowSeconds();
  setPlaying(true);
  if (beatFrame === null) animateBeat();
  void scheduler.start(config, startHostTime, latestSentHostTime);
  webRTC.broadcastControl({ type: "start", ...config, startHostTime, sentHostTime: latestSentHostTime });
}

function stopPlayback(): void {
  latestSentHostTime = nowSeconds();
  startHostTime = null;
  setPlaying(false);
  renderBeat();
  scheduler.stop();
  webRTC.broadcastControl({ type: "stop", sentHostTime: latestSentHostTime });
}

function togglePlayback(): void {
  if (isPlaying) stopPlayback();
  else startPlayback();
}

playButton.addEventListener("click", togglePlayback);

// Space toggles playback unless focus is on a control that uses the key itself.
document.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat || event.isComposing) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target instanceof Element && event.target.closest("input, select, textarea, button, summary, a")) return;
  if (playButton.disabled || inviteDialog.open) return;
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

function broadcastConfig(): void {
  appliedConfig = readConfig();
  showConfig(appliedConfig);
  scheduler.updateConfig(appliedConfig);
  webRTC.broadcastControl({ type: "config", ...appliedConfig });
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
