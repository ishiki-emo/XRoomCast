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

Phase 2aで、サイン波による「両手を振りながら頭が揺れる」30Hzのポーズストリーム生成器を
ここに実装する(仕様書 §5 Phase 2a 参照)。
