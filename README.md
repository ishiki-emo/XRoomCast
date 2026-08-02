# XRoomCast

VRMアバターの動きを**数KB/sのポーズデータ**として配信し、
視聴者がURLを開くだけでリアルタイムに見られるシステムです。

動画を流さずポーズだけを送るため、**帯域は動画配信の1/100以下**で済みます。

<img src="./docs/ar-demo.gif" alt="スマホのARで机の上にミニサイズのアバターを置き、配信中に衣装を切り替えている様子" width="240" align="right" />

## できること

**視聴する**

- ブラウザだけで見られます。PC / スマホ / HMD(Quest・PICO等)、インストール不要です
- AR/MRで現実の部屋にアバターを置けます。等身大でも1/10のミニサイズでも構いません
- 配信者の声がアバターの位置から聞こえます(空間オーディオ)
- 他の視聴者の気配が見えます(端末に応じてHMD・スマホ・PCの形で表示されます)
- 匿名でコメントを送れます

**配信する**

- VSeeFace等の**VMCトラッキング**(PC)か、**HMD単体**(VSeeFace不要)を選べます
- 配信中にアバターをアップロードして切り替えられます。視聴者全員へ自動で同期されます
- 配信者コンソールで、視聴者に届いている姿と視聴者の位置を確認できます
- ルームを分ければ、同時に複数の配信を立てられます

<br clear="right" />

上の映像は、スマホのARで机の上に1/10サイズのアバターを置き、
配信中に衣装を切り替えているところです。
奥のPC画面が先に切り替わってAR側が遅れて追いつくのは仕様どおりで、
**視聴者ごとにダウンロードが終わった時点で差し替わる**ためです。

[フル版の動画(28秒)](./docs/ar-demo-full.mp4)

## ローカルで試す

Cloudflareのアカウントは要りません。VRMファイルを1つ用意してください。

```sh
npm install
# apps/viewer/public/avatar.vrm にVRMを置く
npm run dev
```

ブラウザで開くとアバターが待機モーションで立ちます。
「デモ再生」ボタンでダミーモーションを流せば、全身の動きも確認できます。

VSeeFace等でモーションを流す場合は、別ターミナルで `npm run bridge` を起動します。

## インターネットに公開する

Cloudflare上で動かします。必要なものは以下のとおりです。

| | 用途 |
|---|---|
| Cloudflareアカウント | R2を使うためクレジットカード登録が必要です |
| Workers | ビューアの配信とAPI |
| Realtime (SFU) | モーションと音声の中継 |
| R2 | VRMファイルの保管 |
| KV / Durable Objects | 配信状態・同接・コメント・視聴者の位置 |

**手順は [SETUP.md](./SETUP.md) にまとめてあります。**

> セルフホストの場合、**Cloudflareの請求はご自身に届きます。**
> 視聴URLが流出すると視聴者数とともに課金が伸びるため、
> 支出上限アラートの設定をおすすめします。

## ドキュメント

| | 内容 |
|---|---|
| [SETUP.md](./SETUP.md) | 動かすまでの手順。ローカル・公開・配信・トラブル対応 |
| [docs/実装メモ.md](./docs/実装メモ.md) | 実装の詳細と、そうしている理由 |
| [実装仕様書.md](./実装仕様書.md) | 初期の設計方針(現在の実装はこれより先行しています) |

## 動作環境

| | 対応 |
|---|---|
| PC / Android | 視聴・AR ともに対応しています |
| iPhone / iPad | 視聴は対応。ARは [EyeJack X](https://play.eyejack.xyz/) 経由で表示できます |
| Quest / PICO 等のHMD | 視聴・AR/VR・**HMD単体での配信**に対応しています |
| 配信側(VMC) | VSeeFace, VMagicMirror など。Node.js 22以降が必要です |

## ライセンス

**現在検討中です。** 詳細は [LICENSE](./LICENSE) をご覧ください。

現時点では、閲覧・学習を目的とした参照以外の利用(複製・改変・再配布・商用利用)を
許諾していません。ご利用をご希望の場合は X のDM([@ishiki_emo](https://x.com/ishiki_emo))
までご連絡ください。

### 使用している主なオープンソース

いずれも各自のライセンスに従います(本リポジトリのライセンスとは別です)。

| パッケージ | ライセンス | 用途 |
|---|---|---|
| [three.js](https://github.com/mrdoob/three.js) | MIT | 3D描画・WebXR |
| [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) | MIT | VRMの読み込み・表情・揺れもの |
| [ws](https://github.com/websockets/ws) | MIT | ブリッジのWebSocketサーバー |
| [osc-min](https://github.com/russellmcc/node-osc-min) | Zlib | VMC(OSC)のパース |
| [node-datachannel](https://github.com/murat-dogan/node-datachannel) | MPL-2.0 | ブリッジのWebRTC |
| [Vite](https://vitejs.dev/) / [TypeScript](https://www.typescriptlang.org/) / [Wrangler](https://developers.cloudflare.com/workers/wrangler/) | MIT / Apache-2.0 / MIT | ビルド・デプロイ |

## 作者

癒色えも (ISHIKI Emo) — [X (Twitter) @ishiki_emo](https://x.com/ishiki_emo)
