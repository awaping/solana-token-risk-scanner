'use strict';
/**
 * Remplacement JavaScript pur de `bigint-buffer` (dépendance de
 * @solana/buffer-layout-utils, via @solana/spl-token).
 *
 * Le paquet d'origine charge un module natif C vulnérable à un dépassement
 * de tampon dans toBigIntLE() (GHSA-3gc7-fjrx-p6mg, sans correctif publié) et
 * nécessite une compilation node-gyp à l'installation. Cette version reprend
 * à l'identique le repli JavaScript du paquet d'origine : même API, même
 * comportement, aucun code natif, aucun script d'installation.
 */
Object.defineProperty(exports, '__esModule', { value: true });

function toBigIntLE(buf) {
  const reversed = Buffer.from(buf);
  reversed.reverse();
  const hex = reversed.toString('hex');
  return hex.length === 0 ? BigInt(0) : BigInt(`0x${hex}`);
}

function toBigIntBE(buf) {
  const hex = Buffer.from(buf).toString('hex');
  return hex.length === 0 ? BigInt(0) : BigInt(`0x${hex}`);
}

function toBufferLE(num, width) {
  const hex = num.toString(16);
  const buffer = Buffer.from(hex.padStart(width * 2, '0').slice(0, width * 2), 'hex');
  buffer.reverse();
  return buffer;
}

function toBufferBE(num, width) {
  const hex = num.toString(16);
  return Buffer.from(hex.padStart(width * 2, '0').slice(0, width * 2), 'hex');
}

exports.toBigIntLE = toBigIntLE;
exports.toBigIntBE = toBigIntBE;
exports.toBufferLE = toBufferLE;
exports.toBufferBE = toBufferBE;
