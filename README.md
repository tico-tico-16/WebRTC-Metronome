# P2P同期メトロノーム

Bun + TypeScript + WebRTC DataChannelで動く、同一Wi-Fi向けのP2P同期メトロノームです。
frontendはViteで画面配信、serverはCloudflare Workers + Durable ObjectsでWebRTCシグナリングだけを担当し、同期制御データはホストと参加者のブラウザ間で直接送ります。

https://metronome.tico-tico.com/host/

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

本番環境では、静的フロントエンドを Cloudflare Pages、WebRTCシグナリングサーバーを Cloudflare Workers + Durable Objects に分けてデプロイします。

- Frontend: Cloudflare Pages
- Signaling server: Cloudflare Workers + Durable Objects
- Production URL: https://metronome.tico-tico.com/host/
