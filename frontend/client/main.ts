import type { ControlMessage, MetronomeConfig, SignalMessage } from "../../shared/types.ts";
import { ClockSync } from "./clockSync.ts";
import { beatPositionAt, MetronomeScheduler } from "./metronome.ts";
import { SignalingClient } from "./signaling.ts";
import { ClientWebRTC } from "./webrtc.ts";
import { BeatDisplay } from "../shared/ui/beatDisplay.ts";
import {
  connectionLabel,
  isConnectionLost,
  participantSyncLabel,
  signalingErrorLabel,
  type StatusLabel,
} from "../shared/ui/labels.ts";
import { bindOutputOffsetControl } from "../shared/ui/outputOffsetControl.ts";
import { playbackPhase } from "../shared/ui/playback.ts";

const audioGate = document.querySelector<HTMLElement>("#audioGate")!;
const audioButton = document.querySelector<HTMLButtonElement>("#audioButton")!;
const audioState = document.querySelector<HTMLElement>("#audioState")!;
const connectionStatus = document.querySelector<HTMLElement>("#connectionStatus")!;
const reconnectButton = document.querySelector<HTMLButtonElement>("#reconnectButton")!;
const syncStatus = document.querySelector<HTMLElement>("#syncStatus")!;
const beatDisplay = new BeatDisplay(document.querySelector<HTMLElement>("#beatDisplay")!);
const rttValue = document.querySelector<HTMLElement>("#rttValue")!;
const offsetValue = document.querySelector<HTMLElement>("#offsetValue")!;
const jitterValue = document.querySelector<HTMLElement>("#jitterValue")!;
const outputOffsetInput = document.querySelector<HTMLInputElement>("#outputOffsetInput")!;
const outputOffsetRange = document.querySelector<HTMLInputElement>("#outputOffsetRange")!;
const vibrationToggle = document.querySelector<HTMLInputElement>("#vibrationToggle")!;
const vibrationNote = document.querySelector<HTMLElement>("#vibrationNote")!;
const roomId = new URLSearchParams(location.search).get("room")?.trim() ?? "";
const vibrationSupported = "vibrate" in navigator;

const signaling = new SignalingClient();
const webRTC = new ClientWebRTC((message) => signaling.send(message));
const clockSync = new ClockSync((message) => webRTC.sendSync(message));
const scheduler = new MetronomeScheduler();
const readOutputOffsetMs = bindOutputOffsetControl(outputOffsetInput, outputOffsetRange, (offsetMs) => {
  scheduler.setOutputOffsetMs(offsetMs);
});

function applyVibrationSetting(): void {
  scheduler.setVibrationEnabled(vibrationSupported && vibrationToggle.checked);
}

let config: MetronomeConfig = { bpm: 120, beatsPerBar: 4, beatUnit: 4 };
let isPlaying = false;
let startHostTime: number | null = null;
let pendingStart = false;
let hasJoined = false;
let peerState = "disconnected";
let beatFrame: number | null = null;
// The server sends an error just before closing the socket; keep it rather than a generic message.
let signalingError: string | null = null;

function setStatus(label: StatusLabel, connectionLost = false): void {
  connectionStatus.textContent = label.text;
  connectionStatus.dataset.tone = label.tone;
  reconnectButton.hidden = !connectionLost;
}

function formatMs(seconds: number | null): string {
  return seconds === null ? "--" : `${(seconds * 1000).toFixed(1)}ms`;
}

function renderBeat(): void {
  // Draw what is being heard: a click sounds a little after its beat's host time.
  const hostNow = clockSync.hostNow();
  // The countdown ends as the first click is heard, using the delay it was reserved with.
  const start = isPlaying ? startHostTime : null;
  const phase = playbackPhase(hostNow, start === null ? null : scheduler.heardHostTimeFor(start));
  const beat = phase.kind === "playing"
    ? scheduler.beatPositionHeardAt(hostNow) ?? beatPositionAt(hostNow - scheduler.audibleDelaySeconds(), startHostTime, config)
    : null;
  beatDisplay.update({ phase, beat, config });
}

function animateBeat(): void {
  renderBeat();
  beatFrame = isPlaying ? requestAnimationFrame(animateBeat) : null;
}

function render(): void {
  rttValue.textContent = formatMs(clockSync.stats.rtt);
  offsetValue.textContent = formatMs(clockSync.stats.offset);
  jitterValue.textContent = formatMs(clockSync.stats.jitter);

  const label = participantSyncLabel({
    joined: hasJoined,
    connectionLost: isConnectionLost(peerState),
    stable: clockSync.stats.stable,
    isPlaying,
    audioEnabled: scheduler.isAudioEnabled(),
  });
  syncStatus.textContent = label.text;
  syncStatus.dataset.tone = label.tone;

  renderBeat();
  if (isPlaying && beatFrame === null) beatFrame = requestAnimationFrame(animateBeat);
}

