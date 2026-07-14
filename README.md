# VRMSyncWeb — Web VRMアバター配信ビューア

VSeeFaceのトラッキングをポーズデータ(数KB/s)としてWebブラウザへストリーミングし、
視聴者がURLを開くだけでVRMアバターの動きをリアルタイムに観られるシステムのプロトタイプ。
詳細は [実装仕様書.md](./実装仕様書.md) を参照。

## リポジトリ構成

```
apps/viewer/       Webビューア(Vite + TypeScript + Three.js + @pixiv/three-vrm)
apps/bridge/       VMC受信 → シリアライズ → WS/SFU送出(Node)※Phase 2b で作成
packages/protocol/ パケットのエンコード/デコード共有ライブラリ ※Phase 2a で作成
fixtures/          ダミーモーションデータ、テスト用VRMの取得手順メモ
```

## セットアップ

```sh
npm install
```

VRMファイルをリポジトリにはコミットしないため、各自で用意して
`apps/viewer/public/Emo.vrm` として配置する(`fixtures/README.md` 参照)。

## Phase 0: 静的VRM表示

```sh
npm run dev
```

ターミナルに表示されたURL(既定は http://localhost:5173 。使用中なら自動で別ポートになる)を
ブラウザで開くと、`apps/viewer/public/Emo.vrm` がTポーズで表示される。マウスドラッグで回転、ホイールでズーム、右ドラッグでパン。

## Phase 1: 動的VRMロード

VRMを実行時にロードできる。

- **URLクエリ**: `http://localhost:5173/?vrm=<URLエンコードしたVRMのURL>`
- **画面上のUI**: 左上の入力欄にURLを入れて「ロード」(Enterでも可)

ロード中はバイト数ベースのプログレスを表示し、失敗時(404 / CORSエラー / 非VRMファイル)は
エラーメッセージを表示して直前のモデルの表示を維持する。差し替え時は旧モデルを
`VRMUtils.deepDispose` で破棄するため、繰り返し差し替えてもメモリは増加しない。

別オリジンからロードする場合の注意:

- 配信元がCORSを許可している必要がある。ローカルで試す場合の例:
  `npx http-server apps/viewer/public -p 8081 --cors`
  → `http://localhost:8081/Seed-san.vrm` を入力欄に指定
- **Cloudflare R2で配信する場合は、バケットにCORSルール(`GET` メソッド、対象Origin)の
  設定が必要**。設定がないとブラウザがフェッチをブロックする。

将来のDL抑制(署名付きURL+暗号化配信)を見据えて、ローダーの入口
(`loadVRM`)はURLと `ArrayBuffer` の両方を受け付ける。

## Phase 2a: ダミーモーション適用(通信なし)

- `packages/protocol` — パケット仕様(仕様書§6)のエンコード/デコード共有ライブラリ。
  `npm test` でラウンドトリップ単体テストを実行。
- `fixtures` — ダミーモーション生成器(サイン波で「両手を振りながら頭が揺れる」30Hz)。
  `npm run generate:motion` で `fixtures/dummy-motion.bin`(§6形式・タイムスタンプ付き)を
  生成・デコード検証する。ペイロードは約3KB/s。
- ビューアの「デモ再生」ボタンでダミーストリームを実時間再生する。パケットは実経路と
  同じくエンコード→デコードを通り、以下のパイプラインでアバターへ適用される:
  1. ジッタバッファ(目標遅延100ms、位置lerp・回転slerp)
  2. 頭回転の適用+頭位置差分によるhipsルートモーション
  3. 足の接地固定IK(レスト時の足首位置に2ボーンIKで固定。ルートモーションは膝で
     吸収するため足が滑らない。hipsがレストより高く上がった場合のみ足が浮く)
  4. 手首目標への2ボーンIK(自前実装、肘ポールは体側やや後方・下方)
  5. 表情(辞書パケットで表情ID→名前を解決、未受信IDは無視)
  6. 指カール値の3関節展開+スプレッド
- 「パケット10%ドロップ」チェックで欠落シミュレーションができる(補間で破綻しないことの確認用)。

実装メモ: `VRMUtils.rotateVRM0` はVRM 0.xの `vrm.scene` をY軸180°回転させるため、
正規化ボーンのローカル系とワールド系が0.xと1.0で一致しない。ワールド系の値を
ローカルへ持ち込む箇所は必ずリグのワールド回転(`PoseApplier` の `rootQuat`)で
変換すること(怠るとルートモーションが毎フレーム発散する)。

## Phase 2b: VMC実経路(ローカルWebSocket)

VSeeFace → ブリッジ → ブラウザの実経路。

```sh
# ターミナル1: ブリッジ(VMC受信→§6シリアライズ→WS配信)
npm run bridge     # 既定: VMC_PORT=39539, WS_PORT=8080(環境変数で変更可)

# ターミナル2: ビューア
npm run dev
```

ブラウザで左上の「ws://localhost:8080」欄の **接続** を押すと追従が始まる。

### VSeeFace側の設定

1. VSeeFaceでアバターを選び、Webcamトラッキングを開始する
2. **設定(General settings)→「OSC/VMC protocol」の送信(Send data with OSC/VMC protocol)を有効化**
3. 送信先: IP `127.0.0.1`(ブリッジが別マシンならそのIP)、**ポート `39539`**
4. ブリッジのコンソールに毎秒 `[stats] 受信 ... msg/s` が出れば受信できている

### VSeeFaceなしで動作確認する場合

VMCシミュレータ(両手振り+頭揺れ+表情+指の開閉を60Hzで送信)を同梱している:

```sh
npm run sim                                        # 手振りモード
npm run sim --workspace apps/bridge -- right       # 右手だけ挙げる(§7鏡像確認用)
```

### 実装のポイント

- VMCの `/VMC/Ext/Bone/Pos` は**親ボーン相対のローカル姿勢**で届くため、ブリッジで
  HipsからFK合成してHead/両手首のルート空間姿勢を求めてから§7変換して送出する
- ボーン状態は `/VMC/Ext/T`(フレーム区切り)で一括反映する(複数UDPパケットに
  分かれて届くボーン群を受信途中でFK合成すると、新旧フレーム混成の破綻ポーズになる)
- 1tickで0.4m以上跳ぶ位置はスパイクフィルタで抑制(3tick継続で本物として受理)。
  トラッキングの一瞬の誤検出がそのまま中継されるのを防ぐ
- **複数のVMC送信元**(例: VSeeFaceとシミュレータの同時送信)を検出すると警告ログを
  出す。混線するとポーズが交互に上書きされて暴れるので、必ずどちらかを止めること
- 表情名はVRM 0.x名(Joy等)をVRM 1.0名(happy等)へブリッジで正規化する
- 送信レートはポーズ30Hz/表情・手指15Hz。WindowsのsetIntervalは分解能が粗い
  (約15.6ms)ため、絶対時刻基準のスケジューリングで30Hzを維持している
- ビューアは切断時に指数バックオフ(0.5s→最大8s)で自動再接続する。ブリッジ再起動で
  タイムスタンプが不連続になった場合はジッタバッファを仕切り直して再生を続行する
- トランスポートは `Transport` インターフェース(`apps/viewer/src/transport.ts`)で
  抽象化済み。Phase 2cでSFU実装に差し替える

## Phase 2c: Cloudflare Realtime SFU

WebSocketの代わりにCloudflare Realtime SFUのDataChannel(一方向:
publisher→subscribers)で配信する。別ネットワークのマシン・スマホや
複数ブラウザからの同時視聴が可能になる。

### セットアップ

1. [Cloudflareダッシュボード](https://dash.cloudflare.com/) → Realtime → Create App
2. リポジトリルートに `.env` を作成(`.env.example` 参照):

```
CF_REALTIME_APP_ID=<App ID>
CF_REALTIME_APP_SECRET=<App Secret>
```

**App Secretはブリッジ(Node)だけが読む。** ビューアのセッション作成は
ブリッジのプロキシAPI(`/api/sfu/*`)経由で行うため、Secretがブラウザへ
渡ることはない。

### 使い方

`npm run bridge` 起動時に `.env` があればブリッジがパブリッシャーセッションを
自動確立する(ログに `[sfu] パブリッシャー接続完了` が出る)。ビューア左上の
セレクタで **SFU** を選び、接続先にブリッジのHTTP URL(既定
`http://localhost:8080`)を入れて接続する。WebSocketとSFUはセレクタで
いつでも切り替えられる(受け入れ条件のフラグ)。

別マシン・スマホから視聴する場合:

```sh
npm run dev -- -- --host   # ビューアをLANに公開
```

スマホのブラウザで `http://<PCのIP>:5173` を開き、SFUの接続先に
`http://<PCのIP>:8080` を指定する(ポーズデータ自体はCloudflare経由なので、
ブリッジAPIに届きさえすればよい)。

### 実装のポイント

- 手順は公式 `cloudflare/realtime-examples` の echo-datachannels に準拠
  (sessions/new でSDP交換 → datachannels/new で negotiated ID取得 →
  `createDataChannel(name, { negotiated: true, id })`)
- ブリッジ側のWebRTCは `node-datachannel` のWebRTCポリフィルを使用
- 辞書と表情全量は5秒間隔で定期再送する(§6.5。SFUは一方向で
  途中参加者に接続時送信ができないため)

## ビューアの公開(Cloudflare Workers 静的アセット)

```sh
npx wrangler login        # 初回のみ(+ workers.devサブドメインの登録が必要)
npm run deploy:viewer     # ビルド → distからVRM除去 → デプロイ
```

公開URL: https://vrmsync-viewer.ishiki-emo.workers.dev

- **VRMファイルはデプロイに含めない**(ライセンス・DL抑制の方針+25MB上限)。
  公開ページでは `?vrm=<CORS許可済みURL>` か入力欄でVRMを指定する
- **SFUプロキシはWorker自身が持つ**(`/api/sfu/*`)ため、公開視聴に
  トンネルは不要。ブリッジはSFU接続時に自分のセッションIDをWorkerへ登録し
  (`BRIDGE_TOKEN` によるBearer認証+5分ハートビート)、WorkerがKV経由で
  サブスクライバーへ案内する。必要なWorker secret:

```sh
npx wrangler secret put CF_REALTIME_APP_ID     # Realtime App ID
npx wrangler secret put CF_REALTIME_APP_SECRET # Realtime App Secret
npx wrangler secret put BRIDGE_TOKEN           # ブリッジ登録用(ランダム文字列)
```

ブリッジ側の `.env` にも `BRIDGE_TOKEN=<同じ値>` と
`VIEWER_ORIGIN=https://vrmsync-viewer.ishiki-emo.workers.dev` を書く。
KVネームスペース(`SFU_STATE`)は `wrangler kv namespace create SFU_STATE` で
作成し、IDを `wrangler.jsonc` に設定する。

`cloudflared tunnel --url http://localhost:8080` によるブリッジの直接公開は
Worker登録を使わない場合の代替手段として残る(WS視聴をインターネットへ
出したい場合もこちら)。

カスタムドメイン(例: stream.ishiki-emo.com)を使う場合は、ドメインのDNSを
Cloudflareへ移管したうえで `apps/viewer/wrangler.jsonc` に
`"routes": [{ "pattern": "stream.ishiki-emo.com", "custom_domain": true }]`
を追加して再デプロイする。

### VRMのR2ホスティング(トークン付き同一オリジン配信)

公開ページで使うVRMは**R2の非公開バケット**に置き、ビューアWorker自身が
`/vrm/<キー>?k=<トークン>` で配信する(`apps/viewer/worker/index.ts`)。
バケットは非公開のまま・同一オリジンなのでCORS不要・URLは恒久。

```sh
npx wrangler r2 bucket create vrmsync-assets                     # 初回のみ
npx wrangler r2 object put vrmsync-assets/Emo.vrm --file <path> --remote
npx wrangler secret put VRM_TOKEN                                # 配信トークン(照合用)
```

- トークン不一致・未指定は403。トークンをローテートすれば出回ったリンクは無効化できる
- ワンリンク共有の組み立て(**固定リンク**。`<>`を実値に置換):

```
https://vrmsync-viewer.ishiki-emo.workers.dev/?vrm=<urlencode(/vrm/Emo.vrm?k=トークン)>&transport=sfu
```

SFUプロキシが同一オリジンにあるため `server=` は不要。配信の手順は
「VSeeFace起動 → `npm run bridge`」だけで、リンクは毎回同じものが使える。

### 視聴用の短縮URL(/watch/<キー>)

長いパラメータ付きURLの代わりに、`/watch/<WATCH_KEY>` を開くだけで
視聴パラメータ(既定VRM+トークン+SFU自動接続)へリダイレクトされる。
組み立てはWorkerが行うため、共有するのは短いURL1つでよい。

```sh
npx wrangler secret put WATCH_KEY   # 視聴キー(ランダム文字列)
```

- 既定VRMは `wrangler.jsonc` の `vars.DEFAULT_VRM_KEY`(R2のキー名)で変更
- キー不一致は404。WATCH_KEYをローテートすれば出回った視聴URLだけを
  無効化できる(VRM_TOKENとは独立)

### 視聴ページ(?watch=1)と同接カウント

`/watch/<キー>` 経由はタイトル+説明つきの視聴専用レイアウト
(16:9ステージ、操作UI非表示)になり、ステージ下に受信統計
(KB/s・pkt/s・累計・fps)と**同時視聴者数**を表示する。

ポーズパケットが5秒途絶えると「⏸ 配信は停止中です」オーバーレイを表示し、
再開すると自動で消える。対になる挙動として、**ブリッジはトラッキング元
(VSeeFace)からのボーン受信が2秒途絶えたら送信を止める**(止めないと
最後のポーズを送り続けてしまい、視聴側で停止を検知できない)。

同接はWorkerの**Durable Object(`Presence`)**が数える。視聴ページが
`/api/presence` へWebSocket接続し、DOが開いているソケット数を増減のたびに
全員へブロードキャストする(ハイバネーションAPI使用でアイドルコストほぼゼロ。
単一ルーム。部屋分けはPhase 3の部屋管理で拡張する)。

### 音声配信(配信者コンソール)

`/broadcast/<BROADCAST_KEY>` を開き「マイク配信を開始」を押すと、マイクが
Opus音声トラックとしてSFUへパブリッシュされ、視聴ページで再生できる
(ページを開いている間だけ配信)。

```sh
npx wrangler secret put BROADCAST_KEY   # 配信者キー(ランダム文字列)
```

- 手順は cloudflare/calls-examples の echo に準拠(空セッション作成 →
  `tracks/new` でSDP交換・トラック公開。購読側は同じPeerConnectionへ
  `tracks/new`(remote)+ renegotiate で追加)
- 音声セッションIDはKVで共有(ポーズのパブリッシャー登録と同じ方式。
  4分ハートビート+ページ閉鎖時はsendBeaconで解除)
- トラックの公開(location: local)はBROADCAST_KEY必須。視聴(remote)は不要
- 視聴ページは音声トラックを受信するとステージ右上に「🔇 タップで音声ON」を
  表示する(ブラウザの自動再生制限のため、ミュート解除には操作が必要)
- 帯域は音声約6〜8KB/s/人(Opus)。ポーズと合わせても動画の1/100以下

### 匿名コメント

同じWebSocket(Presence DO)でコメントも送受信する。

- 送信: ステージ下の入力欄(匿名・アカウントなし)。200文字まで、
  ソケット単位で1秒1回のレート制限
- 表示: ステージ左下のオーバーレイに積み上がる(最新10件、textContentで
  挿入するためHTMLは無害化される)
- 直近50件をDOストレージに保存し、途中参加者にも履歴を表示する

- これは「カジュアルなDL防止」であって完全防止ではない(視聴できる人は
  原理的に取得もできる)。本気の抑制は署名付き期限トークン+メモリ上復号
  (Phase 3以降)で強化する
- ブリッジの `/vrm/` ルート(トンネル経由配信)はLAN・開発用として残してある
