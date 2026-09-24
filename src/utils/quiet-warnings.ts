/**
 * Masque l'avertissement DEP0040 (module `punycode` déprécié) émis sous
 * Node >= 21 par une dépendance transitive de @solana/web3.js (node-fetch).
 * Doit être importé AVANT toute autre dépendance.
 */
const originalEmitWarning = process.emitWarning.bind(process);

process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const message = typeof warning === 'string' ? warning : warning.message;
  if (message.includes('punycode')) return;
  return (originalEmitWarning as (...a: unknown[]) => void)(warning, ...args);
}) as typeof process.emitWarning;

export {};
