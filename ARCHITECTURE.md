# Architecture Overview

このドキュメントは、P2P同期メトロノームの構成を短時間で把握するための概要です。実装が変わった場合は、READMEとあわせて更新してください。

## 1. Project Structure

```text
[Project Root]/
├── src/
│   ├── server.ts              # Bun.serve によるHTTP配信とWebSocketシグナリング
│   ├── rooms.ts               # ホスト1台 + 複数クライアントの接続管理
│   └── types.ts               # シグナリング/DataChannelで使う共有型
├── public-host/
│   ├── index.html             # ホスト画面
│   ├── style.css              # ホスト画面のスタイル
│   ├── main.ts                # ホスト画面のUI制御
│   ├── signaling.ts           # ホスト側WebSocketシグナリング
│   ├── webrtc.ts              # ホスト側WebRTC PeerConnection管理
│   ├── clockSync.ts           # ホスト時刻とping/pong応答
│   └── metronome.ts           # ホスト側クリック音生成と発声補正
├── public-client/
│   ├── index.html             # 参加者画面
│   ├── style.css              # 参加者画面のスタイル
│   ├── main.ts                # 参加者画面のUI制御
│   ├── signaling.ts           # 参加者側WebSocketシグナリング
│   ├── webrtc.ts              # 参加者側WebRTC PeerConnection管理
│   ├── clockSync.ts           # 参加者側のRTT/offset/jitter推定
│   └── metronome.ts           # 参加者側クリック音生成と発声補正
├── README.md                  # セットアップと起動方法
├── package.json               # Bunスクリプトと依存関係
├── bun.lock                   # Bunロックファイル
├── tsconfig.json              # TypeScript設定
└── ARCHITECTURE.md            # このドキュメント
```

## 2. High-Level System Diagram

```text
                 HTTP :3001
        ┌────────────────────────┐
        │     Host Browser        │
        │  UI / Web Audio / RTC   │
        └───────────┬────────────┘
                    │ WebSocket signaling only
                    │ ws://<host-ip>:3001/ws
                    ▼
        ┌────────────────────────┐
        │      Bun Server         │
        │ HTTP static + signaling │
        └───────────┬────────────┘
                    │ HTTP :3000
                    ▼
        ┌────────────────────────┐
        │   Participant Browser   │
        │  UI / Web Audio / RTC   │
        └────────────────────────┘

Host Browser ── WebRTC DataChannel ── Participant Browser
          control: config / start / stop / state_snapshot
          sync:    ping / pong / sync_report
```

サーバはWebRTC接続を成立させるためのシグナリングだけを中継します。メトロノームのBPM、拍子、開始時刻、停止命令、同期レポートは、ホストブラウザと各参加者ブラウザのWebRTC DataChannelで直接送受信されます。音声データは送信せず、各端末がWeb Audio APIでクリック音を生成します。

## 3. Core Components

### 3.1. Bun Server

Name: Bun signaling/static server

Description: `Bun.serve` を2つ起動し、参加者画面を `:3000`、ホスト画面とWebSocketシグナリングを `:3001` で配信します。ホスト画面の参加者URLにはLAN内IPv4アドレスを埋め込み、同じURLのQRコードを `qrcode` ライブラリで生成します。

Technologies: Bun, TypeScript, WebSocket, `qrcode`

### 3.2. Room Management

Name: Fixed single-room peer registry

Description: `rooms.ts` がホスト1台と複数参加者を管理します。参加者が接続するとホストへ `client_joined` を通知し、以後の `offer`、`answer`、`ice` を宛先へ転送します。部屋IDはMVPでは固定で、参加者同士は直接接続しません。

Technologies: Bun WebSocket, TypeScript

### 3.3. Host Application

Name: Host browser app

Description: ホストだけがBPM、拍子、Start、Stopを操作できます。参加者一覧、RTT、offset、jitter、参加者URL、QRコードを表示します。各参加者に対して1つの `RTCPeerConnection` を作り、`control` と `sync` の2つのDataChannelを開きます。

Technologies: TypeScript, WebRTC, Web Audio API, HTML/CSS

### 3.4. Participant Application

Name: Participant browser app

Description: 参加者はJoinとEnable Audioを操作し、ホストから受け取った状態に従ってローカルでクリック音を予約再生します。`sync` DataChannel上のping/pongからRTT、offset、jitterを推定し、ホスト時刻をローカル時刻へ変換します。

Technologies: TypeScript, WebRTC, Web Audio API, HTML/CSS

### 3.5. Metronome Scheduling

Name: Local Web Audio scheduler

Description: ホスト・参加者のどちらも音声ファイルは使わず、`OscillatorNode` と `GainNode` でクリック音を生成します。1拍目は高い音、それ以外は低い音です。`setInterval` は直接発音には使わず、少し先のクリック音をWeb Audio APIへ予約します。

Technologies: Web Audio API

### 3.6. Clock Synchronization

Name: DataChannel ping/pong clock sync

Description: 参加者は `sync` DataChannelでpingを送り、ホストからpongを受け取ってRTT、offset、jitterを推定します。RTTが小さいサンプルを優先してoffsetを平均化し、jitterが十分小さくなるまで `syncing...` と表示します。

Technologies: WebRTC DataChannel, `performance.timeOrigin`, `performance.now`

## 4. Development & Testing Environment

Local Setup Instructions:

```bash
bun install
bun run dev
```

ローカル起動後、ホスト画面は `http://localhost:3001`、参加者画面は `http://localhost:3000` で開きます。同一LAN内のスマホや別PCからは、ホスト画面に表示される `http://<LAN IP>:3000` またはQRコードを使って参加します。

Testing:

```bash
bun run typecheck
```

現時点では自動テストはありません。動作確認は、同一PCの複数ブラウザタブまたは同一Wi-Fi内の複数端末で、Join、Enable Audio、Start、Stop、途中参加、RTT/offset/jitter表示、発声補正を確認します。

## 5. Future Considerations / Roadmap

- WebRTC接続状態やDataChannel状態の診断表示を増やす。
- マイク測定による実発声音のズレ補正を検討する。
- ルームIDや複数ホストを扱う場合は、`rooms.ts` の固定1部屋構成を拡張する。
- HTTPS配信や証明書対応が必要な環境では、BunサーバのTLS設定を追加する。
- 型チェックに加えて、時計同期ロジックやメッセージ処理の単体テストを追加する。

## 6. Project Identification

Project Name: P2P同期メトロノーム

Runtime: Bun

Primary Language: TypeScript

Date of Last Update: 2026-05-18

## 7. Glossary / Acronyms

BPM: 1分あたりの拍数です。

WebRTC: ブラウザ間でP2P通信を行うための技術です。このシステムでは音声ではなくDataChannelだけを使います。

DataChannel: WebRTC上で任意のデータを送受信するチャンネルです。`control` と `sync` の2種類があります。

RTT: Round Trip Timeの略で、参加者からホストへpingを送り、pongが戻るまでの往復時間です。

offset: 参加者が推定した「ホスト時刻 - 参加者時刻」です。ホスト時刻をローカル時刻へ変換するために使います。

jitter: offsetサンプルの揺れ幅です。同期が安定したかどうかの判定に使います。

state_snapshot: 新しく参加したクライアントへ、現在の再生状態、BPM、拍子、開始時刻を伝える制御メッセージです。
