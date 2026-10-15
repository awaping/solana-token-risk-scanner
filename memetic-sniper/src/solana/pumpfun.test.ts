/**
 * Maths de la bonding curve et invariants de depense.
 * `node --test src/solana/pumpfun.test.ts`
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair, PublicKey } from '@solana/web3.js';

import {
  DEFAULT_GLOBAL_PARAMS,
  MAX_TX_BYTES,
  PUMP_PROGRAM_ID,
  buildBuyInstruction,
  buildCreateAndBuyTx,
  buildCreateInstruction,
  decodeGlobal,
  deriveBondingCurve,
  deriveCreatorVault,
  getBuyAmountOut,
  quoteInitialBuy,
  buildCollectCreatorFeeInstruction,
  buildSellInstruction,
  buildSellTx,
  curveMarketCapLamports,
  curvePrice,
  decodeBondingCurve,
  getSellAmountOut,
  quoteExactInputSell,
} from './pumpfun.ts';

const G = DEFAULT_GLOBAL_PARAMS;
const LAMPORTS = 1_000_000_000n;

const globalStub = {
  initialized: true,
  authority: PublicKey.default,
  feeRecipient: new PublicKey('CebN5WGQ4jvEPvsVU4EoHCY2Z4VZqrvbYSJPXH79pFV'),
  ...G,
};

const META = {
  name: 'Gigachad Frog',
  symbol: 'GFROG',
  uri: 'https://gateway.irys.xyz/1RVCLbcy4FEgTJ8Wnfo1BjZqoUWmCFTraqLNYMyXktA',
};

// ---------------------------------------------------------------------------
// Courbe
// ---------------------------------------------------------------------------

test('getBuyAmountOut reproduit le produit constant du programme', () => {
  // 1 SOL sur la courbe initiale. Calcul independant, entier :
  //   r = floor(30e9 * 1.073e15 / 31e9) + 1 ; out = 1.073e15 - r
  const n = G.initialVirtualSolReserves * G.initialVirtualTokenReserves;
  const expected = G.initialVirtualTokenReserves - (n / (G.initialVirtualSolReserves + LAMPORTS) + 1n);
  const out = getBuyAmountOut(
    LAMPORTS,
    G.initialVirtualSolReserves,
    G.initialVirtualTokenReserves,
    G.initialRealTokenReserves,
  );
  assert.equal(out, expected);
  // Ordre de grandeur : 1 SOL sur 30 SOL virtuels => ~3.2% de 1.073e9 tokens.
  assert.ok(out > 34_000_000_000_000n && out < 35_000_000_000_000n, `unexpected magnitude: ${out}`);
});

test('getBuyAmountOut est monotone croissant', () => {
  let prev = 0n;
  for (const sol of [1n, 1_000_000n, 100_000_000n, LAMPORTS, 10n * LAMPORTS]) {
    const out = getBuyAmountOut(
      sol,
      G.initialVirtualSolReserves,
      G.initialVirtualTokenReserves,
      G.initialRealTokenReserves,
    );
    assert.ok(out > prev, `not monotonic at ${sol}`);
    prev = out;
  }
});

test('getBuyAmountOut plafonne aux reserves reelles', () => {
  const out = getBuyAmountOut(
    10_000n * LAMPORTS,
    G.initialVirtualSolReserves,
    G.initialVirtualTokenReserves,
    G.initialRealTokenReserves,
  );
  assert.equal(out, G.initialRealTokenReserves);
});

test('getBuyAmountOut retourne 0 sur une entree nulle ou negative', () => {
  const args = [
    G.initialVirtualSolReserves,
    G.initialVirtualTokenReserves,
    G.initialRealTokenReserves,
  ] as const;
  assert.equal(getBuyAmountOut(0n, ...args), 0n);
  assert.equal(getBuyAmountOut(-5n, ...args), 0n);
});

// ---------------------------------------------------------------------------
// Cotation
// ---------------------------------------------------------------------------

test('INVARIANT: maxSolCost ne depasse jamais le budget', () => {
  // C'est la propriete qui borne la perte maximale par lancement.
  for (const sol of ['0.1', '0.15', '0.3', '1']) {
    const budget = BigInt(Math.round(Number(sol) * 1e9));
    for (const slippage of [0, 100, 500, 2000]) {
      const q = quoteInitialBuy(budget, slippage, G);
      assert.equal(q.maxSolCost, budget, `budget breached at ${sol} SOL / ${slippage} bps`);
    }
  }
});

test('le slippage reduit les tokens demandes, jamais le plafond de depense', () => {
  const budget = 150_000_000n;
  const tight = quoteInitialBuy(budget, 0, G);
  const loose = quoteInitialBuy(budget, 500, G);
  assert.ok(loose.amount < tight.amount);
  assert.equal(loose.maxSolCost, tight.maxSolCost);
  assert.equal(tight.amount, tight.quotedTokens);
});

test('les frais sont retires avant la cotation', () => {
  const budget = 100_000_000n; // 0.1 SOL
  const q = quoteInitialBuy(budget, 0, G);
  assert.equal(q.solIntoCurve + q.feeLamports, budget);
  // 1% de frais : ~990099 lamports sur 100000000.
  assert.ok(q.feeLamports > 900_000n && q.feeLamports < 1_100_000n, `fee=${q.feeLamports}`);
});

test('quoteInitialBuy rejette les entrees invalides', () => {
  assert.throws(() => quoteInitialBuy(0n, 100, G), /must be > 0/);
  assert.throws(() => quoteInitialBuy(1_000_000n, -1, G), /slippageBps/);
  assert.throws(() => quoteInitialBuy(1_000_000n, 10_000, G), /slippageBps/);
});

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

test('create expose 14 comptes, buy en expose 16', () => {
  const mint = Keypair.generate().publicKey;
  const user = Keypair.generate().publicKey;
  assert.equal(buildCreateInstruction({ mint, user, metadata: META }).keys.length, 14);
  assert.equal(
    buildBuyInstruction({
      mint,
      user,
      feeRecipient: globalStub.feeRecipient,
      amount: 1n,
      maxSolCost: 1n,
    }).keys.length,
    16,
  );
});

test('create refuse des metadonnees hors bornes Metaplex', () => {
  const mint = Keypair.generate().publicKey;
  const user = Keypair.generate().publicKey;
  assert.throws(
    () => buildCreateInstruction({ mint, user, metadata: { ...META, symbol: 'ELEVENCHARS' } }),
    /symbol is 11 bytes/,
  );
  assert.throws(
    () => buildCreateInstruction({ mint, user, metadata: { ...META, name: '' } }),
    /name is empty/,
  );
});

test('le creator vault suit le createur, pas le payeur', () => {
  const creator = Keypair.generate().publicKey;
  const payer = Keypair.generate().publicKey;
  assert.notEqual(deriveCreatorVault(creator).toBase58(), deriveCreatorVault(payer).toBase58());
});

test('les PDA sont deterministes et memoisees', () => {
  const mint = Keypair.generate().publicKey;
  assert.equal(deriveBondingCurve(mint).toBase58(), deriveBondingCurve(mint).toBase58());
});

// ---------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------

test('la tx create+buy+tip tient sous la limite de paquet', () => {
  const built = buildCreateAndBuyTx({
    payer: Keypair.generate(),
    mint: Keypair.generate(),
    metadata: META,
    solBudgetLamports: 150_000_000n,
    slippageBps: 500,
    global: globalStub,
    recentBlockhash: '11111111111111111111111111111111',
    computeUnitLimit: 350_000,
    computeUnitPriceMicroLamports: 150_000,
  });
  assert.ok(built.size <= MAX_TX_BYTES, `tx is ${built.size} bytes`);
  assert.equal(built.usedLookupTables, false);
  // 2 ComputeBudget + create + ATA + buy
  assert.equal(built.tx.message.compiledInstructions.length, 5);
  assert.equal(built.tx.signatures.length, 2);
});

test('une URI trop longue est rejetee avec un message actionnable', () => {
  assert.throws(
    () =>
      buildCreateAndBuyTx({
        payer: Keypair.generate(),
        mint: Keypair.generate(),
        metadata: { ...META, uri: `https://x.invalid/${'a'.repeat(300)}` },
        solBudgetLamports: 150_000_000n,
        slippageBps: 500,
        global: globalStub,
        recentBlockhash: '11111111111111111111111111111111',
        computeUnitLimit: 350_000,
        computeUnitPriceMicroLamports: 150_000,
      }),
    /uri is \d+ bytes, Metaplex allows 200/,
  );
});

// ---------------------------------------------------------------------------
// Compte global
// ---------------------------------------------------------------------------

test('decodeGlobal lit le prefixe stable et ignore la queue', () => {
  const authority = Keypair.generate().publicKey;
  const feeRecipient = Keypair.generate().publicKey;
  const head = Buffer.concat([
    Buffer.alloc(8), // discriminant
    Buffer.from([1]), // initialized
    authority.toBuffer(),
    feeRecipient.toBuffer(),
  ]);
  const nums = Buffer.alloc(40);
  const values = [
    G.initialVirtualTokenReserves,
    G.initialVirtualSolReserves,
    G.initialRealTokenReserves,
    G.tokenTotalSupply,
    G.feeBasisPoints,
  ];
  values.forEach((v, i) => nums.writeBigUInt64LE(v, i * 8));
  // Queue arbitraire : champs ajoutes par une version ulterieure du programme.
  const tail = Buffer.alloc(237, 7);

  const decoded = decodeGlobal(Buffer.concat([head, nums, tail]));
  assert.equal(decoded.initialized, true);
  assert.equal(decoded.feeRecipient.toBase58(), feeRecipient.toBase58());
  assert.equal(decoded.feeBasisPoints, G.feeBasisPoints);
  assert.equal(decoded.tokenTotalSupply, G.tokenTotalSupply);
});

test('decodeGlobal rejette un buffer tronque', () => {
  assert.throws(() => decodeGlobal(Buffer.alloc(40)), /too short/);
});

test('le program id pump est celui attendu', () => {
  assert.equal(PUMP_PROGRAM_ID.toBase58(), '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
});

// ===========================================================================
// SORTIE : courbe, cotation inverse, vente, collecte des frais
// ===========================================================================

/** Encode un compte BondingCurve au layout verifie on-chain. */
function encodeCurve(v: {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: number;
  creator: PublicKey;
  trailing?: number;
}): Buffer {
  const nums = Buffer.alloc(40);
  [
    v.virtualTokenReserves,
    v.virtualSolReserves,
    v.realTokenReserves,
    v.realSolReserves,
    v.tokenTotalSupply,
  ].forEach((x, i) => nums.writeBigUInt64LE(x, i * 8));
  return Buffer.concat([
    Buffer.alloc(8),
    nums,
    Buffer.from([v.complete]),
    v.creator.toBuffer(),
    Buffer.alloc(v.trailing ?? 70, 0),
  ]);
}

