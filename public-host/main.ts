import type { MetronomeConfig, SignalMessage } from "../src/types.ts";
import { nowSeconds } from "./clockSync.ts";
import { beatAtHostTime, HostMetronomeScheduler } from "./metronome.ts";
import { SignalingClient } from "./signaling.ts";
import { HostWebRTC } from "./webrtc.ts";

const bpmInput = document.querySelector<HTMLInputElement>("#bpmInput")!;
const beatInput = document.querySelector<HTMLInputElement>("#beatInput")!;
const startButton = document.querySelector<HTMLButtonElement>("#startButton")!;
const stopButton = document.querySelector<HTMLButtonElement>("#stopButton")!;
const createRoomButton = document.querySelector<HTMLButtonElement>("#createRoomButton")!;
const outputOffsetInput = document.querySelector<HTMLInputElement>("#outputOffsetInput")!;
const connectionStatus = document.querySelector<HTMLElement>("#connectionStatus")!;
const inviteBox = document.querySelector<HTMLElement>("#inviteBox")!;
const participantUrl = document.querySelector<HTMLElement>("#participantUrl")!;
const participantQr = document.querySelector<HTMLElement>("#participantQr")!;
const participantCount = document.querySelector<HTMLElement>("#participantCount")!;
const participantList = document.querySelector<HTMLUListElement>("#participantList")!;

let isPlaying = false;
let hasRoom = false;
let startHostTime: number | null = null;
let latestSentHostTime = nowSeconds();
const scheduler = new HostMetronomeScheduler();

function readOutputOffsetMs(): number {
  return Math.max(-200, Math.min(200, Number(outputOffsetInput.value) || 0));
}

function readConfig(): MetronomeConfig {
  const beatValue = Number(beatInput.value);
  const beatsPerBar = Number.isFinite(beatValue) ? Math.max(0, Math.floor(beatValue)) : 4;
  return {
    bpm: Math.max(30, Math.min(240, Number(bpmInput.value) || 120)),
    beatsPerBar,
    beatUnit: 4,
  };
}

function setPlaying(nextPlaying: boolean): void {
  isPlaying = nextPlaying;
  bpmInput.disabled = nextPlaying || !hasRoom;
  beatInput.disabled = nextPlaying || !hasRoom;
  outputOffsetInput.disabled = !hasRoom;
  startButton.disabled = nextPlaying || !hasRoom;
  stopButton.disabled = !nextPlaying || !hasRoom;
}

const signaling = new SignalingClient();
const webRTC = new HostWebRTC(
  (message) => signaling.send(message),
  () => ({
    isPlaying,
    config: readConfig(),
    startHostTime,
    sentHostTime: nowSeconds(),
  }),
);

function renderParticipants(): void {
  participantList.innerHTML = "";
  participantCount.textContent = `${webRTC.peers.size} connected`;

  for (const peer of webRTC.peers.values()) {
    const item = document.createElement("li");
    const left = document.createElement("span");
    const right = document.createElement("span");
    left.textContent = `${peer.name} (${peer.status})`;
    right.className = "metric";
    right.textContent = [
      peer.rtt === null ? "RTT --" : `RTT ${(peer.rtt * 1000).toFixed(1)}ms`,
      peer.offset === null ? "offset --" : `offset ${(peer.offset * 1000).toFixed(1)}ms`,
      peer.jitter === null ? "jitter --" : `jitter ${(peer.jitter * 1000).toFixed(1)}ms`,
    ].join(" / ");
    item.append(left, right);
    participantList.append(item);
  }
}

signaling.onMessage((message: SignalMessage) => {
  if (message.type === "registered") {
    hasRoom = true;
    createRoomButton.disabled = true;
    createRoomButton.hidden = true;
    participantUrl.textContent = message.participantUrl ?? "";
    participantQr.innerHTML = message.participantQrSvg ?? "";
    inviteBox.hidden = false;
    connectionStatus.textContent = `Room ${message.roomId} ready`;
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
    connectionStatus.textContent = message.message;
    if (!hasRoom) createRoomButton.disabled = false;
  }
});

webRTC.onChange(renderParticipants);

startButton.addEventListener("click", () => {
  const config = readConfig();
  scheduler.setOutputOffsetMs(readOutputOffsetMs());
  startHostTime = nowSeconds() + 2;
  latestSentHostTime = nowSeconds();
  setPlaying(true);
  connectionStatus.textContent = "Starting in 2 seconds";
  void scheduler.start(config, startHostTime, latestSentHostTime);
  webRTC.broadcastControl({ type: "start", ...config, startHostTime, sentHostTime: latestSentHostTime });
});

stopButton.addEventListener("click", () => {
  latestSentHostTime = nowSeconds();
  startHostTime = null;
  setPlaying(false);
  connectionStatus.textContent = "Stopped";
  scheduler.stop();
  webRTC.broadcastControl({ type: "stop", sentHostTime: latestSentHostTime });
});

function broadcastConfigWhenStopped(): void {
  if (isPlaying) return;
  webRTC.broadcastControl({ type: "config", ...readConfig() });
}

bpmInput.addEventListener("change", broadcastConfigWhenStopped);
beatInput.addEventListener("change", broadcastConfigWhenStopped);
outputOffsetInput.addEventListener("input", () => {
  scheduler.setOutputOffsetMs(readOutputOffsetMs());
});

createRoomButton.addEventListener("click", () => {
  createRoomButton.disabled = true;
  connectionStatus.textContent = "Creating room...";
  signaling.connect();
});

setInterval(() => {
  if (!isPlaying) return;
  const beat = beatAtHostTime(nowSeconds(), startHostTime, readConfig());
  connectionStatus.textContent = `Playing beat ${beat.beatInBar}`;
}, 100);

setPlaying(false);
