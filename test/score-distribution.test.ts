/**
 * La note doit DISCRIMINER, pas seulement classer.
 *
 * Deux défauts constatés en production, que ces tests verrouillent :
 *
 *  1. Saturation — les pénalités étaient additionnées puis bornées à 100. Dès
 *     trois ou quatre signaux, tous les tokens à problème sortaient à exactement
 *     100 et l'ordre entre eux disparaissait.
 *
 *  2. Effondrement vers le bas — toutes les règles étant à seuil, un lancement
 *     banal n'en déclenchait aucune et tombait à 0. La majorité des tokens
 *     partageait la même note et la bande ORANGE était vide.
 *
 * Le tirage est volontairement déterministe (générateur congruentiel) : un test
 * de distribution qui échoue une fois sur dix n'apprend rien à personne.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFastScore, type FastSnapshot } from '../src/stream/fast-score.js';
import { combineRisks } from '../src/utils/math.js';

/** Générateur déterministe (LCG de Numerical Recipes). */
function makeRandom(seed = 12345): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Population représentative : surtout des lancements banals, quelques rugs. */
function population(n: number): FastSnapshot[] {
  const rnd = makeRandom();
  const R = (a: number, b: number) => a + rnd() * (b - a);
  const out: FastSnapshot[] = [];

  for (let i = 0; i < n; i++) {
    const roll = rnd();
    const kind = roll < 0.7 ? 'benign' : roll < 0.92 ? 'suspect' : 'bad';
    const whales =
      kind === 'benign'
        ? []
        : kind === 'suspect'
          ? [Number(R(3.5, 6).toFixed(2))]
          : [Number(R(5, 14).toFixed(2)), Number(R(3.5, 8).toFixed(2))].sort((a, b) => b - a);
    const top10 = kind === 'benign' ? R(5, 22) : kind === 'suspect' ? R(12, 30) : R(25, 60);
    const sameSlot = Math.round(kind === 'benign' ? R(0, 3) : R(2, 8));

    out.push({
      creator: {
        address: 'creator',
        launches24h: kind === 'bad' ? Math.round(R(2, 6)) : kind === 'suspect' ? Math.round(R(1, 2)) : 1,
        devSellsSeen: kind === 'bad' && rnd() < 0.4 ? 1 : 0,
      },
      devBuyPct: kind === 'benign' ? R(0, 3) : kind === 'suspect' ? R(2, 9) : R(8, 25),
      bundle: {
        windowSlots: 2,
        sameSlotBuyers: sameSlot,
        windowBuyers: sameSlot + Math.round(R(0, 6)),
        bundlePct: kind === 'benign' ? R(0, 5) : kind === 'suspect' ? R(4, 15) : R(15, 45),
        devPct: 0,
        cloneGroupSize: kind === 'bad' && rnd() < 0.3 ? 4 : 0,
        cloneGroupSol: 1,
      },
      devSold: kind === 'bad' && rnd() < 0.25,
      concentration: {
        holders: Math.round(kind === 'benign' ? R(8, 200) : R(5, 40)),
        top1Pct: whales[0] ?? R(1, 3),
        top10Pct: top10,
        top1IsDev: false,
        devPct: 0,
        topNonDevPct: whales[0] ?? R(1, 3),
        whalePcts: whales,
      },
      curveProgressPct: kind === 'benign' ? R(1, 60) : R(1, 25),
    });
  }
  return out;
}

const scores = () => population(5_000).map((s) => computeFastScore(s).score);

