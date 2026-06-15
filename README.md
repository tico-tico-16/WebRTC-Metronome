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

WebRTC接続には `stun:stun.l.google.com:19302` を使います。TURNサーバーは設定していないため、制約が厳しいネットワークなどでは接続できない場合があります。

サーバーの型定義はWrangler設定から生成します。`server/wrangler.jsonc` を変更した場合は、次を実行してください。

```bash
bun run --cwd server types
```

## Deploy

本番環境では、静的フロントエンドを Cloudflare Pages、WebRTCシグナリングサーバーを Cloudflare Workers + Durable Objects に分けてデプロイします。

- Frontend: Cloudflare Pages
- Signaling server: Cloudflare Workers + Durable Objects
- Production URL: https://metronome.tico-tico.com
