/**
 * 配信者コンソール(ブラウザ)を、中継アプリの席の名前を入れて開く。
 *
 * マイクとアバターの設定はブラウザの配信者コンソールで行い、コンソールは「配信者名」(pid)で自分の席を探す。
 * 中継アプリの席の名前は自動で作る(pc-…)ので、そのままではコンソールの既定の名前(default)と合わず、
 * 2人目以降は声とアバター設定が別の席へずれる。コンソールは URL の ?pid= を配信者名として読むので、
 * それを付けて開けば、声もアバターも自動で中継アプリと同じ席になる。
 * 短縮URL(/broadcast/…)は飛ばすときにクエリを引き継がないので、飛び先の broadcast.html を直接開く
 */
import { execFile } from 'node:child_process';
import type { WorkerSettings } from './settings.js';

export function consoleUrl(settings: WorkerSettings): string {
  const url = new URL('/broadcast.html', settings.origin);
  url.searchParams.set('key', settings.key);
  url.searchParams.set('room', settings.room);
  url.searchParams.set('pid', settings.pid);
  return url.href;
}

/** 既定のブラウザで開く(シェルを通さない。URL の & がコマンドの区切りに取られないように) */
function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  execFile(command, args, (error) => {
    if (error) console.warn('[コンソール] ブラウザを開けませんでした:', error.message);
  });
}

/** 窓で Enter を押すたびに配信者コンソールを開く(窓から入力できるときだけ) */
export function offerConsole(settings: WorkerSettings): void {
  if (!process.stdin.isTTY) return;
  const url = consoleUrl(settings);
  console.log(
    '[コンソール] Enter を押すと、マイクとアバターを設定する配信者コンソールをブラウザで開きます' +
      `(席の名前「${settings.pid}」が入った状態で開くので、声とアバターがこの配信と同じ席になります)`,
  );
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', () => {
    openInBrowser(url);
    console.log('[コンソール] ブラウザで開きました');
  });
  process.stdin.resume();
}