test('aucune note ne concentre une part écrasante de la population', () => {
  const counts = new Map<number, number>();
  for (const score of scores()) counts.set(score, (counts.get(score) ?? 0) + 1);
  const [value, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
  const share = (n / 5_000) * 100;
  // Historiquement : 58 % à exactement 0, puis 65 % à exactement 100.
  assert.ok(share < 15, `la note ${value} représente ${share.toFixed(1)} % de la population`);
});

test('l’échelle est réellement utilisée sur toute sa longueur', () => {
  const distinct = new Set(scores()).size;
  assert.ok(distinct >= 60, `seulement ${distinct} valeurs distinctes sur 101`);
});

test('les trois niveaux sont tous représentés', () => {
  const all = scores();
  const vert = all.filter((s) => s <= 30).length / all.length;
  const orange = all.filter((s) => s > 30 && s < 70).length / all.length;
  const rouge = all.filter((s) => s >= 70).length / all.length;
  // ORANGE était vide (0,1 %) : une note binaire n'aide à aucune décision.
  assert.ok(orange > 0.08, `ORANGE ne représente que ${(orange * 100).toFixed(1)} %`);
  assert.ok(vert > 0.2 && vert < 0.8, `VERT = ${(vert * 100).toFixed(1)} %`);
  assert.ok(rouge > 0.05, `ROUGE ne représente que ${(rouge * 100).toFixed(1)} %`);
});

test('la note reste monotone : plus de signaux ne peut pas la faire baisser', () => {
  const base: FastSnapshot = {
    creator: { address: 'x', launches24h: 1, devSellsSeen: 0 },
    devBuyPct: 0,
    devSold: false,
    concentration: { holders: 50, top1Pct: 2, top10Pct: 12, top1IsDev: false, devPct: 0, topNonDevPct: 2, whalePcts: [] },
    curveProgressPct: 40,
  };
  const plain = computeFastScore(base).score;
  const withDev = computeFastScore({ ...base, devBuyPct: 12 }).score;
  const withDevAndWhales = computeFastScore({
    ...base,
    devBuyPct: 12,
    concentration: { ...base.concentration!, whalePcts: [6, 4], topNonDevPct: 6, top1Pct: 6 },
  }).score;
  assert.ok(plain < withDev, `${plain} < ${withDev}`);
  assert.ok(withDev < withDevAndWhales, `${withDev} < ${withDevAndWhales}`);
});

test('la gradation suit la maturité du lancement', () => {
  const at = (holders: number, progress: number) =>
    computeFastScore({
      creator: { address: 'x', launches24h: 1, devSellsSeen: 0 },
      devBuyPct: 0,
      devSold: false,
      concentration: { holders, top1Pct: 2, top10Pct: 9, top1IsDev: false, devPct: 0, topNonDevPct: 2, whalePcts: [] },
      curveProgressPct: progress,
    }).score;
  const newborn = at(6, 4);
  const young = at(40, 14);
  const mature = at(200, 70);
  assert.ok(newborn > young && young > mature, `${newborn} > ${young} > ${mature}`);
  // Un lancement neuf mais sans défaut ne doit PAS virer à l'orange : sinon
  // tout le flux des trenches est orange et la note ne sert plus à trier.
  assert.ok(newborn <= 30, `un lancement neuf et propre note ${newborn}`);
});

// ---------------------------------------------------------------------------
// combineRisks
// ---------------------------------------------------------------------------

test('combineRisks : monotone, borné, et ne sature pas', () => {
  assert.equal(combineRisks([]), 0);
  assert.equal(Math.round(combineRisks([40])), 40);
  // Deux signaux à 40 : 64 et non 80 — chacun ne prend qu'une part du reste.
  assert.equal(Math.round(combineRisks([40, 40])), 64);
  // Cinq signaux à 40 : s'approche de 100 sans y coller.
  const five = combineRisks([40, 40, 40, 40, 40]);
  assert.ok(five > 90 && five < 100, `${five}`);
  // Monotonie stricte tant qu'on ajoute des signaux non nuls.
  let previous = 0;
  for (let i = 1; i <= 8; i++) {
    const value = combineRisks(Array.from({ length: i }, () => 25));
    assert.ok(value > previous);
    previous = value;
  }
  // Valeurs aberrantes ignorées ou bornées.
  assert.equal(combineRisks([0, -5, Number.NaN]), 0);
  assert.equal(Math.round(combineRisks([250])), 100);
});
