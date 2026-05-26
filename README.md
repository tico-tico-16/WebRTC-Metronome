# P2P同期メトロノーム

Bun + TypeScript + WebRTC DataChannelで動く、同一Wi-Fi向けのP2P同期メトロノームです。
frontendはViteで画面配信、serverはWebRTCシグナリングだけを担当し、同期制御データはホストと参加者のブラウザ間で直接送ります。

## Structure

- `frontend/`: ホスト画面と参加者画面のブラウザコード、Vite配信
- `server/`: WebSocketシグナリングサーバー
- `shared/`: frontend/serverで共有するプロトコル型

将来的には、`frontend/` をCloudflare Pages、`server/` をCloudflare Workers + Durable Objectへ分ける想定です。

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
- Signaling: ws://localhost:3001/ws

同じWi-Fi内のスマホから参加する場合は、ホスト画面に表示される部屋専用URLまたはQRコードを使います。
