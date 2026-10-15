import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_VERSION, compareVersions, repoSlug, updateNotice, checkForUpdate } from '../src/update/check.js';

test('compareVersions ordonne correctement', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.1', '1.0.0'), 1);
  assert.equal(compareVersions('1.1.0', '1.0.9'), 1);
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
  // Le préfixe v est ignoré (les tags GitHub en portent souvent un).
  assert.equal(compareVersions('v1.2.0', '1.2.0'), 0);
  // Versions tronquées.
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
});

test('une pré-publication est antérieure à la stable correspondante', () => {
  // Sinon le scanner proposerait une bêta comme « mise à jour » d'une stable.
  assert.equal(compareVersions('1.2.0-beta.1', '1.2.0'), -1);
  assert.equal(compareVersions('1.2.0', '1.2.0-rc.1'), 1);
  assert.equal(compareVersions('1.2.0-beta.1', '1.2.0-beta.2'), -1);
});

test('repoSlug extrait owner/repo de package.json', () => {
  assert.equal(repoSlug(), 'awaping/solana-token-risk-scanner');
});

test('CURRENT_VERSION vient de package.json', () => {
  assert.match(CURRENT_VERSION, /^\d+\.\d+\.\d+/);
});

test('NO_UPDATE_CHECK coupe toute requête réseau', async () => {
  const previous = process.env.NO_UPDATE_CHECK;
  process.env.NO_UPDATE_CHECK = '1';
  try {
    // Un slug inexistant : si une requête partait, elle échouerait (null aussi),
    // mais le retour doit être immédiat.
    const started = Date.now();
    assert.equal(await checkForUpdate({ slug: 'does-not/exist', force: true }), null);
    assert.ok(Date.now() - started < 100);
  } finally {
    if (previous === undefined) delete process.env.NO_UPDATE_CHECK;
    else process.env.NO_UPDATE_CHECK = previous;
  }
});

test('un dépôt injoignable ne lève jamais', async () => {
  const previous = process.env.NO_UPDATE_CHECK;
  delete process.env.NO_UPDATE_CHECK;
  try {
    assert.equal(await checkForUpdate({ slug: 'awaping/depot-qui-nexiste-pas-xyz', force: true }), null);
  } finally {
    if (previous !== undefined) process.env.NO_UPDATE_CHECK = previous;
  }
});

test('le bandeau contient les deux versions et le lien', () => {
  const line = updateNotice({ current: '1.0.0', latest: '1.1.0', url: 'https://github.com/a/b/releases/tag/v1.1.0' });
  assert.match(line, /1\.0\.0/);
  assert.match(line, /1\.1\.0/);
  assert.match(line, /github\.com/);
});

// ---------------------------------------------------------------------------
// Mise à jour automatique
// ---------------------------------------------------------------------------

import { autoUpdateAndRestart } from '../src/update/apply.js';

test('autoUpdateAndRestart ne fait rien sans AUTO_UPDATE', async () => {
  const previous = process.env.AUTO_UPDATE;
  delete process.env.AUTO_UPDATE;
  try {
    assert.equal(await autoUpdateAndRestart(() => {}), null);
  } finally {
    if (previous !== undefined) process.env.AUTO_UPDATE = previous;
  }
});

test('le marqueur de relance empêche toute boucle', async () => {
  // Sans ce garde-fou, le processus relancé revérifierait et pourrait se
  // relancer à son tour, indéfiniment.
  const before = { auto: process.env.AUTO_UPDATE, flag: process.env.SOL_RISK_UPDATED };
  process.env.AUTO_UPDATE = '1';
  process.env.SOL_RISK_UPDATED = '1';
  try {
    const started = Date.now();
    assert.equal(await autoUpdateAndRestart(() => {}), null);
    // Retour immédiat : aucune requête réseau, aucun sous-processus.
    assert.ok(Date.now() - started < 100);
  } finally {
    if (before.auto === undefined) delete process.env.AUTO_UPDATE;
    else process.env.AUTO_UPDATE = before.auto;
    if (before.flag === undefined) delete process.env.SOL_RISK_UPDATED;
    else process.env.SOL_RISK_UPDATED = before.flag;
  }
});
