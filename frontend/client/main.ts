import type { ControlMessage, MetronomeConfig, PlaybackPlanMessage, SignalMessage } from "../../shared/types.ts";
import { ClockSync } from "./clockSync.ts";
import { beatPositionAt, MetronomeScheduler } from "./metronome.ts";
import { SignalingClient } from "./signaling.ts";
import { ClientWebRTC } from "./webrtc.ts";
import {
  messageAnchor,
  pendingFromStart,
  pendingPlaybackAt,
  withConfigChange,
  type PendingPlayback,
} from "../shared/metronome/configChange.ts";
import { isHostPeerId } from "../shared/peerSignals.ts";
import { BeatDisplay } from "../shared/ui/beatDisplay.ts";
import {
  connectionLabel,
  isConnectionLost,
  participantSyncLabel,
  planSongLine,
  signalingErrorLabel,
  type StatusLabel,
} from "../shared/ui/labels.ts";
import { bindOutputOffsetControl } from "../shared/ui/outputOffsetControl.ts";
import { playbackPhase } from "../shared/ui/playback.ts";
import { ScreenWakeLock } from "../shared/wakeLock.ts";

const audioGate = document.querySelector<HTMLElement>("#audioGate")!;
const audioGateTitle = document.querySelector<HTMLElement>("#audioGateTitle")!;
const audioGateHint = document.querySelector<HTMLElement>("#audioGateHint")!;
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
const wakeLock = new ScreenWakeLock();
const readOutputOffsetMs = bindOutputOffsetControl(outputOffsetInput, outputOffsetRange, (offsetMs) => {
  scheduler.setOutputOffsetMs(offsetMs);
});

function applyVibrationSetting(): void {
  scheduler.setVibrationEnabled(vibrationSupported && vibrationToggle.checked);
}

let config: MetronomeConfig = { bpm: 120, beatsPerBar: 4, beatUnit: 4 };
let isPlaying = false;
let startHostTime: number | null = null;
// What the host is playing, kept until this device can start on it (clock stable and audio on).
let pendingPlayback: PendingPlayback | null = null;
// The song the host is playing, for the song display; null for the plain metronome.
let activePlan: PlaybackPlanMessage | null = null;
let hasJoined = false;
let peerState = "disconnected";
let beatFrame: number | null = null;
// Once audio has been enabled, audio that is not running was stopped by the browser
// (screen lock, a call, another app) and the gate comes back to resume it.
let audioWasEnabled = false;
// The server sends an error just before closing the socket; keep it rather than a generic message.
let signalingError: string | null = null;

function setStatus(label: StatusLabel, connectionLost = false): void {
  connectionStatus.textContent = label.text;
  // Non-error statuses are cut to one line, so the full text stays available on hover.
  connectionStatus.title = label.text;
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
  // A song shows as stopped once its end is heard, even before render() stops it.
  const end = isPlaying ? activePlan?.endHostTime ?? null : null;
  const phase = playbackPhase(
    hostNow,
    start === null ? null : scheduler.heardHostTimeFor(start),
    end === null ? null : scheduler.heardHostTimeFor(end),
  );
  // Until clicks are reserved, follow the grid the host announced, with the changes already due.
  const heardHostTime = hostNow - scheduler.audibleDelaySeconds();
  const planned = pendingPlayback && pendingPlaybackAt(pendingPlayback, heardHostTime);
  // A change shows once its first beat is heard.
  const shownConfig = (phase.kind === "playing" ? scheduler.configHeardAt(hostNow) ?? planned?.config : null) ?? config;
  const beat = phase.kind === "playing"
    ? scheduler.beatPositionHeardAt(hostNow)
      ?? beatPositionAt(heardHostTime, planned?.startHostTime ?? startHostTime, planned?.config ?? config, planned?.startBeatInBar)
    : null;
  // A song names the section and bar being heard, as on the host.
  const song = activePlan ? planSongLine(activePlan, phase, heardHostTime) : null;
  beatDisplay.update({ phase, beat, config: shownConfig, song });
}

function animateBeat(): void {
  renderBeat();
  beatFrame = isPlaying ? requestAnimationFrame(animateBeat) : null;
}

/**
 * A song ends on its own: once its end is heard, stop as if the host's stop had arrived, so the
 * display returns to stopped even when that message is late. Not before the first clock sample,
 * when hostNow() is only this device's clock.
 */
function stopAtPlanEnd(): void {
  const end = activePlan?.endHostTime;
  if (!isPlaying || end === undefined || clockSync.stats.offset === null) return;
  if (clockSync.hostNow() >= scheduler.heardHostTimeFor(end)) stopPlayback();
}

