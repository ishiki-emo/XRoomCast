// デプロイ前に dist/ からVRMファイルを取り除く。
// VRMは公開配布しない方針(ライセンス・DL抑制)かつ、25MB超のファイルは
// Workers静的アセットの上限にかかるため。
import { readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist', import.meta.url));
for (const name of readdirSync(dist)) {
  if (name.toLowerCase().endsWith('.vrm')) {
    rmSync(`${dist}/${name}`);
    console.log(`removed from dist: ${name}`);
  }
}
