# Architecture Overview

このドキュメントは、P2P同期メトロノームの構成を短時間で把握するための概要です。実装が変わった場合は、READMEとあわせて更新してください。

## 1. Project Structure

```text
[Project Root]/
├── frontend/
│   ├── index.html             # トップページ
│   ├── style.css              # トップページのスタイル
│   ├── host/
│   │   ├── index.html         # ホスト画面
│   │   ├── style.css          # ホスト画面のスタイル
│   │   ├── main.ts            # ホスト画面のUI制御
│   │   ├── signaling.ts       # ホスト側WebSocketシグナリング
│   │   ├── webrtc.ts          # ホスト側WebRTC PeerConnection管理
│   │   ├── clockSync.ts       # ホスト時刻とping/pong応答
│   │   └── metronome.ts       # 音声有効化待ちと共通エンジンへの委譲
│   ├── client/
│   │   ├── index.html         # 参加者画面
│   │   ├── style.css          # 参加者画面のスタイル
│   │   ├── main.ts            # 参加者画面のUI制御
│   │   ├── signaling.ts       # 参加者側WebSocketシグナリング
│   │   ├── webrtc.ts          # 参加者側WebRTC PeerConnection管理
│   │   ├── clockSync.ts       # 参加者側のRTT/offset/jitter推定
│   │   └── metronome.ts       # 音声有効状態・時刻変換と共通エンジンへの委譲
│   ├── shared/
│   │   ├── webrtcConfig.ts    # ホスト・参加者共通のICEサーバー設定
│   │   └── metronome/
│   │       ├── beat.ts        # 拍間隔・拍位置の純粋関数
│   │       ├── engine.ts      # 拍管理と先読み予約、現在拍・次の強拍の照会
│   │       ├── clickOutput.ts # AudioContextの有効化とクリック生成
│   │       └── vibrationOutput.ts # 振動設定・予約・取消し
│   ├── tests/
│   │   ├── helpers/browser.ts # 手動時計・タイマー・ブラウザAPIのモック
│   │   ├── metronome.test.ts  # 既存の役割別APIに対する回帰テスト
│   │   └── metronomeEngine.test.ts # ブラウザに依存しないエンジンのテスト
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
│   └── wrangler.jsonc         # Worker、Durable Object、migration、observability設定
├── shared/
│   └── types.ts               # frontend/server で使う共有型
├── scripts/
│   └── dev.ts                 # frontend/serverの一括起動と開発URL表示
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
  /        -> frontend/index.html
  /host/   -> frontend/host/index.html
  /client/ -> frontend/client/index.html

Host Browser ── WebRTC DataChannel ── Participant Browser
          control: config / start / stop / state_snapshot
          sync:    ping / pong / sync_report
```

serverはWebRTC接続を成立させるためのシグナリングだけを中継します。frontendはViteでトップページ、ホスト画面、参加者画面を配信します。メトロノームのBPM、拍子、開始時刻、停止命令、同期レポートは、ホストブラウザと各参加者ブラウザのWebRTC DataChannelで直接送受信されます。音声データは送信せず、各端末がWeb Audio APIでクリック音を生成します。

## 3. Core Components

### 3.1. Frontend Static Serving

Name: Vite frontend

Description: `frontend/package.json` の `dev` は Vite を `--host 0.0.0.0 --port 3000 --strictPort` で起動します。ViteのMPA設定により、トップページ `/`、ホスト画面 `/host/`、参加者画面 `/client/` を配信します。TypeScript、CSS、HTML内のローカルアセット参照はViteが処理します。トップページからホスト画面へ移動でき、ホスト画面はサーバーから返された参加者URLをもとにQRコードを生成します。

Technologies: Vite, TypeScript, HTML/CSS, `qrcode`

### 3.2. Signaling Server

Name: Cloudflare Worker signaling server

Description: `server/src/index.ts` が Worker entrypointです。`/ws/host` へのWebSocket接続ではランダムな部屋IDを作成し、`/ws/client?room=<roomId>` へのWebSocket接続では指定された部屋IDを使います。どちらも `env.ROOMS.idFromName(roomId)` で同じ Durable Object に転送します。リクエスト、登録、シグナリング転送、切断などをJSON形式で記録し、Wrangler設定でWorkers Logs、Invocation Logs、Workers Tracesを有効化しています。

Technologies: Cloudflare Workers, Wrangler, TypeScript, WebSocket

### 3.3. Room Management

Name: Durable Object room registry

Description: `server/src/room.ts` の `RoomDurableObject` が部屋IDごとにホスト1台と複数参加者を管理します。ホストが部屋を作成すると参加者URLが発行され、参加者は共有URLの `room` パラメータで対象部屋へ自動参加します。参加者が接続するとホストへ `client_joined` を通知し、以後の `offer`、`answer`、`ice` を同じ部屋内の宛先へ転送します。部屋一覧や参加者による部屋検索はありません。

