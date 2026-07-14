# fixtures

テスト用のダミーモーションデータと、テスト用VRMの取得手順のメモ置き場。

## テスト用VRMについて

VRMファイルは**リポジトリにコミットしない**(ライセンス・容量の観点)。
開発者が自身のVRMを `apps/viewer/public/` に置いて使う。

- 現在の想定ファイル名: `apps/viewer/public/Emo.vrm`(VRM 0.x)
- VRM 1.0の確認用に、公式サンプルの
  [Seed-san](https://github.com/vrm-c/vrm-specification/tree/master/samples/Seed-san)
  を `apps/viewer/public/Seed-san.vrm` として配置済み(こちらもコミット対象外)。
  消してしまった場合は上記URLの `vrm/Seed-san.vrm` を再取得する。
- 表示するモデルを切り替えるには `apps/viewer/src/main.ts` の `VRM_PATH` を変更する
  (Phase 1でURL指定の動的ロードに置き換わる予定)。

## ダミーモーションデータ

Phase 2aで、サイン波による「両手を振りながら頭が揺れる」30Hzのポーズストリーム生成器を
ここに実装する(仕様書 §5 Phase 2a 参照)。
