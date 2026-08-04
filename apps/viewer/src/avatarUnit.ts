/**
 * 配信ストリーム1本ぶんの表示ユニット。
 * slotフレーム(root)・アバター・ジッタバッファ・接地影・待機モーションを
 * 1つに束ねる。複数配信者ではこのクラスをストリームごとにインスタンス化し、
 * roomSpace の下に席(root.position)を割り当てて並べる。
 * DOMには触らない。UIへの通知(進捗・完了・失敗)はフックで受ける。
 */
import * as THREE from 'three';
import type { Packet } from '@xroomcast/protocol';
import { PoseStreamPlayer } from '@xroomcast/sync';
import {
  Avatar,
  ContactShadow,
  IdleMotion,
  PlaceholderAvatar,
  blendPose,
  type ShadowMode,
} from '@xroomcast/viewer-core';

/** 最後の受信からこの時間が空いたら待機モーションへ移る */
export const IDLE_AFTER_MS = 5000;
/** 待機↔配信のクロスフェード時間 */
const IDLE_BLEND_MS = 700;

export interface AvatarUnitHooks {
  onProgress?(loaded: number, total: number): void;
  onLoaded?(avatar: Avatar): void;
  onError?(error: unknown): void;
  onLoadingChanged?(loading: boolean): void;
}

export interface AvatarUnitOptions {
  /** ユニットのぶら下げ先(roomSpace) */
  parent: THREE.Object3D;
  /** ロード時にシェーダとテクスチャをGPUへ載せておくための参照 */
  precompile: { renderer: THREE.WebGLRenderer; camera: THREE.Camera; scene: THREE.Scene };
  hooks?: AvatarUnitHooks;
}

/** 毎フレームの入力。player は配信かデモのどちらかのジッタバッファ */
export interface UnitFrameInput {
  /** performance.now() 基準 */
  now: number;
  /** 前フレームからの経過(秒) */
  delta: number;
  /** クロック経過秒(仮アバターの浮遊アニメ用) */
  elapsed: number;
  player: PoseStreamPlayer | null;
  /** デモ再生など、受信の途切れ判定をせず常に配信側として扱うか */
  alwaysLive: boolean;
}

export class AvatarUnit {
  /** slotフレーム。roomSpace 内での席の位置・向きはこの変換で表す */
  readonly root = new THREE.Group();
  /** このユニット専用のジッタバッファ */
  readonly player = new PoseStreamPlayer();
  /** 最後にパケットを受け取った時刻(performance.now()基準) */
  lastPacketAt = 0;

  private readonly contactShadow: ContactShadow;
  private readonly placeholder: PlaceholderAvatar;
  private readonly idleMotion = new IdleMotion();
  private readonly options: AvatarUnitOptions;

  private currentAvatar: Avatar | null = null;
  private loading = false;
  /** ロード中に届いた切り替え指示(完了後に読み直す) */
  private pendingSource: string | null = null;
  private unitScale = 1;
  /** 待機↔配信の混ぜ具合(0=待機のみ、1=配信のみ) */
  private liveBlend = 0;
  /** 完全に配信側へ移行済みか(移行の瞬間だけ待機の表情を片付ける) */
  private liveOnly = false;

  constructor(options: AvatarUnitOptions) {
    this.options = options;
    options.parent.add(this.root);
    this.contactShadow = new ContactShadow(this.root);
    this.placeholder = new PlaceholderAvatar(this.root);
    this.placeholder.setVisible(false);
  }

  get avatar(): Avatar | null {
    return this.currentAvatar;
  }

  get isLoading(): boolean {
    return this.loading;
  }

  pushPacket(packet: Packet, now: number): void {
    this.lastPacketAt = now;
    this.player.push(packet, now);
  }