/**
 * Valeurs relevees sur une vraie courbe mainnet le 2026-09-17
 * (5nnp32q7UekSCQsWbVw86vSvZqWQKvEHmfEUrzveGBLH). Sert de test de
 * non-regression sur le layout : si le programme reorganise le compte, ce
 * decodage produira des valeurs absurdes et le test tombera.
 */
const LIVE_CURVE = {
  virtualTokenReserves: 813_526_790_169_779n,
  virtualSolReserves: 39_568_457_290n,
  realTokenReserves: 533_626_790_169_779n,
  realSolReserves: 9_568_457_290n,
  tokenTotalSupply: 1_000_000_000_000_000n,
  complete: 0,
  creator: new PublicKey('Eu4XyAD3dQvX2FSvXnGXbZc4VapvUsDb4qzYi5No1YJS'),
};

test('decodeBondingCurve lit une courbe mainnet reelle', () => {
  const c = decodeBondingCurve(encodeCurve(LIVE_CURVE));
  assert.equal(c.virtualSolReserves, LIVE_CURVE.virtualSolReserves);
  assert.equal(c.virtualTokenReserves, LIVE_CURVE.virtualTokenReserves);
  assert.equal(c.complete, false);
  assert.equal(c.creator.toBase58(), LIVE_CURVE.creator.toBase58());
  // Invariant de la courbe canonique : vSol - realSol = 30 SOL de reserve virtuelle.
  assert.equal(c.virtualSolReserves - c.realSolReserves, 30_000_000_000n);
  // Et cote tokens : 1073e6 - 793.1e6 = 279.9e6 tokens.
  assert.equal(c.virtualTokenReserves - c.realTokenReserves, 279_900_000_000_000n);
});