function applyConfig(message: MetronomeConfig): void {
  config = {
    bpm: message.bpm,
    beatsPerBar: message.beatsPerBar,
    beatUnit: message.beatUnit,
  };
}

function stopPlayback(): void {
  isPlaying = false;
  startHostTime = null;
  pendingStart = false;
  scheduler.stop();
}

function handleHostDisconnected(): void {
  stopPlayback();
  clockSync.stop();
}

function startWhenStable(): void {
  if (!pendingStart || !isPlaying || startHostTime === null || !clockSync.stats.stable) return;

  if (!scheduler.isAudioEnabled()) {
    render();
    return;
  }

  pendingStart = false;
  const hostNow = clockSync.hostNow();
  scheduler.setOutputOffsetMs(readOutputOffsetMs());
  scheduler.start(config, startHostTime, hostNow, (hostTime) => clockSync.localTimeForHostTime(hostTime));
}

function handleControl(message: ControlMessage): void {
  if (message.type === "config") {
    applyConfig(message);
    if (isPlaying) {
      scheduler.updateConfig(config);
    }
    render();
    return;
  }

  if (message.type === "stop") {
    stopPlayback();
    render();
    return;
  }

  applyConfig(message);

  if (message.type === "start") {
    isPlaying = true;
    startHostTime = message.startHostTime;
    pendingStart = true;
    startWhenStable();
    render();
    return;
  }

  if (message.type === "state_snapshot") {
    isPlaying = message.isPlaying;
    startHostTime = message.startHostTime;
    pendingStart = message.isPlaying;
    if (!message.isPlaying) scheduler.stop();
    startWhenStable();
    render();
  }
}

signaling.onMessage((message: SignalMessage) => {
  if (message.type === "registered") {
    hasJoined = true;
    setStatus({ text: "ホストに接続中…", tone: "neutral" });
    render();
    return;
  }

  if (message.type === "host_available") {
    setStatus(message.hostPresent ? { text: "ホストに接続中…", tone: "neutral" } : { text: "ホストを待っています", tone: "warn" });
    if (!message.hostPresent) {
      handleHostDisconnected();
      peerState = "disconnected";
      render();
    }
    return;
  }

  if (message.type === "offer" || message.type === "ice") {
    void webRTC.handleSignal(message);
    return;
  }

  if (message.type === "error") {
    signalingError = signalingErrorLabel(message.message);
    setStatus({ text: signalingError, tone: "error" }, true);
  }
});

webRTC.onState((state) => {
  peerState = state;
  setStatus(connectionLabel(state), isConnectionLost(state));
  if (state === "sync open") {
    clockSync.start();
  }
  if (isConnectionLost(state)) {
    handleHostDisconnected();
  }
  render();
});

signaling.onClose(() => {
  handleHostDisconnected();
  peerState = "disconnected";
  setStatus({ text: signalingError ?? "サーバーとの接続が切れました", tone: "error" }, true);
  render();
});

webRTC.onControl(handleControl);
webRTC.onSync((message) => {
  const report = clockSync.handle(message);
  if (report) webRTC.sendSync(report);
  startWhenStable();
  render();
});

function joinSharedRoom(): void {
  if (!roomId) {
    audioGate.hidden = true;
    outputOffsetInput.disabled = true;
    outputOffsetRange.disabled = true;
    vibrationToggle.disabled = true;
    setStatus({ text: "ホストのURLまたはQRコードからアクセスしてください", tone: "error" });
    render();
    return;
  }

  hasJoined = true;
  signaling.connect(roomId, `Client ${Math.floor(Math.random() * 1000)}`);
  setStatus({ text: "参加中…", tone: "neutral" });
  render();
}

audioButton.addEventListener("click", () => {
  void scheduler.enableAudio().then(() => {
    audioGate.hidden = true;
    audioState.hidden = false;
    startWhenStable();
    render();
  });
});

reconnectButton.addEventListener("click", () => location.reload());

vibrationToggle.addEventListener("change", applyVibrationSetting);

vibrationNote.hidden = vibrationSupported;
vibrationToggle.checked = false;
vibrationToggle.disabled = !vibrationSupported;
applyVibrationSetting();

setInterval(render, 100);
joinSharedRoom();
render();