  /**
   * VRMを読み込んで差し替える。ロード中の呼び出しは覚えておき、完了後に読み直す。
   * 新モデルのロードに成功してから旧モデルを外す(失敗時は表示を維持)
   */
  async load(source: string | ArrayBuffer): Promise<void> {
    if (this.loading) {
      if (typeof source === 'string') this.pendingSource = source;
      return;
    }
    this.loading = true;
    this.options.hooks?.onLoadingChanged?.(true);
    // 表示できるアバターがまだ無いときだけ仮アバターを立てる。
    // 差し替え中は旧アバターをそのまま見せ続ける
    this.placeholder.setVisible(this.currentAvatar === null);
    try {
      const next = await Avatar.load(source, this.root, {
        onProgress: (progress) => this.options.hooks?.onProgress?.(progress.loaded, progress.total),
        precompile: this.options.precompile,
      });
      // GPUリソースの解放は重いので、見た目を切り替えたあと次のフレームで行う
      const previous = this.currentAvatar;
      previous?.detach();
      this.currentAvatar = next;
      if (previous) requestAnimationFrame(() => previous.dispose());
      next.applyScale(this.unitScale);
      this.placeholder.setVisible(false);
      this.options.hooks?.onLoaded?.(next);
    } catch (error) {
      this.options.hooks?.onError?.(error);
      this.placeholder.setVisible(this.currentAvatar === null);
    } finally {
      this.loading = false;
      this.options.hooks?.onLoadingChanged?.(false);
      const pending = this.pendingSource;
      this.pendingSource = null;
      if (pending && pending !== source) void this.load(pending);
    }
  }

  /** 毎フレーム呼ぶ。配信ポーズと待機モーションのブレンドもここで行う */
  update(input: UnitFrameInput): void {
    this.placeholder.update(input.elapsed);
    this.contactShadow.update();
    const avatar = this.currentAvatar;
    if (!avatar) return;

    const liveFrame = input.player?.sample(input.now);
    // デモ再生は常に配信側扱い。実配信はパケットが途切れたら待機モーションへ戻す
    const liveReady =
      Boolean(liveFrame?.pose) &&
      (input.alwaysLive || input.now - this.lastPacketAt < IDLE_AFTER_MS);
    const step = input.delta * (1000 / IDLE_BLEND_MS);
    this.liveBlend = THREE.MathUtils.clamp(this.liveBlend + (liveReady ? step : -step), 0, 1);

    if (this.liveBlend >= 1 && liveFrame) {
      if (!this.liveOnly) {
        // 待機中のまばたきが「目を閉じたまま」で残らないよう、移行時に戻す
        avatar.vrm.expressionManager?.setValue('blink', 0);
        this.liveOnly = true;
      }
      avatar.applyPose(liveFrame);
    } else {
      this.liveOnly = false;
      const idleFrame = this.idleMotion.sample(input.now, avatar.restPose);
      avatar.applyPose(
        this.liveBlend > 0 && liveFrame
          ? blendPose(idleFrame, liveFrame, this.liveBlend)
          : idleFrame,
      );
    }
    avatar.update(input.delta);
  }

  /** 配置フレームのスケール変更に追従させる(スプリングボーン等の補正) */
  applyScale(scale: number): void {
    this.unitScale = scale;
    this.currentAvatar?.applyScale(scale);
  }

  resetPose(): void {
    this.currentAvatar?.resetPose();
  }

  /** アバターの頭のワールド位置(空間オーディオの音源用)。アバター未ロードならnull */
  getHeadWorldPosition(target: THREE.Vector3): THREE.Vector3 | null {
    return this.currentAvatar ? this.currentAvatar.getHeadWorldPosition(target) : null;
  }

  setShadowMode(mode: ShadowMode): void {
    this.contactShadow.setMode(mode);
  }

  getShadowMode(): ShadowMode {
    return this.contactShadow.getMode();
  }

  setShadowARActive(on: boolean): void {
    this.contactShadow.setARActive(on);
  }

  /** ユニットを破棄する(配信者の退場)。アバターとフレームをシーンから外す */
  dispose(): void {
    const avatar = this.currentAvatar;
    this.currentAvatar = null;
    avatar?.detach();
    avatar?.dispose();
    this.options.parent.remove(this.root);
  }
}
