// セットアップウィザードの画面制御。状態はすべてサーバー(/api/*)が持ち、
// ここは表示とポーリングだけを行う。
const $ = (id) => document.getElementById(id);

const state = {
  loggedIn: false,
  accountChosen: false,
  realtimeOk: false,
  foreign: false,
};

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = `status ${kind ?? ''}`;
}

function showStep(id, done = false) {
  const el = $(id);
  el.hidden = false;
  el.classList.toggle('completed', done);
}

function refreshSteps() {
  showStep('step-login', state.loggedIn && state.accountChosen);
  if (state.loggedIn && state.accountChosen) showStep('step-realtime', state.realtimeOk);
  if (state.realtimeOk) showStep('step-vrm');
  if (state.realtimeOk) showStep('step-run');
}

async function api(path, options) {
  const res = await fetch(path, options);
  return res.json();
}

// ---- 初期状態の反映 ----

async function loadState() {
  const s = await api('/api/state');
  state.loggedIn = s.login.loggedIn;
  state.realtimeOk = s.realtimeOk;
  state.foreign = s.existing.foreign;

  // アカウント選択(複数のときだけ出す)
  const accounts = s.login.accounts ?? [];
  if (s.accountId || accounts.length <= 1) {
    state.accountChosen = state.loggedIn;
    if (!s.accountId && accounts.length === 1) {
      await api('/api/account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: accounts[0].id }),
      });
    }
  } else {
    $('account-pick').hidden = false;
    const sel = $('account-select');
    sel.innerHTML = '';
    for (const a of accounts) {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = `${a.name} (${a.id.slice(0, 8)}…)`;
      sel.appendChild(opt);
    }
  }

  if (state.loggedIn) {
    setStatus($('login-status'), 'ログイン済みです', 'ok');
    $('login-btn').disabled = true;
  }

  // 既存セットアップの案内
  if (s.existing.hasKeys && s.existing.urls) {
    $('existing').hidden = false;
    $('existing-urls').innerHTML = `
      <div class="url-row"><span>視聴URL</span><code>${s.existing.urls.watch}</code></div>
      <div class="url-row"><span>配信者URL</span><code>${s.existing.urls.broadcast}</code></div>`;
  }
  if (s.existing.foreign) $('foreign').hidden = false;

  if (s.vrm) setStatus($('vrm-status'), `${s.vrm.name}(${(s.vrm.size / 1024 / 1024).toFixed(1)}MB)を受け取りました`, 'ok');

  refreshSteps();
}

// ---- STEP 1: ログイン ----

let loginTimer = null;
$('login-btn').addEventListener('click', async () => {
  await api('/api/login/start', { method: 'POST' });
  setStatus($('login-status'), 'ブラウザの認証タブで「Allow」を押してください…(完了を自動で検知します)', 'busy');
  $('login-btn').disabled = true;
  loginTimer = setInterval(async () => {
    const s = await api('/api/state');
    if (s.login.loggedIn) {
      clearInterval(loginTimer);
      await loadState();
    }
  }, 2500);
});

$('account-btn').addEventListener('click', async () => {
  await api('/api/account', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: $('account-select').value }),
  });
  state.accountChosen = true;
  $('account-pick').hidden = true;
  refreshSteps();
});

// ---- STEP 2: Realtime App ----

$('rt-btn').addEventListener('click', async () => {
  setStatus($('rt-status'), '確認しています…', 'busy');
  $('rt-btn').disabled = true;
  const result = await api('/api/realtime', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: $('rt-appid').value, secret: $('rt-secret').value }),
  });
  $('rt-btn').disabled = false;
  if (result.ok) {
    setStatus($('rt-status'), '確認できました', 'ok');
    state.realtimeOk = true;
    refreshSteps();
  } else {
    setStatus($('rt-status'), result.reason ?? '確認に失敗しました', 'ng');
  }
});

// ---- STEP 3: VRM ----

$('vrm-file').addEventListener('change', async () => {
  const file = $('vrm-file').files[0];
  if (!file) return;
  if (file.size > 80 * 1024 * 1024) {
    setStatus($('vrm-status'), 'このファイルは80MBを超えています。軽量化してから選んでください', 'ng');
    return;
  }
  setStatus($('vrm-status'), 'アップロード中…', 'busy');
  const result = await api(`/api/vrm?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    body: file,
  });
  if (result.ok) {
    setStatus($('vrm-status'), `${result.name}(${(result.size / 1024 / 1024).toFixed(1)}MB)を受け取りました`, 'ok');
  } else {
    setStatus($('vrm-status'), result.reason ?? '受け取りに失敗しました', 'ng');
  }
});

$('vrm-skip').addEventListener('click', () => {
  setStatus($('vrm-status'), 'VRMなしで進みます(後で配信者コンソールから追加できます)', '');
  $('step-run').scrollIntoView({ behavior: 'smooth' });
});

// ---- STEP 4: 実行 ----

let jobTimer = null;
let logCount = 0;

$('run-btn').addEventListener('click', async () => {
  if (state.foreign && !$('foreign-ok').checked) {
    alert('既存の設定を上書きしてよい場合は、上部の確認チェックを入れてください。');
    return;
  }
  const result = await api('/api/run', { method: 'POST' });
  if (!result.ok) {
    alert(result.reason ?? '開始できませんでした');
    return;
  }
  $('run-btn').disabled = true;
  $('error-box').hidden = true;
  $('progress').hidden = false;
  $('log').textContent = '';
  logCount = 0;
  jobTimer = setInterval(pollJob, 1000);
});

async function pollJob() {
  const j = await api(`/api/job?since=${logCount}`);
  $('progress-step').textContent = j.step;
  for (const entry of j.lines) {
    const div = document.createElement('div');
    div.className = entry.kind;
    div.textContent = entry.line;
    $('log').appendChild(div);
  }
  if (j.lines.length > 0) {
    logCount = j.total;
    $('log').scrollTop = $('log').scrollHeight;
  }
  if (j.status === 'done') {
    clearInterval(jobTimer);
    $('run-btn').disabled = false;
    showStep('step-run', true);
    $('step-done').hidden = false;
    $('url-watch').textContent = j.result.watch;
    $('url-broadcast').textContent = j.result.broadcast;
    $('step-done').scrollIntoView({ behavior: 'smooth' });
  } else if (j.status === 'error') {
    clearInterval(jobTimer);
    $('run-btn').disabled = false;
    $('error-box').hidden = false;
    $('error-hint').textContent = j.errorHint ?? 'ログの末尾を確認してください。';
  }
}

// ---- コピー ----

document.addEventListener('click', (ev) => {
  const target = ev.target.closest('[data-copy]');
  if (!target) return;
  navigator.clipboard.writeText($(target.dataset.copy).textContent).then(() => {
    const old = target.textContent;
    target.textContent = 'コピーしました';
    setTimeout(() => { target.textContent = old; }, 1200);
  });
});

loadState();
