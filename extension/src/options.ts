/** Page d'options : réglages persistés et état de mise à jour. */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const DEFAULTS = { rpcUrl: '', holderCensus: false, autoScan: true };

/** Endpoints publics qui répondent 403 à toute requête d'origine navigateur. */
const BROWSER_HOSTILE = /(^|.)api.(mainnet-beta|devnet|testnet).solana.com$/;

/**
 * Demande l'autorisation d'accès à l'endpoint choisi.
 *
 * Le manifest ne déclare pas les hôtes RPC : ils sont choisis par
 * l'utilisateur et inconnus à la compilation. On les demande donc à
 * l'exécution, via optional_host_permissions.
 */
async function requestAccess(rpcUrl: string): Promise<boolean> {
  try {
    const origin = `${new URL(rpcUrl).origin}/*`;
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

void (async () => {
  const settings = await chrome.storage.sync.get(DEFAULTS);
  $<HTMLInputElement>('rpc').value = String(settings.rpcUrl ?? DEFAULTS.rpcUrl);
  $<HTMLInputElement>('census').checked = Boolean(settings.holderCensus);
  $<HTMLInputElement>('auto').checked = settings.autoScan !== false;

  $('save').addEventListener('click', async () => {
    const rpcUrl = $<HTMLInputElement>('rpc').value.trim();
    const status = $('saved');

    if (!rpcUrl) {
      status.textContent = 'un endpoint RPC est requis';
      status.style.color = '#fbbf24';
      status.hidden = false;
      return;
    }
    if (BROWSER_HOSTILE.test(new URL(rpcUrl).hostname)) {
      // Laisser enregistrer cet endpoint garantirait un 403 sur chaque token.
      status.textContent = 'cet endpoint public refuse les navigateurs (403)';
      status.style.color = '#f87171';
      status.hidden = false;
      return;
    }

    await chrome.storage.sync.set({
      rpcUrl,
      holderCensus: $<HTMLInputElement>('census').checked,
      autoScan: $<HTMLInputElement>('auto').checked,
    });
    const granted = await requestAccess(rpcUrl);
    status.textContent = granted ? 'enregistré' : "enregistré (accès à l'hôte refusé)";
    status.style.color = granted ? '#34d399' : '#fbbf24';
    status.hidden = false;
    setTimeout(() => (status.hidden = true), 2_500);
  });

  const response = (await chrome.runtime.sendMessage({ type: 'update' }).catch(() => null)) as
    | { ok: true; state: { current: string; latest?: string; url: string; hasUpdate: boolean } }
    | null;
  const box = $('update');
  if (!response?.ok) {
    box.textContent = 'Mise à jour : vérification impossible (hors ligne ?)';
    return;
  }
  const { current, latest, url, hasUpdate } = response.state;
  box.textContent = '';
  if (hasUpdate) {
    box.append(document.createTextNode(`Version ${current} → ${latest} disponible — `));
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = 'télécharger';
    box.append(link);
  } else {
    box.textContent = `Version ${current} — à jour`;
  }
})();
