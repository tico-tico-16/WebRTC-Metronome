# Architecture Overview

このドキュメントは、P2P同期メトロノームの構成を短時間で把握するための概要です。実装が変わった場合は、READMEとあわせて更新してください。

## 1. Project Structure

```text
[Project Root]/
├── frontend/
│   ├── host/
│   │   ├── index.html         # ホスト画面
│   │   ├── style.css          # ホスト画面のスタイル
│   │   ├── main.ts            # ホスト画面のUI制御
│   │   ├── signaling.ts       # ホスト側WebSocketシグナリング
│   │   ├── webrtc.ts          # ホスト側WebRTC PeerConnection管理
│   │   ├── clockSync.ts       # ホスト時刻とping/pong応答
│   │   └── metronome.ts       # ホスト側クリック音生成と発声補正
│   ├── client/
│       ├── index.html         # 参加者画面
│       ├── style.css          # 参加者画面のスタイル
│       ├── main.ts            # 参加者画面のUI制御
│       ├── signaling.ts       # 参加者側WebSocketシグナリング
│       ├── webrtc.ts          # 参加者側WebRTC PeerConnection管理
│       ├── clockSync.ts       # 参加者側のRTT/offset/jitter推定
│       └── metronome.ts       # 参加者側クリック音生成と発声補正
│   ├── package.json           # Vite配信、frontend build、QR生成依存
│   ├── tsconfig.json          # frontend用TypeScript設定
│   └── vite.config.ts         # ViteのMPA設定
├── server/
│   ├── src/
│   │   ├── index.ts           # Worker entrypoint
│   │   └── room.ts            # Durable Objectによる部屋単位の接続管理
│   ├── package.json           # Wrangler実行スクリプト
│   ├── tsconfig.json          # server用TypeScript設定
│   ├── worker-configuration.d.ts # Wrangler生成のWorker型定義
│   └── wrangler.jsonc         # Worker、Durable Object binding、migration設定
├── shared/
│   └── types.ts               # frontend/server で使う共有型
├── README.md                  # セットアップと起動方法
├── package.json               # Bunスクリプトと依存関係
├── bun.lock                   # Bunロックファイル
├── tsconfig.json              # TypeScript設定
└── ARCHITECTURE.md            # このドキュメント
```

## 2. High-Level System Diagram

```text
                 HTTP :3000/host/
        ┌────────────────────────┐
        │     Host Browser        │
        │  UI / Web Audio / RTC   │
        └───────────┬────────────┘
                    │ WebSocket signaling only
                    │ ws://<host-ip>:3001/ws/host
                    ▼
        ┌────────────────────────┐
        │ Cloudflare Worker       │
        │ + Durable Object Room   │
        └───────────┬────────────┘
                    │ WebSocket signaling only
                    │ ws://<host-ip>:3001/ws/client?room=<roomId>
                    ▼
        ┌────────────────────────┐
        │   Participant Browser   │
        │  UI / Web Audio / RTC   │
        └────────────────────────┘

Frontend static files are served separately by Vite:
  /host/   -> frontend/host/index.html
  /client/ -> frontend/client/index.html

Host Browser ── WebRTC DataChannel ── Participant Browser
          control: config / start / stop / state_snapshot
          sync:    ping / pong / sync_report
```

serverはWebRTC接続を成立させるためのシグナリングだけを中継します。frontendはViteでホスト画面と参加者画面を配信します。メトロノームのBPM、拍子、開始時刻、停止命令、同期レポートは、ホストブラウザと各参加者ブラウザのWebRTC DataChannelで直接送受信されます。音声データは送信せず、各端末がWeb Audio APIでクリック音を生成します。

## 3. Core Components

### 3.1. Frontend Static Serving

Name: Vite frontend

Description: `frontend/package.json` の `dev` は Vite を `--host 0.0.0.0 --port 3000 --strictPort` で起動し、`frontend/host/index.html` と `frontend/client/index.html` を配信します。TypeScript、CSS、HTML内のローカルアセット参照はViteが処理します。ホスト画面はサーバーから返された参加者URLをもとにQRコードを生成します。

Technologies: Vite, TypeScript, HTML/CSS, `qrcode`

### 3.2. Signaling Server

Name: Cloudflare Worker signaling server

Description: `server/src/index.ts` が Worker entrypointです。`/ws/host` へのWebSocket接続ではランダムな部屋IDを作成し、`/ws/client?room=<roomId>` へのWebSocket接続では指定された部屋IDを使います。どちらも `env.ROOMS.idFromName(roomId)` で同じ Durable Object に転送します。

Technologies: Cloudflare Workers, Wrangler, TypeScript, WebSocket

### 3.3. Room Management

Name: Durable Object room registry

