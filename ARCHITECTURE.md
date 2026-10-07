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
│   │   ├── status.ts          # 参加者ごとの状態ラベルと接続済み参加者数
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
│   │   ├── controlValues.ts   # BPM・拍子・発声補正の範囲と正規化、拍子プリセット、BPMの増減、タップテンポ
│   │   ├── clockStability.ts  # 時計同期が安定したかの判定
│   │   ├── ui/
│   │   │   ├── base.css       # ホスト・参加者共通のスタイルと色の変数
│   │   │   ├── beatDisplay.ts # 拍子の数の多角形と動く点、中央のBPM・カウントダウンの表示部品
│   │   │   ├── beatPolygon.ts # 多角形の頂点と点の位置の計算
│   │   │   ├── playback.ts    # 停止・カウントダウン・再生中の判定
│   │   │   ├── labels.ts      # 接続状態・エラー・同期状態・拍子の表示文言
│   │   │   └── outputOffsetControl.ts # 発声補正のスライダーと数値入力の連動
│   │   └── metronome/
│   │       ├── beat.ts        # 拍間隔・拍位置の純粋関数
│   │       ├── engine.ts      # 拍管理と先読み予約、現在拍と拍の中の位置・次の強拍・発音までの遅れの照会
│   │       ├── clickOutput.ts # AudioContextの有効化とクリック生成
│   │       └── vibrationOutput.ts # 振動設定・予約・取消し
│   ├── tests/
│   │   ├── helpers/browser.ts # 手動時計・タイマー・ブラウザAPIのモック
│   │   ├── metronome.test.ts  # 既存の役割別APIに対する回帰テスト
│   │   ├── metronomeEngine.test.ts # ブラウザに依存しないエンジンのテスト
│   │   ├── controls.test.ts   # 入力値の正規化、BPMの増減、タップテンポ、接続済み参加者数
│   │   ├── uiState.test.ts    # 再生状態・同期判定・表示文言
│   │   └── beatPolygon.test.ts # 多角形の頂点と点の位置
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

Description: ホストだけが部屋作成、BPM、拍子、再生・停止を操作できます。再生・停止は1つのボタンで切り替え、入力欄などにフォーカスがないときはSpaceキーでも操作できます（案内はボタンの `title` に表示）。PC幅（761px以上）では演奏パネルの中を、左に拍表示と再生ボタン、右にBPM・拍子・バイブレーション・詳細設定と2列に分け、表示領域の高さ650px程度のノートPCでも詳細設定を閉じた状態ならスクロールせずに収まります。左右は別の箱なので、詳細設定を開いても拍表示は動きません。拍表示の大きさはPC幅のときだけ画面の高さに合わせて320pxから200pxまでなめらかに縮みます（`svh` 基準のため、モバイルブラウザのバーの出入りでは変わりません）。スマホ幅では今までどおり1列に並べます。スクロールバーの幅は常に確保し、ヘッダーはPC幅では1行、狭い幅では2行に固定して、長い状態表示は省略記号で切り、全文は `title` で表示します。BPMは数値入力に加えて±1・±5ボタン、スライダー（離したときに送信）、タップテンポ（3回目のタップから直近の間隔の平均を反映し、2秒空くとやり直し）で変更できます。数値欄では小数も入力でき、ボタン・スライダー・タップは整数で変更します。スライダーのドラッグ中や数値欄の入力途中の値は、確定するまで再生・送信・途中参加者への状態には使いません。拍子は2/4・3/4・4/4・5/4・6/8・7/8のプリセットか、分子（0から16、0は強拍なし）と分母（2・4・8・16）で指定します。BPMは分母の音符を1拍として数えるため、6/8・BPM 120では八分音符が毎分120回鳴ります。BPMは30から240で、範囲外の入力は確定時に補正した値を入力欄へ戻します。BPMと拍子は再生中も変更でき、現在の拍位置を維持したまま以後の予約再生へ反映されます。端末固有の出力遅延を手動調整するため、詳細設定で-200msから200msの発声補正をスライダーと数値で設定できます。画面上部のヘッダーに接続状態を表示し、中央の拍表示には、拍子の分子と同じ数の頂点を持つ多角形（1拍目が真上、時計回り）を描き、点が辺の上を一定速度で進んで拍の瞬間に次の頂点へ着きます。拍子0・1は円（点が1拍で一周）、2は縦の線分を上下に往復します。拍の直後はその拍の頂点（拍子0では円）を強調し、多角形の中央にはBPM、下に拍子を表示します。開始前は点が1拍目の頂点で待ち、中央に開始までの秒数を表示します。点の位置は、発声補正と端末の出力遅延の分だけ遅らせて、実際に音が聞こえる時刻に合わせます。動きを減らす設定（`prefers-reduced-motion`）では点を動かさず、拍の直後だけの頂点（拍子0では円）の強調で拍を示します。図形は画面読み上げ用に、状態（停止中・開始までの秒数・何拍目か）と拍子・BPMをまとめたラベルを持ちます。参加者一覧は常時表示せず、ヘッダーの参加者ボタン（●と接続済みの人数）から開く参加者ダイアログにまとめます。●の色は、0人なら灰、切断された参加者がいれば赤、接続中・同期中の参加者がいれば黄、全員同期済みなら緑です。ダイアログには参加者一覧と、招待用の大きなQRコード、参加者URL、URLのコピーボタンを表示し、部屋作成の直後に一度だけ自動で開きます。Clipboard APIが使えない環境（LAN IPのHTTPなど）では、コピーの代わりにURLを選択状態にします。参加者ごとに接続中・同期中・同期済み・切断の状態とRTT、offset、jitterを表示し、参加者数には接続が確立した参加者だけを数えます。画面の文言は日本語で、シグナリングサーバーが英語で返す既知のエラーも日本語に置き換えて表示します。各参加者に対して1つの `RTCPeerConnection` を作り、`control` と `sync` の2つのDataChannelを開きます。

