/**
 * Préchauffage JIT du chemin critique.
 *
 * V8 n'optimise une fonction qu'après l'avoir exécutée de nombreuses fois :
 * sans préchauffage, les premières créations réelles seraient traitées par
 * du code interprété (plusieurs millisecondes au lieu de quelques dizaines de
 * microsecondes). On rejoue donc des milliers de transactions synthétiques
 * dans un moteur jetable, exactement par le même chemin que le flux réel
 * (message brut → JSON.parse → décodage → score → verdict → rendu), AVANT de
 * se connecter aux sources.
 */
import { StreamEngine, type VerdictEvent } from './engine.js';
import { ReputationStore } from './reputation.js';
import { parseLogsNotification } from './sources/websocket.js';
import { createTxLogs, key, signature, tradeTxLogs } from './synthetic.js';

export function warmUpHotPath(iterations = 20_000, onVerdict?: (event: VerdictEvent) => void): { iterations: number; ms: number } {
  const started = process.hrtime.bigint();
  const engine = new StreamEngine({ bundleSlots: 2, trackSeconds: 60, reputation: new ReputationStore() });
  if (onVerdict) engine.on('verdict', onVerdict);

  const pool = Array.from({ length: 512 }, key);
  const creators = pool.slice(0, 32);
  const mints: string[] = [];
  let slot = 1_000;

  for (let i = 0; i < iterations; i++) {
    if (i % 40 === 0) slot++;
    let logs: string[];
    if (i % 25 === 0) {
      const mint = key();
      mints.push(mint);
      if (mints.length > 16) mints.shift();
      logs = createTxLogs({ mint, creator: creators[i % creators.length]!, symbol: `W${i % 97}`, devBuyTokens: BigInt(1 + (i % 300)) * 1_000_000_000_000n });
    } else {
      const tracked = i % 3 === 0 && mints.length > 0;
      const mint = tracked ? mints[i % mints.length]! : pool[i % pool.length]!;
      const user = i % 11 === 0 && tracked ? creators[i % creators.length]! : pool[(i * 7) % pool.length]!;
      logs = tradeTxLogs({ mint, user, isBuy: i % 4 !== 0, sol: BigInt(1 + (i % 7)) * 250_000_000n });
    }
    const raw = JSON.stringify({
      jsonrpc: '2.0',
      method: 'logsNotification',
      params: { result: { context: { slot }, value: { signature: signature(), err: null, logs } }, subscription: 1 },
    });
    const tx = parseLogsNotification(raw, 'warmup', process.hrtime.bigint());
    if (tx && typeof tx !== 'string') engine.handleTx(tx);
  }

  engine.stop();
  engine.removeAllListeners();
  return { iterations, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}
