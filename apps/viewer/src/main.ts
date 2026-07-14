import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import { decodePacket } from '@vrmsync/protocol';
import { DemoController } from './demo';
import { PoseApplier } from './poseApplier';
import { PoseStreamPlayer } from './poseStream';
import { WebSocketTransport } from './wsTransport';

const DEFAULT_VRM_PATH = '/Emo.vrm';

const statusEl = document.getElementById('status') as HTMLDivElement;
const urlInput = document.getElementById('vrm-url') as HTMLInputElement;
const loadButton = document.getElementById('load-button') as HTMLButtonElement;
const demoButton = document.getElementById('demo-button') as HTMLButtonElement;
const dropCheckbox = document.getElementById('drop-checkbox') as HTMLInputElement;
const wsUrlInput = document.getElementById('ws-url') as HTMLInputElement;
const wsButton = document.getElementById('ws-button') as HTMLButtonElement;

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

// 将来のWebXR対応(renderer.xr)を見据えて初期化を分離しておく(仕様書 §9)
function createRenderer(): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);
  return renderer;
}

const renderer = createRenderer();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x212121);

const camera = new THREE.PerspectiveCamera(
  30,
  window.innerWidth / window.innerHeight,
  0.1,
  50,
);
camera.position.set(0, 1.3, 2.5);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.0, 0);
controls.enableDamping = true;
controls.update();

const directionalLight = new THREE.DirectionalLight(0xffffff, 2.0);
directionalLight.position.set(1, 2, 1).normalize();
scene.add(directionalLight);

const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);

const gridHelper = new THREE.GridHelper(10, 10, 0x555555, 0x333333);
scene.add(gridHelper);

let currentVrm: VRM | null = null;
let currentApplier: PoseApplier | null = null;
let loading = false;

const demo = new DemoController();
let wsTransport: WebSocketTransport | null = null;
let wsPlayer: PoseStreamPlayer | null = null;

function stopDemo(): void {
  if (!demo.active) return;
  demo.stop();
  currentApplier?.reset();
  demoButton.textContent = 'デモ再生';
  demoButton.classList.remove('active');
}

function disconnectWs(): void {
  if (!wsTransport) return;
  wsTransport.close();
  wsTransport = null;
  wsPlayer = null;
  currentApplier?.reset();
  wsButton.textContent = '接続';
}

function connectWs(url: string): void {
  stopDemo();
  disconnectWs();
  wsPlayer = new PoseStreamPlayer();
  wsTransport = new WebSocketTransport(url);
  wsTransport.onStatus = (text, isError) => setStatus(text, isError);
  wsTransport.onPacket = (bytes) => {
    try {
      wsPlayer?.push(decodePacket(bytes), performance.now());
    } catch (error) {
      console.warn('パケットのデコードに失敗:', error);
    }
  };
  wsTransport.connect();
  wsButton.textContent = '切断';
}

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

function extractVrm(gltf: GLTF): VRM {
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm) {
    throw new Error('VRM拡張を含まないファイルです(glTF/GLBとしては読み込めました)');
  }
  return vrm;
}

function describeError(error: unknown): string {
  // fetch失敗(ネットワーク断・CORS拒否)はProgressEventとして届き詳細を持たない
  if (error instanceof ProgressEvent) {
    return 'ネットワークエラーまたはCORSエラー(DevToolsのNetworkタブを確認してください)';
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function formatProgress(loaded: number, total: number): string {
  const loadedMb = (loaded / 1024 / 1024).toFixed(1);
  if (total > 0) {
    return `${loadedMb} / ${(total / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${loadedMb} MB`;
}

// 将来の署名付きURL+暗号化配信(復号済みバッファの直接ロード)を見据えて
// URL / ArrayBuffer の両方を受け付ける
async function loadVRM(source: string | ArrayBuffer): Promise<void> {
  if (loading) return;
  loading = true;
  loadButton.disabled = true;
  setStatus('VRM 読み込み中...');

  try {
    const gltf =
      typeof source === 'string'
        ? await loader.loadAsync(source, (progress) => {
            setStatus(`VRM 読み込み中... ${formatProgress(progress.loaded, progress.total)}`);
          })
        : await loader.parseAsync(source, '');

    const vrm = extractVrm(gltf);

    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    // VRM 0.xは+Z向きで読み込まれるため、VRM 1.0(-Z向き)と向きを揃える
    VRMUtils.rotateVRM0(vrm);

    // 新モデルのロードに成功してから旧モデルを破棄する(失敗時は表示を維持)
    if (currentVrm) {
      scene.remove(currentVrm.scene);
      VRMUtils.deepDispose(currentVrm.scene);
    }
    currentVrm = vrm;
    currentApplier = new PoseApplier(vrm);
    scene.add(vrm.scene);

    setStatus(`VRM ${vrm.meta.metaVersion === '0' ? '0.x' : '1.0'} を表示中`);
    console.log('VRM loaded:', vrm);
  } catch (error) {
    console.error('VRM load error:', error);
    setStatus(`VRMの読み込みに失敗しました: ${describeError(error)}`, true);
  } finally {
    loading = false;
    loadButton.disabled = false;
  }
}

loadButton.addEventListener('click', () => {
  const url = urlInput.value.trim();
  if (url) void loadVRM(url);
});

urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') loadButton.click();
});

demoButton.addEventListener('click', () => {
  if (demo.active) {
    stopDemo();
    setStatus('デモ停止');
  } else {
    disconnectWs();
    demo.start();
    demoButton.textContent = 'デモ停止';
    demoButton.classList.add('active');
    setStatus('デモ再生中(ダミーモーション)');
  }
});

dropCheckbox.addEventListener('change', () => {
  demo.dropRate = dropCheckbox.checked ? 0.1 : 0;
});

wsButton.addEventListener('click', () => {
  if (wsTransport) {
    disconnectWs();
    setStatus('WebSocket切断');
  } else {
    const url = wsUrlInput.value.trim();
    if (url) connectWs(url);
  }
});

wsUrlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !wsTransport) wsButton.click();
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();

renderer.setAnimationLoop(() => {
  const delta = clock.getDelta();
  const player = wsPlayer ?? (demo.active ? demo.player : null);
  if (player && currentApplier) {
    currentApplier.apply(player.sample(performance.now()));
  }
  currentVrm?.update(delta);
  controls.update();
  renderer.render(scene, camera);
});

// 受け入れ確認(メモリリーク・デモ再生の滑らかさ検証)用に公開
Object.assign(window, {
  __viewerDebug: { renderer, loadVRM, demo, getVrm: () => currentVrm },
});

const initialUrl = new URLSearchParams(location.search).get('vrm') ?? DEFAULT_VRM_PATH;
urlInput.value = initialUrl;
void loadVRM(initialUrl);
