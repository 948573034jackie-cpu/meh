const modesEl = document.getElementById('modes');
const brightness = document.getElementById('brightness');
const brightnessValue = document.getElementById('brightnessValue');
const siteRow = document.getElementById('siteRow');
const siteName = document.getElementById('siteName');
const siteOff = document.getElementById('siteOff');

let settings = { ...EYECARE_DEFAULTS };
let host = '';

for (const m of EYECARE_MODES) {
  const btn = document.createElement('button');
  btn.className = 'mode';
  btn.dataset.id = m.id;
  btn.setAttribute('role', 'radio');
  btn.innerHTML = `<span class="swatch"><b>Aa</b><span><i></i><i></i></span></span>
    <span class="name"></span><span class="tip"></span>`;
  const swatch = btn.querySelector('.swatch');
  swatch.style.background = m.bg;
  swatch.style.color = m.fg;
  btn.querySelector('.name').textContent = m.name;
  btn.querySelector('.tip').textContent = m.tip;
  btn.addEventListener('click', () => {
    const update = { mode: m.id };
    if (m.id !== 'original') update.lastMode = m.id;
    chrome.storage.sync.set(update);
  });
  modesEl.appendChild(btn);
}

function render() {
  for (const btn of modesEl.children) {
    btn.setAttribute('aria-checked', String(btn.dataset.id === settings.mode));
  }
  brightness.value = settings.brightness;
  brightnessValue.textContent = settings.brightness + '%';
  siteOff.checked = settings.disabledSites.includes(host);
}

brightness.addEventListener('input', () => {
  brightnessValue.textContent = brightness.value + '%';
  chrome.storage.sync.set({ brightness: Number(brightness.value) });
});

siteOff.addEventListener('change', () => {
  const sites = settings.disabledSites.filter((h) => h !== host);
  if (siteOff.checked) sites.push(host);
  chrome.storage.sync.set({ disabledSites: sites });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  for (const [k, { newValue }] of Object.entries(changes)) settings[k] = newValue ?? EYECARE_DEFAULTS[k];
  render();
});

chrome.storage.sync.get(null, (s) => {
  settings = { ...EYECARE_DEFAULTS, ...s };
  render();
});

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  try {
    const url = new URL(tab.url);
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'file:') {
      host = url.hostname;
      siteName.textContent = host || 'local files';
      siteRow.hidden = false;
      render();
    }
  } catch (e) {}
});
