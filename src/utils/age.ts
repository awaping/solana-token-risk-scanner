/**
 * Durées de vie d'un token, lisibles d'un coup d'œil : « 17 s », « 4 min 05 s »,
 * « 3 h 12 min », « 5 j 4 h ». Module sans dépendance (partagé par le CLI et
 * l'extension, dont le content script n'a pas `process`).
 */
export function formatAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} s`;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (s < 3600) return `${Math.floor(s / 60)} min ${pad(s % 60)} s`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ${pad(Math.floor((s % 3600) / 60))} min`;
  return `${Math.floor(s / 86_400)} j ${Math.floor((s % 86_400) / 3600)} h`;
}

/** Âge du token au moment `at` (ms), en secondes ; undefined si sa création est inconnue. */
export function ageAt(createdAt: number | undefined, at: number): number | undefined {
  return createdAt === undefined ? undefined : Math.max(0, (at - createdAt) / 1000);
}
