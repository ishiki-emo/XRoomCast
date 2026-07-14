declare module 'osc-min' {
  export interface OscArgument {
    type: string;
    value: unknown;
  }
  export interface OscMessage {
    oscType: 'message';
    address: string;
    args: OscArgument[];
  }
  export interface OscBundle {
    oscType: 'bundle';
    timetag: unknown;
    elements: OscElement[];
  }
  export type OscElement = OscMessage | OscBundle;

  export function fromBuffer(buffer: Buffer | Uint8Array, strict?: boolean): OscElement;
  export function toBuffer(element: {
    address?: string;
    args?: { type: string; value: unknown }[];
    timetag?: unknown;
    elements?: unknown[];
    oscType?: string;
  }): Buffer;
}