Technologies: TypeScript, WebRTC, Web Audio API, HTML/CSS

### 3.5. Participant Application

Name: Participant browser app

Description: 参加者はホストから共有されたURLまたはQRコードで開くと自動参加し、ブラウザの自動再生制限を解除する「音を有効にする」と、詳細設定の-200msから200msの手動発声補正を操作します。音声を有効にするまでは画面上部に大きな案内を表示し、有効化後は設定欄に「音声オン」と表示します。中央にはホストと共通の多角形の拍表示と同期状態を置き、RTT、offset、jitterは「接続の詳細」に表示します。接続状態はWebRTCの内部状態名ではなく日本語の文言で表示し、切断や接続失敗、サーバーのエラー時には再接続ボタン（ページの再読み込み）を表示します。ホスト・参加者とも、振動APIに非対応の端末ではバイブレーション設定に非対応である旨を表示します。ホストから受け取った状態に従ってローカルでクリック音を予約再生します。`sync` DataChannel上のping/pongからRTT、offset、jitterを推定し、ホスト時刻をローカル時刻へ変換します。再生中に参加した場合は次の強拍を開始基準として受け取り、時計同期が安定し、かつ音声が有効になるまで再生開始を保留します。ホストまたはシグナリングとの接続が失われた場合は、再生と時計同期を停止します。

Technologies: TypeScript, WebRTC, Web Audio API, HTML/CSS

### 3.6. Metronome Scheduling

Name: Local Web Audio scheduler

Description: ホスト・参加者は共通の `MetronomeEngine` に拍管理と先読み予約を委譲します。`ClickOutput` は `OscillatorNode` と `GainNode` でクリック音を生成し、`VibrationOutput` は振動の設定・予約・取消しを管理します。1拍目は高い音、それ以外は低い音です。拍子0では強拍を付けません。

エンジンには端末の現在時刻、ホスト時刻から端末時刻への変換、周期タイマー、音声・振動出力、予約可能状態の判定を注入します。ブラウザAPIや `ClockSync` への直接依存はありません。ホストの時刻変換は恒等関数、参加者は予約ごとに時計同期の変換関数を評価します。時刻・拍間隔は秒、タイマー間隔・振動時間・UIの発声補正はミリ秒です。拍間隔は `60 / BPM` 秒で、拍子の分母（`beatUnit`）は表示と通信にだけ使い、拍間隔の計算には使いません。拍表示のために、エンジンは予約済みの拍から「何拍目か」に加えて「その拍の中のどこにいるか（0〜1、その拍の長さで割った値）」を返し、予約済みの最後の拍を過ぎると1で止めます。まだ予約がないとき（参加者が音声を有効にする前など）は、開始時刻と設定から同じ値を計算します。音が聞こえるまでの遅れは発声補正と `AudioContext.outputLatency`（Safariなど非対応の環境では `baseLatency`、それもなければ0）の合計です。エンジンは各拍を予約した時点の遅れを使って「その拍が聞こえるホスト時刻」を記録し、表示はそれをもとに、最も新しく聞こえた拍とその中の位置を描きます（発声補正を大きく下げた直後は、聞こえる順番が拍の順番と入れ替わることがあるため）。拍の中の位置は「この拍が聞こえた時刻」から「次の拍が聞こえる時刻」までの割合で、補正の変更でクリックの間隔が伸び縮みしても、点はクリックが聞こえる瞬間に頂点へ着きます。開始前のカウントダウンも、最初のクリックが予約済みならその聞こえる時刻で終わります。そのため再生中に発声補正を変えても、すでに予約したクリックと表示はずれません。

25ms間隔のタイマーは直接発音には使わず、180ms先までのクリック音をWeb Audio APIへ予約します。20msを超えて遅れた拍は予約せずに進め、予約履歴は64拍まで保持します。発声補正は `audioNow + (hostToLocalTime(beatHostTime) - localNow) + offsetSeconds` の最後に加算し、履歴のホスト時刻・拍番号には加算しません。

