// Welcome page shown once, right after installing.
const ES = {
  title: 'VHL Text Overlay está instalada 🎉',
  lead: 'Escriba sobre las páginas de su libro de VHL y copie una imagen de su trabajo. Tres pasos rápidos:',
  s1t: 'Fije el botón',
  s1: 'Arriba a la derecha de Chrome, haga clic en la pieza de puzle 🧩 y luego en la chincheta 📌 junto a <b>VHL Text Overlay</b>. Este botón se quedará allí:',
  s2t: 'Abra su libro',
  s2: 'Entre en reader.vhlcentral.com, abra una página y haga clic en el botón <b>T</b>.',
  s3t: 'Haga el recorrido de un minuto',
  s3: 'La primera vez, un recorrido corto le muestra cada función en la misma página. Puede saltarlo en cualquier momento y volver a verlo con el botón <b>?</b>.',
  toggle: 'Mostrarme el recorrido la primera vez que la use',
  cta: 'Abrir VHL Central →',
};

if (/^es\b/i.test(navigator.language)) {
  document.documentElement.lang = 'es';
  document.title = 'Bienvenido a VHL Text Overlay';
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const t = ES[el.dataset.i18n];
    if (t) el.innerHTML = t;
  }
}

// The switch decides whether the tour starts the first time the toolbars open.
const box = document.getElementById('tour');
chrome.storage.local.get('tutorialPending', (r) => {
  box.checked = r.tutorialPending !== false;
});
box.addEventListener('change', () => chrome.storage.local.set({ tutorialPending: box.checked }));