Description: `server/src/room.ts` の `RoomDurableObject` が部屋IDごとにホスト1台と複数参加者を管理します。ホストが部屋を作成すると参加者URLが発行され、参加者は共有URLの `room` パラメータで対象部屋へ自動参加します。参加者が接続するとホストへ `client_joined` を通知し、以後の `offer`、`answer`、`ice` を同じ部屋内の宛先へ転送します。部屋一覧や参加者による部屋検索はありません。

Technologies: Durable Objects, WebSocket Hibernation API, TypeScript

### 3.4. Host Application

Name: Host browser app

Description: ホストだけが部屋作成、BPM、拍子、Start、Stopを操作できます。部屋作成後に参加者一覧、RTT、offset、jitter、参加者URL、QRコードを表示します。各参加者に対して1つの `RTCPeerConnection` を作り、`control` と `sync` の2つのDataChannelを開きます。

Technologies: TypeScript, WebRTC, Web Audio API, HTML/CSS

### 3.5. Participant Application

Name: Participant browser app

Description: 参加者はホストから共有されたURLまたはQRコードで開くと自動参加し、Enable Audioだけを操作します。ホストから受け取った状態に従ってローカルでクリック音を予約再生します。`sync` DataChannel上のping/pongからRTT、offset、jitterを推定し、ホスト時刻をローカル時刻へ変換します。

Technologies: TypeScript, WebRTC, Web Audio API, HTML/CSS

### 3.6. Metronome Scheduling

Name: Local Web Audio scheduler

Description: ホスト・参加者のどちらも音声ファイルは使わず、`OscillatorNode` と `GainNode` でクリック音を生成します。1拍目は高い音、それ以外は低い音です。`setInterval` は直接発音には使わず、少し先のクリック音をWeb Audio APIへ予約します。

Technologies: Web Audio API

### 3.7. Clock Synchronization

Name: DataChannel ping/pong clock sync

Description: 参加者は `sync` DataChannelでpingを送り、ホストからpongを受け取ってRTT、offset、jitterを推定します。RTTが小さいサンプルを優先してoffsetを平均化し、jitterが十分小さくなるまで `syncing...` と表示します。

Technologies: WebRTC DataChannel, `performance.timeOrigin`, `performance.now`

### 3.8. Shared Types

Name: Shared protocol types

Description: `shared/types.ts` に、シグナリング、制御メッセージ、同期メッセージ、メトロノーム設定の型を集約します。frontend と server の両方が同じプロトコル型を参照します。serverのWorker runtime型は `server/wrangler.jsonc` から `wrangler types` で生成した `server/worker-configuration.d.ts` を使います。

Technologies: TypeScript

## 4. Development & Testing Environment

Local Setup Instructions:

```bash
bun install
bun run dev
```

ローカル起動後、ホスト画面は同一PCでは `http://localhost:3000/host/` で開きます。同一LAN内のスマホや別PCから参加する場合は、ホスト画面も `http://<LAN IP>:3000/host/` で開き、表示される `http://<LAN IP>:3000/client/?room=<roomId>` またはQRコードを使って参加します。

Testing:

```bash
bun run typecheck
```

`server/wrangler.jsonc` を変更した場合は、Wranglerの生成型も更新します。

```bash
bun run --cwd server types
```

現時点では自動テストはありません。動作確認は、同一PCの複数ブラウザタブまたは同一Wi-Fi内の複数端末で、部屋作成、共有URL/QRからの自動参加、Enable Audio、Start、Stop、途中参加、RTT/offset/jitter表示、発声補正を確認します。

## 5. Future Considerations / Roadmap

- WebRTC接続状態やDataChannel状態の診断表示を増やす。
- マイク測定による実発声音のズレ補正を検討する。
- 部屋の永続化やホスト再接続が必要な場合は、Durable Object storageの利用を検討する。
- frontendをCloudflare PagesまたはWorkers Assetsへ移す。
- 型チェックに加えて、時計同期ロジックやメッセージ処理の単体テストを追加する。

## 6. Project Identification

Project Name: P2P同期メトロノーム

Runtime: Bun scripts, Vite frontend, Cloudflare Workers server

Primary Language: TypeScript

Date of Last Update: 2026-05-27

## 7. Glossary / Acronyms

BPM: 1分あたりの拍数です。

WebRTC: ブラウザ間でP2P通信を行うための技術です。このシステムでは音声ではなくDataChannelだけを使います。

DataChannel: WebRTC上で任意のデータを送受信するチャンネルです。`control` と `sync` の2種類があります。

RTT: Round Trip Timeの略で、参加者からホストへpingを送り、pongが戻るまでの往復時間です。

offset: 参加者が推定した「ホスト時刻 - 参加者時刻」です。ホスト時刻をローカル時刻へ変換するために使います。

jitter: offsetサンプルの揺れ幅です。同期が安定したかどうかの判定に使います。

state_snapshot: 新しく参加したクライアントへ、現在の再生状態、BPM、拍子、開始時刻を伝える制御メッセージです。
