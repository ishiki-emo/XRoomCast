// 中継アプリの画面。操作は preload の window.bridge を通して main プロセスへ頼む
const $ = (id) => document.getElementById(id);

const urlCard = $('url-card');
const urlInput = $('url-input');
const urlSave = $('url-save');
const urlError = $('url-error');
const urlCancel = $('url-cancel');
const startButton = $('start');
const stopButton = $('stop');
const consoleButton = $('open-console');
const changeUrl = $('change-url');
const logEl = $('log');

/** URL の欄を、変えるために開いているか(保存済みでも出す) */
let editingUrl = false;
let busy = false;

function setDot(id, kind) {
  $(id).className = `dot ${kind}`;
}

function render(state) {
  const { status } = state;
  urlCard.hidden = state.hasUrl && !editingUrl;
  urlCancel.hidden = !state.hasUrl;
  changeUrl.hidden = !state.hasUrl || editingUrl;

  // VMC の受信
  if (status.receiving) {
    setDot('vmc-dot', 'ok');
    $('vmc-title').textContent = 'VSeeFace などから受信中';
    $('vmc-detail').textContent = `${status.receivedPerSecond} 件/秒`;
  } else {
    setDot('vmc-dot', 'wait');
    $('vmc-title').textContent = 'VSeeFace などからの受信を待っています';
    $('vmc-detail').textContent = `VSeeFace の設定で「OSC/VMC プロトコル」の送信をオンにしてください(送信先 127.0.0.1、ポート ${state.vmcPort})`;
  }

  // 配信
  if (state.settingsError) {
    setDot('sfu-dot', 'error');
    $('sfu-title').textContent = '配信先に接続できません';
    $('sfu-detail').textContent = `${state.settingsError}(ルームが開いたら「配信を始める」を押してください)`;
  } else if (!state.hasUrl) {
    setDot('sfu-dot', 'off');
    $('sfu-title').textContent = '配信者URLを貼ってください';
    $('sfu-detail').textContent = '';
  } else if (status.sfu === 'live') {
    setDot('sfu-dot', 'ok');
    $('sfu-title').textContent = '配信中';
    const seat = status.slot !== null ? `・席 ${status.slot}` : '';
    $('sfu-detail').textContent = `ルーム ${state.room}${seat}(席の名前 ${state.pid})`;
  } else if (status.sfu === 'connecting') {
    setDot('sfu-dot', 'wait');
    $('sfu-title').textContent = '配信先に接続しています…';
    $('sfu-detail').textContent = state.room ? `ルーム ${state.room}` : '';
  } else {
    setDot('sfu-dot', 'off');
    $('sfu-title').textContent = '配信を止めています';
    $('sfu-detail').textContent = state.room ? `ルーム ${state.room}` : '';
  }

  const warnings = [];
  if (status.multipleSenders) {
    warnings.push('VMC の送り元が2つあります。動きが混ざって暴れるので、片方を止めてください');
  }
  if (status.registrationError) warnings.push(`配信先への登録に失敗しました: ${status.registrationError}`);
  $('warning').hidden = warnings.length === 0;
  $('warning').textContent = warnings.join(' / ');

  startButton.disabled = busy || !state.hasUrl || state.running;
  stopButton.disabled = busy || !state.running;
  consoleButton.disabled = !state.room;
}

async function refresh() {
  render(await window.bridge.state());
}

async function run(action) {
  busy = true;
  try {
    await action();
  } finally {
    busy = false;
    await refresh();
  }
}

urlSave.addEventListener('click', () =>
  run(async () => {
    const url = urlInput.value.trim();
    if (!url) return;
    urlSave.disabled = true;
    urlError.hidden = true;
    urlSave.textContent = '確かめています…';
    const result = await window.bridge.saveUrl(url);
    urlSave.disabled = false;
    urlSave.textContent = '保存して配信を始める';
    if (!result.ok) {
      urlError.textContent = result.error;
      urlError.hidden = false;
      return;
    }
    urlInput.value = '';
    editingUrl = false;
  }),
);
urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') urlSave.click();
});
urlCancel.addEventListener('click', () => {
  editingUrl = false;
  urlError.hidden = true;
  void refresh();
});
changeUrl.addEventListener('click', () => {
  editingUrl = true;
  void refresh();
  urlInput.focus();
});
startButton.addEventListener('click', () => run(() => window.bridge.start()));
stopButton.addEventListener('click', () => run(() => window.bridge.stop()));
consoleButton.addEventListener('click', () => window.bridge.openConsole());

function appendLog(line) {
  const nearBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 8;
  logEl.textContent += `${line}\n`;
  // 長くなりすぎないよう、古い行を落とす
  const lines = logEl.textContent.split('\n');
  if (lines.length > 300) logEl.textContent = lines.slice(-300).join('\n');
  if (nearBottom) logEl.scrollTop = logEl.scrollHeight;
}

window.bridge.onState((state) => render(state));
window.bridge.onLog(appendLog);
void window.bridge.logs().then((lines) => lines.forEach(appendLog));
void refresh();
