# fixtures

テスト用のダミーモーションデータと、テスト用VRMの取得手順のメモ置き場。

## テスト用VRMについて

VRMファイルは**リポジトリにコミットしない**(ライセンス・容量の観点)。
開発者が自身のVRMを `apps/viewer/public/` に置いて使う。

- 既定のファイル名: `apps/viewer/public/avatar.vrm`
  (`apps/viewer/src/config.ts` の `DEFAULT_VRM_PATH`)
- VRM 1.0の確認用には、公式サンプルの
  [Seed-san](https://github.com/vrm-c/vrm-specification/tree/master/samples/Seed-san)
  が使える。`vrm/Seed-san.vrm` を取得して `apps/viewer/public/` に置く
- 別のモデルを表示するときは、ファイルを置き換えるか
  `?vrm=<VRMのURL>` で指定する(ページ上の入力欄からも読み込める)

## ダミーモーションデータ

サイン波による「両手を振りながら頭が揺れる」30Hzのポーズストリーム生成器
(`src/dummyMotion.ts`)。`npm run generate:motion` で `dummy-motion.bin` を生成・
デコード検証する。ビューアの「デモ再生」ボタンはこのストリームを実時間再生している。
