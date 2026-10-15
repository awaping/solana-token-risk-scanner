/** Page d'options : réglages persistés et état de mise à jour. */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const DEFAULTS = { rpcUrl: 'https://api.mainnet-beta.solana.com', holderCensus: false, autoScan: true };

void (async () => {
  const settings = await chrome.storage.sync.get(DEFAULTS);
  $<HTMLInputElement>('rpc').value = String(settings.rpcUrl ?? DEFAULTS.rpcUrl);
  $<HTMLInputElement>('census').checked = Boolean(settings.holderCensus);
  $<HTMLInputElement>('auto').checked = settings.autoScan !== false;

  $('save').addEventListener('click', async () => {
    await chrome.storage.sync.set({
      rpcUrl: $<HTMLInputElement>('rpc').value.trim() || DEFAULTS.rpcUrl,
      holderCensus: $<HTMLInputElement>('census').checked,
      autoScan: $<HTMLInputElement>('auto').checked,
    });
    const saved = $('saved');
    saved.hidden = false;
    setTimeout(() => (saved.hidden = true), 1_500);
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
