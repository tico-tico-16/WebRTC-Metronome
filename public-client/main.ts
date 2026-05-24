import type { ControlMessage, MetronomeConfig, SignalMessage } from "../src/types.ts";
import { ClockSync } from "./clockSync.ts";
import { beatAtHostTime, MetronomeScheduler } from "./metronome.ts";
import { SignalingClient } from "./signaling.ts";
import { ClientWebRTC } from "./webrtc.ts";

const joinButton = document.querySelector<HTMLButtonElement>("#joinButton")!;
const audioButton = document.querySelector<HTMLButtonElement>("#audioButton")!;
const connectionStatus = document.querySelector<HTMLElement>("#connectionStatus")!;
const syncStatus = document.querySelector<HTMLElement>("#syncStatus")!;
const bpmValue = document.querySelector<HTMLElement>("#bpmValue")!;
const meterValue = document.querySelector<HTMLElement>("#meterValue")!;
const beatValue = document.querySelector<HTMLElement>("#beatValue")!;
const rttValue = document.querySelector<HTMLElement>("#rttValue")!;
const offsetValue = document.querySelector<HTMLElement>("#offsetValue")!;
const jitterValue = document.querySelector<HTMLElement>("#jitterValue")!;
const outputOffsetInput = document.querySelector<HTMLInputElement>("#outputOffsetInput")!;

const signaling = new SignalingClient();
const webRTC = new ClientWebRTC((message) => signaling.send(message));
const clockSync = new ClockSync((message) => webRTC.sendSync(message));
const scheduler = new MetronomeScheduler();

function readOutputOffsetMs(): number {
  return Math.max(-200, Math.min(200, Number(outputOffsetInput.value) || 0));
}

let config: MetronomeConfig = { bpm: 120, beatsPerBar: 4, beatUnit: 4 };
let isPlaying = false;
let startHostTime: number | null = null;
let pendingStart = false;
let hasJoined = false;
let peerState = "disconnected";

function render(): void {
  bpmValue.textContent = String(config.bpm);
  meterValue.textContent = String(config.beatsPerBar);
  rttValue.textContent = clockSync.stats.rtt === null ? "--" : `${(clockSync.stats.rtt * 1000).toFixed(1)}ms`;
  offsetValue.textContent = clockSync.stats.offset === null ? "--" : `${(clockSync.stats.offset * 1000).toFixed(1)}ms`;
  jitterValue.textContent = clockSync.stats.jitter === null ? "--" : `${(clockSync.stats.jitter * 1000).toFixed(1)}ms`;

  if (isPlaying && startHostTime !== null) {
    const beat = beatAtHostTime(clockSync.hostNow(), startHostTime, config);
    beatValue.textContent = String(beat.beatInBar);
  } else {
    beatValue.textContent = "--";
  }

  if (!hasJoined || peerState === "disconnected" || peerState === "failed") {
    syncStatus.textContent = "waiting";
  } else if (!clockSync.stats.stable) {
    syncStatus.textContent = "syncing...";
  } else if (isPlaying && !scheduler.isAudioEnabled()) {
    syncStatus.textContent = "Enable Audio required";
  } else {
    syncStatus.textContent = isPlaying ? "playing" : "synced";
  }
}

function applyConfig(message: MetronomeConfig): void {
  config = {
    bpm: message.bpm,
    beatsPerBar: message.beatsPerBar,
    beatUnit: message.beatUnit,
  };
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
    render();
    return;
  }

  if (message.type === "stop") {
    isPlaying = false;
    startHostTime = null;
    pendingStart = false;
    scheduler.stop();
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
    connectionStatus.textContent = `Registered as ${message.id}`;
    return;
  }

  if (message.type === "host_available") {
    connectionStatus.textContent = message.hostPresent ? "Host available" : "Waiting for host";
    return;
  }

  if (message.type === "offer" || message.type === "ice") {
    void webRTC.handleSignal(message);
    return;
  }

  if (message.type === "error") {
    connectionStatus.textContent = message.message;
  }
});

webRTC.onState((state) => {
  peerState = state;
  connectionStatus.textContent = state;
  if (state === "sync open") {
    clockSync.start();
  }
});

webRTC.onControl(handleControl);
webRTC.onSync((message) => {
  const report = clockSync.handle(message);
  if (report) webRTC.sendSync(report);
  startWhenStable();
  render();
});

joinButton.addEventListener("click", () => {
  hasJoined = true;
  signaling.connect(`Client ${Math.floor(Math.random() * 1000)}`);
  joinButton.disabled = true;
  connectionStatus.textContent = "Joining...";
  render();
});

audioButton.addEventListener("click", () => {
  void scheduler.enableAudio().then(() => {
    audioButton.disabled = true;
    startWhenStable();
    render();
  });
});

outputOffsetInput.addEventListener("input", () => {
  scheduler.setOutputOffsetMs(readOutputOffsetMs());
});

setInterval(render, 100);
render();