test('decodeBondingCurve rejette un layout derive', () => {
  assert.throws(() => decodeBondingCurve(Buffer.alloc(40)), /too short/);
  // Un bool a 7 signifie qu'on ne lit pas le champ qu'on croit.
  assert.throws(
    () => decodeBondingCurve(encodeCurve({ ...LIVE_CURVE, complete: 7 })),
    /invalid bool/,
  );
  assert.throws(
    () => decodeBondingCurve(encodeCurve({ ...LIVE_CURVE, virtualSolReserves: 0n })),
    /zero virtual reserves/,
  );
});

test('curvePrice se calcule sur les reserves virtuelles', () => {
  const c = decodeBondingCurve(encodeCurve(LIVE_CURVE));
  const expected = Number(LIVE_CURVE.virtualSolReserves) / Number(LIVE_CURVE.virtualTokenReserves);
  assert.equal(curvePrice(c), expected);
  assert.equal(curveMarketCapLamports(c), expected * Number(LIVE_CURVE.tokenTotalSupply));
});

test('getSellAmountOut est monotone et nul sur entree nulle', () => {
  const { virtualSolReserves: vs, virtualTokenReserves: vt } = LIVE_CURVE;
  assert.equal(getSellAmountOut(0n, vs, vt), 0n);
  assert.equal(getSellAmountOut(-1n, vs, vt), 0n);
  let prev = 0n;
  for (const amt of [1_000_000n, 1_000_000_000n, 100_000_000_000n]) {
    const out = getSellAmountOut(amt, vs, vt);
    assert.ok(out > prev, `not monotonic at ${amt}`);
    prev = out;
  }
});

