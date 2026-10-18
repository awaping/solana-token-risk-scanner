/** Types de host.mjs (assistant de mise à jour, JavaScript exécuté par Node hors build). */
export declare const REPO_ROOT: string;
export interface HostReply {
  ok: boolean;
  error?: string;
  version?: string;
  latest?: string;
  root?: string;
  behind?: number;
  from?: string;
  to?: string;
  output?: string;
}
export declare function encodeMessage(message: unknown): Buffer;
export declare function decodeMessage(buffer: Buffer): unknown;
export declare function runAction(action: unknown, root?: string): HostReply;
