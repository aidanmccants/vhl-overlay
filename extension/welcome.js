// Welcome page shown once, right after installing.
const ES = {
  title: 'VHL Text Overlay está instalada',
  lead: 'Escriba sobre las páginas de su libro de VHL y copie o descargue una imagen de su trabajo. Tres pasos rápidos:',
  s1t: 'Fije el botón',
  s1: 'Arriba a la derecha de Chrome, haga clic en la pieza de puzle {{puzzle}} y luego en la chincheta {{pin}} junto a <b>VHL Text Overlay</b>. Este botón se quedará allí:',
  s2t: 'Abra su libro',
  s2: 'Entre en reader.vhlcentral.com, abra una página y haga clic en el botón <b>T</b>.',
  s3t: 'Haga el recorrido de un minuto',
  s3: 'La primera vez, un recorrido corto le muestra cada función en la misma página. Puede saltarlo en cualquier momento y volver a verlo con el botón <b>{{circle-help}}</b>.',
  toggle: 'Mostrarme el recorrido la primera vez que la use',
  cta: 'Abrir VHL Central {{arrow-right}}',
  support: '¿Le resulta útil? {{coffee}} Invíteme a un café',
};

if (/^es\b/i.test(navigator.language)) {
  document.documentElement.lang = 'es';
  document.title = 'Bienvenido a VHL Text Overlay';
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const t = ES[el.dataset.i18n];
    if (t) el.innerHTML = t;
  }
}

// Icons (Lucide, from icons.js): {{name}} in the text becomes that icon.
const ICONS = globalThis.VHL_ICONS || {};
for (const el of document.querySelectorAll('[data-i18n]')) {
  el.innerHTML = el.innerHTML.replace(/\{\{([\w-]+)\}\}/g, (_, n) =>
    `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ''}</svg>`);
}

// The switch decides whether the tour starts the first time the toolbars open.
const box = document.getElementById('tour');
chrome.storage.local.get('tutorialPending', (r) => {
  box.checked = r.tutorialPending !== false;
});
box.addEventListener('change', () => chrome.storage.local.set({ tutorialPending: box.checked }));
