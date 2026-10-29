# P2P同期メトロノーム

Bun + TypeScript + WebRTC DataChannelで動く、P2P同期メトロノームです。無料公開STUNサーバーで一部のNAT越えを試行しますが、TURNサーバーは使わないため接続できないネットワークがあります。
frontendはViteで画面配信、serverはCloudflare Workers + Durable ObjectsでWebRTCシグナリングだけを担当し、同期制御データはホストと参加者のブラウザ間で直接送ります。

https://metronome.tico-tico.com

## Structure

- `frontend/`: ホスト画面と参加者画面のブラウザコード、Vite配信
- `server/`: Wranglerで起動するCloudflare Workers + Durable ObjectsのWebSocketシグナリングサーバー
- `shared/`: frontend/serverで共有するプロトコル型

## Setup

```bash
bun install
```

## Run

```bash
bun run dev
```

- Host: http://localhost:3000/host/
- Participant: ホスト画面で部屋を作成した後に表示されるURL/QRコード
- Signaling: ws://localhost:3001/ws/host または ws://localhost:3001/ws/client?room=<roomId>

同じWi-Fi内のスマホから参加する場合は、ホスト画面も `http://<LAN IP>:3000/host/` で開いてください。ホスト画面に表示される部屋専用URLまたはQRコードも同じLAN IPになります。

シグナリングサーバーは許可したOriginの画面からのWebSocket接続だけを受け付けますが、`localhost`・`127.0.0.1`・`[::1]` とプライベートLANのIPv4アドレス（10.x、172.16〜31.x、192.168.x）のOriginは設定なしで受け付けるため、開発時はそのまま使えます。

WebRTC接続には `stun:stun.l.google.com:19302` を使います。TURNサーバーは設定していないため、制約が厳しいネットワークなどでは接続できない場合があります。

サーバーの型定義はWrangler設定から生成します。`server/wrangler.jsonc` を変更した場合は、次を実行してください。

```bash
bun run --cwd server types
```

## Test

```bash
bun run test
bun run typecheck
bun run build:frontend
```

Bun標準のテストランナーで、ホスト・参加者の音声スケジューラの回帰テスト、共通エンジンのテスト、入力値の正規化と画面表示の判定、拍表示の多角形の計算のテストを実行します。時計・タイマー・音声・振動APIをモック化しており、ブラウザや実時間の待機は不要です。追加ライブラリは使用しません。

各リファクタリングの前に対象部分のテストを追加し、変更後は蓄積した全テストと型チェック・ビルドを実行します。スケジューラの共通化では、既存の公開APIに対するテストを先に追加し、同じ期待値で変更後の挙動を確認しています。

同じチェックはGitHub Actions（[`.github/workflows/ci.yml`](./.github/workflows/ci.yml)）で、`main` へのpushとすべてのプルリクエストごとに自動実行します。CIではあわせて、`bun.lock` を更新せずに依存関係をインストールできること（`bun install --frozen-lockfile`）と、Cloudflareへはデプロイしない `wrangler deploy --dry-run` でWorkerをビルドできることも確認します。dry runに認証情報は不要で、ローカルでは次で確認できます。

```bash
bun run --cwd server wrangler deploy --dry-run --config wrangler.jsonc
```

ブラウザでの確認は `bun run dev` で起動し、ホストと参加者の画面で音声有効化、再生・停止、BPM・拍子変更、途中参加、発声補正、ホストの参加者ダイアログ（参加者ボタンの状態と招待）を確認してください。PC幅とスマホ幅の両方で、表示が崩れたり要素が動いたりしないことも確認してください。実際の音響同期と振動モーターの動作には実端末での確認が必要です。構成と既知の課題は [ARCHITECTURE.md](./ARCHITECTURE.md) を参照してください。

音声を有効にしたあとに画面ロックや着信で音が止まった場合に、ページの再表示や画面のタップで再開できることも確認してください。

## Deploy

本番環境では、静的フロントエンドを Cloudflare Pages、WebRTCシグナリングサーバーを Cloudflare Workers + Durable Objects に分けてデプロイします。

- Frontend: Cloudflare Pages
- Signaling server: Cloudflare Workers + Durable Objects
- Production URL: https://metronome.tico-tico.com

シグナリングサーバーの設定は `server/wrangler.jsonc` の `vars` にあります。

- `ALLOWED_ORIGINS`: WebSocket接続を許可するフロントエンドのOrigin（カンマ区切り）。フロントエンドを別のドメインにも置く場合は追加してください。先頭のOriginは、参加者URLの組み立てでOriginが分からない場合の既定値にも使います。
- `MAX_PARTICIPANTS`: 1部屋の参加者数の上限（ホストを除く、既定50）。

変更した場合は `bun run --cwd server types` で型定義を再生成してください。
