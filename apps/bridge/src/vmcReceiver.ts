/**
 * VMCプロトコル(OSC over UDP)の受信。
 * VSeeFaceはOSCバンドルで送ってくるため、バンドルは再帰的に展開する。
 */
import dgram from 'node:dgram';
import { fromBuffer, type OscElement } from 'osc-min';
import type { Quat, Vec3 } from '@vrmsync/protocol';

export interface VmcHandlers {
  onBone(name: string, pos: Vec3, rot: Quat): void;
  onBlendValue(name: string, value: number): void;
  onBlendApply(): void;
  onRoot(pos: Vec3, rot: Quat): void;
  /** フレーム区切り(/VMC/Ext/T)。1フレーム分のボーン送信が完了した合図 */
  onFrameEnd(): void;
  /** 統計用: 種別を問わずVMCメッセージを1件処理するたびに呼ばれる */
  onMessage(): void;
  /** UDPデータグラムの送信元(addr:port)。複数送信元の混線検出用 */
  onSender(sender: string): void;
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

export function startVmcReceiver(port: number, handlers: VmcHandlers): dgram.Socket {
  const socket = dgram.createSocket('udp4');

  const dispatch = (address: string, args: unknown[]): void => {
    switch (address) {
      case '/VMC/Ext/Bone/Pos': {
        if (typeof args[0] !== 'string') return;
        handlers.onBone(
          args[0],
          [num(args[1]), num(args[2]), num(args[3])],
          [num(args[4]), num(args[5]), num(args[6]), num(args[7])],
        );
        handlers.onMessage();
        break;
      }
      case '/VMC/Ext/Blend/Val': {
        if (typeof args[0] !== 'string') return;
        handlers.onBlendValue(args[0], num(args[1]));
        handlers.onMessage();
        break;
      }
      case '/VMC/Ext/Blend/Apply': {
        handlers.onBlendApply();
        handlers.onMessage();
        break;
      }
      case '/VMC/Ext/Root/Pos': {
        // 引数: name, pos xyz, rot xyzw (,scale等が続く場合もある)
        handlers.onRoot(
          [num(args[1]), num(args[2]), num(args[3])],
          [num(args[4]), num(args[5]), num(args[6]), num(args[7])],
        );
        handlers.onMessage();
        break;
      }
      case '/VMC/Ext/T': {
        handlers.onFrameEnd();
        handlers.onMessage();
        break;
      }
      default:
        // /VMC/Ext/OK などは使用しない
        break;
    }
  };

  const walk = (element: OscElement): void => {
    if (element.oscType === 'bundle') {
      for (const child of element.elements) walk(child);
    } else {
      dispatch(
        element.address,
        element.args.map((a) => a.value),
      );
    }
  };

  socket.on('message', (buffer, rinfo) => {
    handlers.onSender(`${rinfo.address}:${rinfo.port}`);
    try {
      walk(fromBuffer(buffer));
    } catch {
      // 壊れたOSCパケットは無視(VMC以外のUDPが飛んでくる可能性もある)
    }
  });

  socket.on('error', (error) => {
    console.error(`[vmc] UDPソケットエラー:`, error.message);
  });

  socket.bind(port, () => {
    console.log(`[vmc] OSC受信待機: udp://0.0.0.0:${port}`);
  });

  return socket;
}
