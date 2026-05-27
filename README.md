# P2P同期メトロノーム

Bun + TypeScript + WebRTC DataChannelで動く、同一Wi-Fi向けのP2P同期メトロノームです。
frontendはViteで画面配信、serverはCloudflare Workers + Durable ObjectsでWebRTCシグナリングだけを担当し、同期制御データはホストと参加者のブラウザ間で直接送ります。

(https://metronome.tico-tico.com/host/)

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

サーバーの型定義はWrangler設定から生成します。`server/wrangler.jsonc` を変更した場合は、次を実行してください。

```bash
bun run --cwd server types
```

## Deploy

このプロジェクトは、静的フロントエンドをCloudflare Pages、WebRTCシグナリングをCloudflare Workers + Durable Objectsに分けてデプロイします。

### 1. Workerを先にデプロイ

```bash
bun run deploy:server
```

デプロイ後に発行されるWorker URLを控えてください。例:

```text
https://p2pmetronome-signaling.<your-subdomain>.workers.dev
```

WebSocketの接続先は、このURLの `https:` を `wss:` に変え、末尾に `/ws` を付けた値です。

```text
wss://p2pmetronome-signaling.<your-subdomain>.workers.dev/ws
```

### 2. Cloudflare Pagesを設定

Cloudflare PagesでGitHubリポジトリを接続し、次の設定にします。

```text
Root directory: frontend
Build command: bun run build
Build output directory: dist
Production branch: main
```

Pagesの環境変数に、WorkerのWebSocket URLを設定します。

```text
VITE_SIGNALING_BASE_URL=wss://p2pmetronome-signaling.<your-subdomain>.workers.dev/ws
```

ローカルでPages相当のビルドだけ確認する場合は、`frontend/.env.example` を参考に `frontend/.env.local` を作り、次を実行します。

```bash
bun run build:frontend
```

### 3. GitHub push連携

- Frontend: Cloudflare Pages Git integrationで `main` へのpush時に自動デプロイします。
- Worker: Cloudflare Workers Buildsで同じGitHubリポジトリを接続し、`server` をRoot directoryとして自動デプロイします。
- Worker側のDeploy commandは次を使います。

```bash
bunx wrangler deploy --config wrangler.jsonc
```

### 4. 本番確認

- Pagesの `/host/` を開き、部屋を作成できること。
- 参加URL/QRコードがPagesのURLを指すこと。
- ブラウザのNetworkでWebSocket接続先が `wss://.../ws/host` または `wss://.../ws/client?room=...` になること。
- スマホなど別端末から `/client/?room=...` に入り、Start/Stopと同期表示が動くこと。
