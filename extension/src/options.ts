/** Page d'options : réglages persistés et état de mise à jour. */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const DEFAULTS = { rpcUrl: '', holderCensus: true, autoScan: true, autoUpdate: true, paperTracking: true };

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
  $<HTMLInputElement>('paper').checked = settings.paperTracking !== false;

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
      paperTracking: $<HTMLInputElement>('paper').checked,
    });
    const granted = await requestAccess(rpcUrl);
    status.textContent = granted ? 'enregistré' : "enregistré (accès à l'hôte refusé)";
    status.style.color = granted ? '#34d399' : '#fbbf24';
    status.hidden = false;
    setTimeout(() => (status.hidden = true), 2_500);
  });

  $('history').addEventListener('click', () => void chrome.tabs.create({ url: chrome.runtime.getURL('history.html') }));

  // --- Hébergeurs de métadonnées -------------------------------------------
  // Les métadonnées d'un token (réseaux sociaux) sont hébergées n'importe où : sans
  // autorisation, Chrome bloque la lecture. Demandée ici car elle exige un clic.
  const ALL_HOSTS = { origins: ['https://*/*'] };
  const allowStatus = $('allow-status');
  const allowAll = $<HTMLButtonElement>('allow-all');
  const showAllow = (granted: boolean) => {
    allowAll.hidden = granted;
    allowStatus.textContent = granted ? 'tous les hébergeurs sont autorisés ✔' : '';
  };
  showAllow(await chrome.permissions.contains(ALL_HOSTS).catch(() => false));
  allowAll.addEventListener('click', async () => {
    const granted = await chrome.permissions.request(ALL_HOSTS).catch(() => false);
    showAllow(granted);
    if (!granted) allowStatus.textContent = 'autorisation refusée';
  });

  // --- Mises à jour --------------------------------------------------------
  type UpdateState = { current: string; latest?: string; url: string; hasUpdate: boolean; helper: 'ready' | 'missing'; autoUpdate: boolean };
  const status = $('update-status');
  const now = $<HTMLButtonElement>('update-now');
  const auto = $<HTMLInputElement>('auto-update');
  const missing = $('helper-missing');

  const show = (text: string, cls = '') => {
    status.textContent = text;
    status.className = cls;
  };

  async function refreshUpdate(): Promise<void> {
    show('vérification…');
    const response = (await chrome.runtime.sendMessage({ type: 'update' }).catch(() => null)) as { ok: true; state: UpdateState } | null;
    if (!response?.ok) {
      show('vérification impossible (hors ligne ?)', 'warn');
      return;
    }
    const state = response.state;
    auto.checked = state.autoUpdate;
    missing.hidden = state.helper === 'ready';
    now.hidden = !(state.hasUpdate && state.helper === 'ready');
    if (state.hasUpdate) show(`version ${state.current} → ${state.latest} disponible`, 'warn');
    else show(`version ${state.current} — à jour`, 'ok');
  }

  now.addEventListener('click', async () => {
    now.disabled = true;
    show('mise à jour en cours…');
    const result = (await chrome.runtime.sendMessage({ type: 'apply-update' }).catch((error: unknown) => ({ ok: false, error: String(error) }))) as {
      ok: boolean;
      from?: string;
      to?: string;
      error?: string;
    };
    if (result.ok && result.to && result.to !== result.from) {
      // L'extension redémarre : cette page se ferme avec elle.
      show(`installée : ${result.from} → ${result.to}. Redémarrage de l'extension…`, 'ok');
    } else if (result.ok) {
      show('déjà à jour', 'ok');
      now.disabled = false;
    } else {
      show(`échec : ${result.error ?? 'erreur inconnue'}`, 'err');
      now.disabled = false;
    }
  });
  $('update-check').addEventListener('click', () => void refreshUpdate());
  auto.addEventListener('change', () => void chrome.storage.sync.set({ autoUpdate: auto.checked }));
  $('copy-setup').addEventListener('click', () => void navigator.clipboard.writeText('npm run setup:updater'));

  await refreshUpdate();
})();
