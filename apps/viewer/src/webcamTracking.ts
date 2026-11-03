/**
 * Webカメラの映像から、顔・体・手を推定する(MediaPipe Tasks Vision)。
 * 推定はすべてブラウザの中で行い、映像はどこにも送らない。
 *
 * - 顔(FaceLandmarker): 頭の回転と位置(顔の変換行列)と、表情(ブレンドシェイプ52種)
 * - 体(PoseLandmarker): 手首・肘・耳の位置(メートル単位の3D)。手の位置に使う
 * - 手(HandLandmarker): 21関節(メートル単位の3D)。手首の向きと指の曲がりに使う
 *
 * WASM本体はこのアプリから配る(パッケージから取り出す)。モデルはGoogleの公式の置き場所から読む。
 * このモジュールはWebカメラ配信を始めたときにだけ読み込む(視聴ページの重さを変えないため)
 */
import {
  FaceLandmarker,
  HandLandmarker,
  PoseLandmarker,
  type FaceLandmarkerResult,
  type Landmark,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision';
import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';
import * as THREE from 'three';

const MODEL_BASE = 'https://storage.googleapis.com/mediapipe-models';
const FACE_MODEL = `${MODEL_BASE}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`;
/** 体は軽量版で足りる(使うのは上半身の数点だけ) */
const POSE_MODEL = `${MODEL_BASE}/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`;
const HAND_MODEL = `${MODEL_BASE}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`;

export interface FaceReading {
  /** 顔の回転(カメラ座標。x=画面の右=本人の左、y=上、z=カメラ側) */
  rotation: THREE.Quaternion;
  /** 顔の位置(メートル、同じ座標) */
  position: THREE.Vector3;
  /** ブレンドシェイプ名 → 0..1(Left/Right は本人から見た左右) */
  blendshapes: Map<string, number>;
}

export interface PoseReading {
  /** メートル単位の3D(腰の中心が原点。x=画面の右、y=下、z=奥) */
  world: Landmark[];
  /** 画像上の位置(0..1)。手の左右の判定に使う */
  image: NormalizedLandmark[];
}

export interface HandReading {
  world: Landmark[];
  image: NormalizedLandmark[];
  /** MediaPipe の左右ラベル("Left" / "Right"。反転していない映像では本人の左右と一致する) */
  label: string;
}

export interface TrackingResult {
  face: FaceReading | null;
  pose: PoseReading | null;
  hands: HandReading[];
}

function readFace(result: FaceLandmarkerResult): FaceReading | null {
  const matrix = result.facialTransformationMatrixes[0];
  if (!matrix) return null;
  // 列優先の4x4(位置はセンチメートル)
  _matrix.fromArray(matrix.data);
  const rotation = new THREE.Quaternion();
  const position = new THREE.Vector3();
  _matrix.decompose(position, rotation, _scale);
  position.multiplyScalar(0.01);
  const blendshapes = new Map<string, number>();
  for (const category of result.faceBlendshapes[0]?.categories ?? []) {
    blendshapes.set(category.categoryName, category.score);
  }
  return { rotation, position, blendshapes };
}

const _matrix = new THREE.Matrix4();
const _scale = new THREE.Vector3();

export class WebcamTracker {
  private constructor(
    private readonly face: FaceLandmarker,
    private readonly pose: PoseLandmarker,
    private readonly hand: HandLandmarker,
  ) {}

  /** モデルを読み込む。GPUで動かせなければCPUにする(遅くなるが動く) */
  static async create(): Promise<WebcamTracker> {
    const fileset = { wasmLoaderPath, wasmBinaryPath };
    const build = async (delegate: 'GPU' | 'CPU') => {
      const [face, pose, hand] = await Promise.all([
        FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: FACE_MODEL, delegate },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
        }),
        PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: POSE_MODEL, delegate },
          runningMode: 'VIDEO',
          numPoses: 1,
        }),
        HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: HAND_MODEL, delegate },
          runningMode: 'VIDEO',
          numHands: 2,
        }),
      ]);
      return new WebcamTracker(face, pose, hand);
    };
    try {
      return await build('GPU');
    } catch (error) {
      console.warn('[webcam] GPUで推定を始められないため、CPUで動かします:', error);
      return build('CPU');
    }
  }

  /**
   * 1フレーム推定する。timestamp はフレームごとに増える値(ms)。
   * body が false なら体と手の推定を省く(手を動かさない設定のときに軽くする)
   */
  detect(video: HTMLVideoElement, timestamp: number, body = true): TrackingResult {
    const faceResult = this.face.detectForVideo(video, timestamp);
    if (!body) return { face: readFace(faceResult), pose: null, hands: [] };
    const poseResult = this.pose.detectForVideo(video, timestamp);
    const handResult = this.hand.detectForVideo(video, timestamp);

    const face = readFace(faceResult);
    const poseWorld = poseResult.worldLandmarks[0];
    const poseImage = poseResult.landmarks[0];
    const pose = poseWorld && poseImage ? { world: poseWorld, image: poseImage } : null;

    const hands: HandReading[] = [];
    handResult.worldLandmarks.forEach((world, i) => {
      const image = handResult.landmarks[i];
      if (!image) return;
      hands.push({ world, image, label: handResult.handedness[i]?.[0]?.categoryName ?? '' });
    });
    return { face, pose, hands };
  }

  close(): void {
    this.face.close();
    this.pose.close();
    this.hand.close();
  }
}
