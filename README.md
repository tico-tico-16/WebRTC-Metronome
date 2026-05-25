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
- Participant: ホスト画面で部屋を作成した後に表示されるURL/QRコード
- Signaling: ws://localhost:3001/ws

同じWi-Fi内のスマホから参加する場合は、ホスト画面に表示される部屋専用URLまたはQRコードを使います。