function render(): void {
  stopAtPlanEnd();
  rttValue.textContent = formatMs(clockSync.stats.rtt);
  offsetValue.textContent = formatMs(clockSync.stats.offset);
  jitterValue.textContent = formatMs(clockSync.stats.jitter);

  const label = participantSyncLabel({
    joined: hasJoined,
    connectionLost: isConnectionLost(peerState),
    stable: clockSync.stats.stable,
    isPlaying,
    audioEnabled: scheduler.isAudioEnabled(),
    audioWasEnabled,
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
  pendingPlayback = null;
  activePlan = null;
  scheduler.stop();
  void wakeLock.release();
}

function handleHostDisconnected(): void {
  stopPlayback();
  clockSync.stop();
}

function startWhenStable(): void {
  if (pendingPlayback === null || !isPlaying || !clockSync.stats.stable) return;

  if (!scheduler.isAudioEnabled()) {
    render();
    return;
  }

  const hostNow = clockSync.hostNow();
  // A song that has already ended has nothing left to play.
  if (pendingPlayback.endHostTime !== undefined && hostNow >= pendingPlayback.endHostTime) {
    stopPlayback();
    return;
  }
  // A change whose beat has come becomes the start, so this device joins the grid the host plays now.
  const playback = pendingPlaybackAt(pendingPlayback, hostNow);
  pendingPlayback = null;
  scheduler.setOutputOffsetMs(readOutputOffsetMs());
  scheduler.start(playback.config, playback.startHostTime, hostNow, (hostTime) => clockSync.localTimeForHostTime(hostTime), {
    startBeatInBar: playback.startBeatInBar,
    changes: playback.changes,
    endHostTime: playback.endHostTime,
  });
}

function handleControl(message: ControlMessage): void {
  if (message.type === "config") {
    applyConfig(message);
    const anchor = messageAnchor(message);
    if (pendingPlayback !== null) {
      pendingPlayback = withConfigChange(pendingPlayback, config, anchor);
      startHostTime = pendingPlayback.startHostTime;
    } else if (isPlaying) {
      scheduler.updateConfig(config, anchor ?? undefined);
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
    activePlan = message.plan ?? null;
    pendingPlayback = pendingFromStart(config, message.startHostTime, message.plan);
    void wakeLock.acquire();
    startWhenStable();
    render();
    return;
  }

  if (message.type === "state_snapshot") {
    isPlaying = message.isPlaying;
    startHostTime = message.startHostTime;
    // With a plan, startHostTime is the song's original start and the plan rebuilds the grid from it.
    activePlan = message.isPlaying ? message.plan ?? null : null;
    pendingPlayback = message.isPlaying && message.startHostTime !== null
      ? pendingFromStart(config, message.startHostTime, message.plan)
      : null;
    if (message.isPlaying) {
      void wakeLock.acquire();
    } else {
      scheduler.stop();
      void wakeLock.release();
    }
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
    // An offer from another participant would replace the live connection to the host.
    if (isHostPeerId(message.from)) void webRTC.handleSignal(message);
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

/**
 * Shows the gate again while audio that was enabled is stopped, and picks up again once it runs.
 * The first-time texts are not needed after that, so the gate keeps the resume texts.
 */
function handleAudioState(): void {
  if (!audioWasEnabled) return;
  const running = scheduler.isAudioEnabled();
  audioGate.hidden = running;
  audioState.hidden = !running;
  if (running) {
    // A start still waiting for audio proceeds now. An engine that had already started needs nothing:
    // it stopped scheduling while canSchedule() was false, and scheduleAhead maps each beat with the
    // current clocks (audioNow + (beatLocalTime - localNow) + offset), so the time the audio clock
    // stood still is absorbed, the beats that passed are skipped, and clicks continue on the beat grid.
    startWhenStable();
  } else {
    audioGateTitle.textContent = "音声が中断されました";
    audioGateHint.textContent = "画面ロックや着信などで音が止まりました。ボタンを押すと再開します。";
    audioButton.textContent = "音を再開する";
  }
  render();
}

function resumeInterruptedAudio(): void {
  if (!audioWasEnabled || scheduler.isAudioEnabled()) return;
  // A refused resume leaves the gate up for the next try.
  void scheduler.resumeAudio().then(handleAudioState, () => {});
}

scheduler.onAudioStateChange(handleAudioState);

audioButton.addEventListener("click", () => {
  if (audioWasEnabled) {
    resumeInterruptedAudio();
    return;
  }
  void scheduler.enableAudio().then(() => {
    audioWasEnabled = true;
    handleAudioState();
  });
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") resumeInterruptedAudio();
});
// Browsers resume audio only from a user gesture, so any tap or key press tries again. A touch counts
// as a gesture on pointerup, a mouse on pointerdown.
for (const type of ["pointerdown", "pointerup", "keydown"]) document.addEventListener(type, resumeInterruptedAudio);

reconnectButton.addEventListener("click", () => location.reload());

vibrationToggle.addEventListener("change", applyVibrationSetting);

vibrationNote.hidden = vibrationSupported;
vibrationToggle.checked = false;
vibrationToggle.disabled = !vibrationSupported;
applyVibrationSetting();

setInterval(render, 100);
joinSharedRoom();
render();