Technologies: Durable Objects, WebSocket Hibernation API, TypeScript

### 3.4. Host Application

Name: Host browser app

Description: ホストだけが部屋作成、BPM、拍子、Start、Stopを操作できます。BPMと拍子は再生中も変更でき、現在の拍位置を維持したまま以後の予約再生へ反映されます。端末固有の出力遅延を手動調整するため、-200msから200msの発声補正を設定できます。部屋作成後に参加者一覧、RTT、offset、jitter、参加者URL、QRコードを表示します。各参加者に対して1つの `RTCPeerConnection` を作り、`control` と `sync` の2つのDataChannelを開きます。

Technologies: TypeScript, WebRTC, Web Audio API, HTML/CSS

### 3.5. Participant Application

Name: Participant browser app

Description: 参加者はホストから共有されたURLまたはQRコードで開くと自動参加し、ブラウザの自動再生制限を解除するEnable Audioと、-200msから200msの手動発声補正を操作します。ホストから受け取った状態に従ってローカルでクリック音を予約再生します。`sync` DataChannel上のping/pongからRTT、offset、jitterを推定し、ホスト時刻をローカル時刻へ変換します。再生中に参加した場合は次の強拍を開始基準として受け取り、時計同期が安定し、かつ音声が有効になるまで再生開始を保留します。ホストまたはシグナリングとの接続が失われた場合は、再生と時計同期を停止します。

Technologies: TypeScript, WebRTC, Web Audio API, HTML/CSS

### 3.6. Metronome Scheduling

Name: Local Web Audio scheduler

Description: ホスト・参加者は共通の `MetronomeEngine` に拍管理と先読み予約を委譲します。`ClickOutput` は `OscillatorNode` と `GainNode` でクリック音を生成し、`VibrationOutput` は振動の設定・予約・取消しを管理します。1拍目は高い音、それ以外は低い音です。拍子0では強拍を付けません。

エンジンには端末の現在時刻、ホスト時刻から端末時刻への変換、周期タイマー、音声・振動出力、予約可能状態の判定を注入します。ブラウザAPIや `ClockSync` への直接依存はありません。ホストの時刻変換は恒等関数、参加者は予約ごとに時計同期の変換関数を評価します。時刻・拍間隔は秒、タイマー間隔・振動時間・UIの発声補正はミリ秒です。

25ms間隔のタイマーは直接発音には使わず、180ms先までのクリック音をWeb Audio APIへ予約します。20msを超えて遅れた拍は予約せずに進め、予約履歴は64拍まで保持します。発声補正は `audioNow + (hostToLocalTime(beatHostTime) - localNow) + offsetSeconds` の最後に加算し、履歴のホスト時刻・拍番号には加算しません。

既存の `HostMetronomeScheduler` / `MetronomeScheduler` の公開メソッドとimport元を維持しています。ホストの `start()` は音声有効化を待機します。参加者の `start()` は同期的で、別途音声を有効化し、AudioContextがrunningの場合に予約を進めます。ホストの予約判定は従来どおりAudioContextの存在のみです。

再生中のBPM・拍子変更は、次の拍位置を保持しながら新しい設定を以後の予約へ反映します。過去の予約を再計画するテンポ履歴は今回の共通化では導入していません。次の強拍の照会もエンジンに集約し、途中参加用の開始基準をホストの既存APIから取得します。

Technologies: Web Audio API

### 3.7. Clock Synchronization

Name: DataChannel ping/pong clock sync

Description: 参加者は `sync` DataChannelで350msごとにpingを送り、ホストからpongを受け取ってRTT、offset、jitterを推定します。直近12サンプルを保持し、RTTが小さい5サンプルを優先してoffsetを平均化します。5サンプル以上かつjitterが25ms未満になるまで `syncing...` と表示し、同期が安定してから保留中の再生を開始します。

Technologies: WebRTC DataChannel, `performance.timeOrigin`, `performance.now`

### 3.8. WebRTC Connectivity

Name: Shared ICE configuration

Description: ホストと参加者は `frontend/shared/webrtcConfig.ts` の共通 `RTCConfiguration` を使います。ICEサーバーには無料公開STUNサーバー `stun:stun.l.google.com:19302` を設定しています。TURNサーバーは設定していないため、対称NATやUDP制限などがあるネットワークではP2P接続を確立できない場合があります。

Technologies: WebRTC, ICE, STUN

### 3.9. Shared Types

Name: Shared protocol types

Description: `shared/types.ts` に、シグナリング、制御メッセージ、同期メッセージ、メトロノーム設定の型を集約します。frontend と server の両方が同じプロトコル型を参照します。serverのWorker runtime型は `server/wrangler.jsonc` から `wrangler types` で生成した `server/worker-configuration.d.ts` を使います。