test('aller-retour immediat : on recupere moins que la mise', () => {
  // Deux fois les frais plus l'arrondi de la courbe : un buy suivi d'un sell
  // instantane doit TOUJOURS perdre. Si ce test passait a l'egalite, la
  // formule de cotation serait fausse quelque part.
  const budget = 100_000_000n; // 0.1 SOL
  const buy = quoteInitialBuy(budget, 0, G);
  const sell = quoteExactInputSell(
    buy.amount,
    {
      virtualSolReserves: G.initialVirtualSolReserves + buy.solIntoCurve,
      virtualTokenReserves: G.initialVirtualTokenReserves - buy.amount,
    },
    0,
    G.feeBasisPoints,
  );
  assert.ok(sell.netSolOut < budget, `round trip returned ${sell.netSolOut} for ${budget}`);
  // La perte reste de l'ordre de deux fois les frais (~1.9%), pas d'un facteur.
  const lossPct = Number(budget - sell.netSolOut) / Number(budget);
  assert.ok(lossPct > 0.015 && lossPct < 0.03, `unexpected round-trip loss: ${lossPct}`);
});

test('quoteExactInputSell : le slippage abaisse minSolOutput, pas le net', () => {
  const curve = {
    virtualSolReserves: LIVE_CURVE.virtualSolReserves,
    virtualTokenReserves: LIVE_CURVE.virtualTokenReserves,
  };
  const tight = quoteExactInputSell(1_000_000_000n, curve, 0, G.feeBasisPoints);
  const loose = quoteExactInputSell(1_000_000_000n, curve, 500, G.feeBasisPoints);
  assert.equal(tight.netSolOut, loose.netSolOut);
  assert.ok(loose.minSolOutput < tight.minSolOutput);
  // minSolOutput ne depasse jamais ce que la courbe rend reellement.
  assert.ok(tight.minSolOutput <= tight.netSolOut);
  assert.equal(tight.grossSolOut - tight.feeLamports, tight.netSolOut);
});

test('quoteExactInputSell rejette les entrees invalides', () => {
  const curve = {
    virtualSolReserves: LIVE_CURVE.virtualSolReserves,
    virtualTokenReserves: LIVE_CURVE.virtualTokenReserves,
  };
  assert.throws(() => quoteExactInputSell(0n, curve, 100), /must be > 0/);
  assert.throws(() => quoteExactInputSell(1n, curve, 10_000), /slippageBps/);
});

test('sell expose les memes 16 comptes que buy', () => {
  const mint = Keypair.generate().publicKey;
  const user = Keypair.generate().publicKey;
  const ix = buildSellInstruction({
    mint,
    user,
    creator: user,
    feeRecipient: globalStub.feeRecipient,
    amount: 1n,
    minSolOutput: 0n,
  });
  assert.equal(ix.keys.length, 16);
  // Discriminant + deux u64, sans l'argument optionnel track_volume.
  assert.equal(ix.data.length, 24);
  assert.equal(ix.keys[6]?.isSigner, true); // `user`
});

test('buildSellTx produit une tx v0 signee et compacte', () => {
  const payer = Keypair.generate();
  const mint = Keypair.generate().publicKey;
  const built = buildSellTx({
    payer,
    mint,
    creator: payer.publicKey,
    amount: 1_000_000_000n,
    curve: {
      virtualSolReserves: LIVE_CURVE.virtualSolReserves,
      virtualTokenReserves: LIVE_CURVE.virtualTokenReserves,
    },
    slippageBps: 500,
    feeRecipient: globalStub.feeRecipient,
    feeBasisPoints: G.feeBasisPoints,
    recentBlockhash: '11111111111111111111111111111111',
    computeUnitLimit: 200_000,
    computeUnitPriceMicroLamports: 100_000,
  });
  assert.ok(built.size <= MAX_TX_BYTES, `sell tx is ${built.size} bytes`);
  // Une vente est bien plus legere qu'un create+buy : large marge attendue.
  assert.ok(built.size < 800, `sell tx unexpectedly large: ${built.size}`);
  assert.equal(built.tx.signatures.length, 1);
  assert.equal(built.tx.message.compiledInstructions.length, 3);
  assert.ok(built.quote.minSolOutput > 0n);
});

test('collect_creator_fee : 5 comptes, createur signataire, aucun argument', () => {
  const creator = Keypair.generate().publicKey;
  const ix = buildCollectCreatorFeeInstruction(creator);
  assert.equal(ix.keys.length, 5);
  assert.equal(ix.data.length, 8);
  assert.equal(ix.keys[0]?.pubkey.toBase58(), creator.toBase58());
  assert.equal(ix.keys[0]?.isSigner, true);
  assert.equal(ix.keys[1]?.pubkey.toBase58(), deriveCreatorVault(creator).toBase58());
  assert.equal(ix.keys[1]?.isWritable, true);
});
