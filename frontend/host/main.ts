import type { MetronomeConfig, SignalMessage } from "../../shared/types.ts";
import QRCode from "qrcode";
import { nowSeconds } from "./clockSync.ts";
import { beatAtHostTime, HostMetronomeScheduler } from "./metronome.ts";
import { SignalingClient } from "./signaling.ts";
import { connectedPeerCount, peerStatusLabel } from "./status.ts";
import { HostWebRTC } from "./webrtc.ts";
import { normalizeBeatsPerBar, normalizeBpm } from "../shared/controlValues.ts";
import { BeatDisplay } from "../shared/ui/beatDisplay.ts";
import { signalingErrorLabel, type StatusLabel } from "../shared/ui/labels.ts";
import { bindOutputOffsetControl } from "../shared/ui/outputOffsetControl.ts";
import { playbackPhase } from "../shared/ui/playback.ts";

const bpmInput = document.querySelector<HTMLInputElement>("#bpmInput")!;
const beatInput = document.querySelector<HTMLInputElement>("#beatInput")!;
const playButton = document.querySelector<HTMLButtonElement>("#playButton")!;
const createRoomButton = document.querySelector<HTMLButtonElement>("#createRoomButton")!;
const outputOffsetInput = document.querySelector<HTMLInputElement>("#outputOffsetInput")!;
const outputOffsetRange = document.querySelector<HTMLInputElement>("#outputOffsetRange")!;
const vibrationToggle = document.querySelector<HTMLInputElement>("#vibrationToggle")!;
const vibrationNote = document.querySelector<HTMLElement>("#vibrationNote")!;
const connectionStatus = document.querySelector<HTMLElement>("#connectionStatus")!;
const beatDisplay = new BeatDisplay(document.querySelector<HTMLElement>("#beatDisplay")!);
const inviteBox = document.querySelector<HTMLElement>("#inviteBox")!;
const participantUrl = document.querySelector<HTMLElement>("#participantUrl")!;
const participantQr = document.querySelector<HTMLElement>("#participantQr")!;
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
    beatUnit: 4,
  };
}

function setStatus(label: StatusLabel): void {
  connectionStatus.textContent = label.text;
  connectionStatus.dataset.tone = label.tone;
}

function setPlaying(nextPlaying: boolean): void {
  isPlaying = nextPlaying;
  bpmInput.disabled = !hasRoom;
  beatInput.disabled = !hasRoom;
  outputOffsetInput.disabled = !hasRoom;
  outputOffsetRange.disabled = !hasRoom;
  vibrationToggle.disabled = !hasRoom || !vibrationSupported;
  playButton.disabled = !hasRoom;
  playButton.textContent = nextPlaying ? "停止" : "再生";
  playButton.classList.toggle("is-playing", nextPlaying);
}

const signaling = new SignalingClient();
const webRTC = new HostWebRTC(
  (message) => signaling.send(message),
  () => ({
    isPlaying,
    config: readConfig(),
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
    void renderParticipantInvite(message.participantUrl ?? "");
    inviteBox.hidden = false;
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
  participantUrl.textContent = url;
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

function renderBeat(): void {
  const hostNow = nowSeconds();
  const phase = playbackPhase(hostNow, isPlaying ? startHostTime : null);
  const config = readConfig();
  const beat = phase.kind === "playing"
    ? scheduler.beatAtHostTime(hostNow) ?? beatAtHostTime(hostNow, startHostTime, config)
    : null;
  beatDisplay.update({ phase, beat, config });
}

function animateBeat(): void {
  renderBeat();
  beatFrame = isPlaying ? requestAnimationFrame(animateBeat) : null;
}

function startPlayback(): void {
  const config = readConfig();
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
  if (playButton.disabled) return;
  event.preventDefault();
  togglePlayback();
});

function broadcastConfig(): void {
  const config = readConfig();
  bpmInput.value = String(config.bpm);
  beatInput.value = String(config.beatsPerBar);
  scheduler.updateConfig(config);
  webRTC.broadcastControl({ type: "config", ...config });
  renderBeat();
}

bpmInput.addEventListener("change", broadcastConfig);
beatInput.addEventListener("change", broadcastConfig);

vibrationToggle.addEventListener("change", applyVibrationSetting);

function createRoom(): void {
  if (hasRoom || createRoomButton.disabled) return;

  createRoomButton.disabled = true;
  setStatus({ text: "部屋を作成中…", tone: "neutral" });
  signaling.connect();
}

createRoomButton.addEventListener("click", createRoom);

setPlaying(false);
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