Technologies: TypeScript

## 4. Development & Testing Environment

Local Setup Instructions:

```bash
bun install
bun run dev
```

ルートの `scripts/dev.ts` がViteとWranglerを子プロセスとして一括起動し、localhostと検出したLAN IPv4アドレスの開発URLを表示します。ローカル起動後、トップページは `http://localhost:3000/`、ホスト画面は `http://localhost:3000/host/` で開きます。同一LAN内のスマホや別PCから参加する場合は、ホスト画面も `http://<LAN IP>:3000/host/` で開き、表示される `http://<LAN IP>:3000/client/?room=<roomId>` またはQRコードを使って参加します。

Production:

- Frontend: Cloudflare Pages (`https://metronome.tico-tico.com/`)
- Signaling server: Cloudflare Workers + Durable Objects (`metronome-signal.tico-tico.com`)
- Observability: Workers Logs, Invocation Logs, Workers Traces

Testing:

```bash
bun run test
bun run typecheck
bun run build:frontend
```

自動テストにはBun標準の `bun:test` を使用します。`frontend/tests/metronome.test.ts` はホスト・参加者の既存公開APIに対する回帰テストで、共通化前に成功する状態を確立し、共通化後も同じ期待値を使っています。ブラウザAPIのモックは各テスト後に復元し、グローバルを差し替えるスイートは `describe.serial` で直列実行します。`metronomeEngine.test.ts` はブラウザのグローバルを用意せず、注入した依存だけで予約を検証します。

対象は拍子0・1・3・4、開始境界・途中開始、先読みと遅延許容、時計差・発声補正、設定更新、現在拍・強拍の照会、音声有効化の遅延・拒否、音声パラメータ、振動、周期タイマーの停止と再開始です。内部フィールドではなく、拍照会と出力予約の時刻・アクセントを確認します。共通コードとテストもfrontendの型チェックに含めます。

今後も各リファクタリングの前に対象と影響範囲のテストを追加し、変更後は蓄積した全テストを実行します。不具合修正では、その項目の着手時に正しい期待動作を決め、修正前に失敗する再現テストを追加します。

`server/wrangler.jsonc` を変更した場合は、Wranglerの生成型も更新します。

```bash
bun run --cwd server types
```

ブラウザの結合確認は、同一PCの複数ブラウザタブまたは同一Wi-Fi内の複数端末で、トップページからの遷移、部屋作成、共有URL/QRからの自動参加、Enable Audio、Start、Stop、再生中のBPM・拍子変更、途中参加、切断時の停止、RTT/offset/jitter表示、発声補正を確認します。ブラウザの画面状態やモックでは、実際のスピーカー間の音響同期や振動モーターの動作は検証できません。これらは対応端末で確認します。

### R01後も残る既知の課題

- R02: 設定変更の共通適用時刻・基準拍を通信していないため、受信遅延や先読み範囲の違いでBPM・拍子変更後の位相がずれる可能性があります。設定変更テストは現在の各スケジューラの挙動を確認するもので、端末間の変更同期を保証しません。
- R03a: Stopは周期タイマー・拍履歴・振動を解除しますが、Web Audioへ予約した未発音の音源は取り消しません。
- R03b: ホストのAudioContext有効化待ちの間にStopした場合、古いStartが待機完了後に再生を開始し得ます。

これらは挙動保持の共通化と分けて修正します。CI全体の整備、通信・時計同期・サーバーのテストは今回の対象外です。

## 5. Future Considerations / Roadmap

- WebRTC接続状態やDataChannel状態の診断表示を増やす。
- 部屋の永続化やホスト再接続が必要な場合は、Durable Object storageの利用を検討する。
- スケジューラの回帰テストに加えて、時計同期ロジックやメッセージ処理の単体テストを追加する。

## 6. Project Identification

Project Name: P2P同期メトロノーム

Runtime: Bun scripts, Vite frontend, Cloudflare Workers server

Primary Language: TypeScript

Date of Last Update: 2026-09-06

## 7. Glossary / Acronyms

BPM: 1分あたりの拍数です。

WebRTC: ブラウザ間でP2P通信を行うための技術です。このシステムでは音声ではなくDataChannelだけを使います。

DataChannel: WebRTC上で任意のデータを送受信するチャンネルです。`control` と `sync` の2種類があります。

RTT: Round Trip Timeの略で、参加者からホストへpingを送り、pongが戻るまでの往復時間です。

offset: 参加者が推定した「ホスト時刻 - 参加者時刻」です。ホスト時刻をローカル時刻へ変換するために使います。

jitter: offsetサンプルの揺れ幅です。同期が安定したかどうかの判定に使います。

state_snapshot: 新しく参加したクライアントへ、現在の再生状態、BPM、拍子、開始時刻を伝える制御メッセージです。