既存の `HostMetronomeScheduler` / `MetronomeScheduler` の公開メソッドとimport元を維持しています。ホストの `start()` は音声有効化を待機します。参加者の `start()` は同期的で、別途音声を有効化し、AudioContextがrunningの場合に予約を進めます。ホストの予約判定は従来どおりAudioContextの存在のみです。

再生中のBPM・拍子変更は、次の拍位置を保持しながら新しい設定を以後の予約へ反映します。過去の予約を再計画するテンポ履歴は今回の共通化では導入していません。次の強拍の照会もエンジンに集約し、途中参加用の開始基準をホストの既存APIから取得します。

Technologies: Web Audio API

### 3.7. Clock Synchronization

Name: DataChannel ping/pong clock sync

Description: 参加者は `sync` DataChannelで350msごとにpingを送り、ホストからpongを受け取ってRTT、offset、jitterを推定します。直近12サンプルを保持し、RTTが小さい5サンプルを優先してoffsetを平均化します。5サンプル以上かつjitterが25ms未満になるまで「同期中…」と表示し、同期が安定してから保留中の再生を開始します。この安定判定は `frontend/shared/clockStability.ts` にあり、ホストも `sync_report` のサンプル数とjitterから参加者ごとの同期状態を表示するのに使います。

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

自動テストにはBun標準の `bun:test` を使用します。`frontend/tests/metronome.test.ts` はホスト・参加者の既存公開APIに対する回帰テストで、共通化前に成功する状態を確立し、共通化後も同じ期待値を使っています。ブラウザAPIのモックは各テスト後に復元し、グローバルを差し替えるスイートは `describe.serial` で直列実行します。`metronomeEngine.test.ts` はブラウザのグローバルを用意せず、注入した依存だけで予約を検証します。`controls.test.ts` は、画面から切り出した入力値の正規化、拍子のプリセットと分母、BPMの増減、タップテンポ、接続済み参加者数の判定を検証します。`uiState.test.ts` は、再生状態（停止・カウントダウン・再生中）、ホストの参加者ボタンの人数と状態の集約、時計同期の安定判定、接続状態・エラー・同期状態・拍子とBPMの表示文言と拍表示の読み上げ用ラベル、ホストの参加者状態ラベルを検証します。`beatPolygon.test.ts` は、拍子ごとの図形の種類、頂点の位置、点の位置（辺の上の補間、最後の拍から1拍目への折り返し、円の一周）を検証します。

対象は拍子0・1・3・4、開始境界・途中開始、先読みと遅延許容、時計差・発声補正、設定更新、現在拍・聞こえている拍の中の位置・強拍の照会、音が聞こえるまでの遅れ（再生中の発声補正の変更を含む）、音声有効化の遅延・拒否、音声パラメータ、振動、周期タイマーの停止と再開始です。内部フィールドではなく、拍照会と出力予約の時刻・アクセントを確認します。共通コードとテストもfrontendの型チェックに含めます。

今後も各リファクタリングの前に対象と影響範囲のテストを追加し、変更後は蓄積した全テストを実行します。不具合修正では、その項目の着手時に正しい期待動作を決め、修正前に失敗する再現テストを追加します。

`server/wrangler.jsonc` を変更した場合は、Wranglerの生成型も更新します。

```bash
bun run --cwd server types
```

ブラウザの結合確認は、同一PCの複数ブラウザタブまたは同一Wi-Fi内の複数端末で、トップページからの遷移、部屋作成、参加者ダイアログの表示（作成直後の自動表示、参加者ボタンの●の色、一覧、招待のコピー）、共有URL/QRからの自動参加、音声の有効化、再生・停止（ボタンとSpaceキー）、再生中のBPM・拍子変更、途中参加、切断時の停止、RTT/offset/jitter表示、発声補正を確認します。ブラウザの画面状態やモックでは、実際のスピーカー間の音響同期や振動モーターの動作は検証できません。これらは対応端末で確認します。

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

Date of Last Update: 2026-10-05

## 7. Glossary / Acronyms

BPM: 1分あたりの拍数です。

WebRTC: ブラウザ間でP2P通信を行うための技術です。このシステムでは音声ではなくDataChannelだけを使います。

DataChannel: WebRTC上で任意のデータを送受信するチャンネルです。`control` と `sync` の2種類があります。

RTT: Round Trip Timeの略で、参加者からホストへpingを送り、pongが戻るまでの往復時間です。

offset: 参加者が推定した「ホスト時刻 - 参加者時刻」です。ホスト時刻をローカル時刻へ変換するために使います。

jitter: offsetサンプルの揺れ幅です。同期が安定したかどうかの判定に使います。

state_snapshot: 新しく参加したクライアントへ、現在の再生状態、BPM、拍子、開始時刻を伝える制御メッセージです。
