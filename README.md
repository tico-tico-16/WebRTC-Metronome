# P2P同期メトロノーム

Bun + TypeScript + WebRTC DataChannelで動く、同一Wi-Fi向けのP2P同期メトロノームです。
サーバはページ配信とWebRTCシグナリングだけを担当し、同期制御データはホストと参加者のブラウザ間で直接送ります。

## Setup

```bash
bun install
```

## Run

```bash
bun run dev
```

- Host: http://localhost:3001
- Participant: http://localhost:3000
- Signaling: ws://localhost:3001/ws

同じWi-Fi内のスマホから参加する場合は、PCのIPアドレスを使って `http://<PCのIP>:3000` を開きます。
