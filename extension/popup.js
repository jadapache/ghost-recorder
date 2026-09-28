const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusText = document.getElementById('statusText');
const timer = document.getElementById('timer');
const videoToggle = document.getElementById('videoToggle');
const modeSelect = document.getElementById('modeSelect');
const dashLink = document.getElementById('dashLink');
const settingsLink = document.getElementById('settingsLink');
const openSettingsBtn = document.getElementById('openSettingsBtn');
const meetingsPillBtn = document.getElementById('meetingsPillBtn');

// Settings View elements
const mainView = document.getElementById('mainView');
const settingsView = document.getElementById('settingsView');
const backFromSettingsBtn = document.getElementById('backFromSettingsBtn');
const openFullOptionsBtn = document.getElementById('openFullOptionsBtn');

const quickQualitySelect = document.getElementById('quickQualitySelect');
const quickVideoSelect = document.getElementById('quickVideoSelect');
const quickProviderSelect = document.getElementById('quickProviderSelect');
const quickLangSelect = document.getElementById('quickLangSelect');

let timerInterval = null;

if (dashLink) dashLink.onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') }); };
if (settingsLink) settingsLink.onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: chrome.runtime.getURL('options.html') }); };

// Navigation Links
if (meetingsPillBtn) {
  meetingsPillBtn.onclick = (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  };
}

// View Switching: 3-dots button opens settings view in popup
if (openSettingsBtn) {
  openSettingsBtn.onclick = (e) => {
    e.preventDefault();
    if (mainView && settingsView) {
      mainView.style.display = 'none';
      settingsView.style.display = 'flex';
    }
  };
}

if (backFromSettingsBtn) {
  backFromSettingsBtn.onclick = (e) => {
    e.preventDefault();
    if (mainView && settingsView) {
      settingsView.style.display = 'none';
      mainView.style.display = 'flex';
    }
  };
}

if (openFullOptionsBtn) {
  openFullOptionsBtn.onclick = (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  };
}

// Quick Settings Handlers inside Settings View
if (quickQualitySelect) {
  quickQualitySelect.addEventListener('change', () => {
    chrome.storage.local.get('settings', ({ settings }) => {
      chrome.storage.local.set({ settings: Object.assign({}, settings || {}, { videoQuality: quickQualitySelect.value }) });
    });
  });
}

if (quickVideoSelect) {
  quickVideoSelect.addEventListener('change', () => {
    const isVideo = (quickVideoSelect.value === 'video');
    if (videoToggle) videoToggle.checked = isVideo;
    chrome.storage.local.get('settings', ({ settings }) => {
      chrome.storage.local.set({ settings: Object.assign({}, settings || {}, { videoEnabled: isVideo }) });
    });
  });
}

if (quickProviderSelect) {
  quickProviderSelect.addEventListener('change', () => {
    chrome.storage.local.get('settings', ({ settings }) => {
      chrome.storage.local.set({ settings: Object.assign({}, settings || {}, { provider: quickProviderSelect.value }) });
    });
  });
}

if (quickLangSelect) {
  quickLangSelect.addEventListener('change', () => {
    const newLang = quickLangSelect.value;
    chrome.storage.local.get('settings', ({ settings }) => {
      chrome.storage.local.set({ settings: Object.assign({}, settings || {}, { language: newLang }) }, () => {
        if (self.GhostI18n) {
          self.GhostI18n.setLanguage(newLang);
          self.GhostI18n.translatePage();
        }
      });
    });
  });
}

// Mic status — your voice is recorded in Call Mode if mic is granted.
const micStatus = document.getElementById('micStatus');
function updateMicNotice() {
  if (!micStatus) return;
  if (modeSelect.value === 'system_only') {
    micStatus.innerHTML = '🔊 System audio only mode — mic is disabled';
    micStatus.style.color = '#94a3b8';
    return;
  }
  try {
    navigator.permissions.query({ name: 'microphone' }).then((p) => {
      const render = () => {
        if (p.state === 'granted') { micStatus.innerHTML = '🎤 Mic enabled — your voice is recorded'; micStatus.style.color = '#34d399'; }
        else { micStatus.innerHTML = '🎤 <a href="#" id="micLink" style="color:#fbbf24">Enable mic</a> to record your voice'; const l = document.getElementById('micLink'); if (l) l.onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: chrome.runtime.getURL('options.html') }); }; }
      };
      render(); p.onchange = render;
    }).catch(() => {});
  } catch (e) { /* permissions API unavailable */ }
}

const tabInfo = document.getElementById('tabInfo');
const UNRECORDABLE = /^(chrome|edge|about|devtools|view-source|chrome-extension):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i;
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  chrome.storage.local.get('isRecording', ({ isRecording }) => {
    if (isRecording || !tab) return;
    if (UNRECORDABLE.test(tab.url || '')) {
      tabInfo.textContent = "⚠ This page can't be recorded — open your meeting tab.";
      tabInfo.style.color = '#fbbf24';
      startBtn.disabled = true; startBtn.style.opacity = '.5';
    } else {
      tabInfo.textContent = '⏺ Will record: ' + (tab.title || 'this tab');
      tabInfo.title = tab.title || '';
    }
  });
});

chrome.storage.local.get(['isRecording', 'startTime', 'settings'], (result) => {
  const s = result.settings || {};
  if (self.GhostI18n) {
    self.GhostI18n.setLanguage(s.language || 'auto');
    self.GhostI18n.translatePage();
  }
  if (result.isRecording) { setRecordingUI(); startTimer(result.startTime); }
  else {
    const prov = s.provider || 'gemini';
    const isLocal = prov === 'local' || prov === 'chrome_ai';
    const key = isLocal ? 'local-ok' : (prov === 'custom' ? (s.keys && s.keys.custom) : (s.keys && s.keys[prov]));
    if (!key) {
      statusText.innerHTML = 'First, <a href="#" id="setupLink" style="color:#38bdf8">add your AI key in Settings</a>.';
      const l = document.getElementById('setupLink'); if (l) l.onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: chrome.runtime.getURL('options.html') }); };
    }
  }
  
  const isVideoEnabled = (s.videoEnabled !== false);
  if (videoToggle) videoToggle.checked = isVideoEnabled;
  if (quickVideoSelect) quickVideoSelect.value = isVideoEnabled ? 'video' : 'audio_only';
  if (quickQualitySelect) quickQualitySelect.value = s.videoQuality || '1080p';
  if (quickProviderSelect) quickProviderSelect.value = s.provider || 'gemini';
  if (quickLangSelect) quickLangSelect.value = s.language || 'auto';
  if (modeSelect) modeSelect.value = s.recordMode || 'call';

  updateMicNotice();
});

if (videoToggle) {
  videoToggle.addEventListener('change', () => {
    if (quickVideoSelect) quickVideoSelect.value = videoToggle.checked ? 'video' : 'audio_only';
    chrome.storage.local.get('settings', ({ settings }) => {
      chrome.storage.local.set({ settings: Object.assign({ videoEnabled: true }, settings || {}, { videoEnabled: videoToggle.checked }) });
    });
  });
}

if (modeSelect) {
  modeSelect.addEventListener('change', () => {
    chrome.storage.local.get('settings', ({ settings }) => {
      chrome.storage.local.set({ settings: Object.assign({ recordMode: 'call' }, settings || {}, { recordMode: modeSelect.value }) });
      updateMicNotice();
    });
  });
}

startBtn.onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { statusText.innerText = 'No active tab found'; return; }
  chrome.runtime.sendMessage({ action: 'START_CAPTURE', tabId: tab.id }, (response) => {
    if (response?.success) {
      setRecordingUI();
      const now = Date.now();
      chrome.storage.local.set({ startTime: now });
      startTimer(now);
      if (!response.hasKey && response.provider !== 'local' && response.provider !== 'chrome_ai') {
        statusText.innerHTML = '⚠ Recording — but add your <a href="#" id="setupLink" style="color:#fbbf24">' + (response.provider || 'AI') + ' key in Settings</a> to get notes.';
        const l = document.getElementById('setupLink'); if (l) l.onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: chrome.runtime.getURL('options.html') }); };
      }
    } else {
      statusText.innerText = 'Error: ' + (response?.error || 'Unknown');
    }
  });
};

stopBtn.onclick = () => {
  chrome.runtime.sendMessage({ action: 'STOP_CAPTURE' }, (response) => {
    if (response?.success) { setStoppedUI(); if (timerInterval) clearInterval(timerInterval); }
  });
};

const recRow = document.getElementById('recRow');
const pauseBtn = document.getElementById('pauseBtn');
let popupPaused = false;
pauseBtn.onclick = () => {
  popupPaused = !popupPaused;
  chrome.runtime.sendMessage({ action: popupPaused ? 'PAUSE_CAPTURE' : 'RESUME_CAPTURE' }, () => {
    pauseBtn.textContent = popupPaused ? '▶ Resume' : '⏸ Pause';
    statusText.innerHTML = popupPaused ? '⏸ Paused — nothing is being recorded' : '<span class="pulse"></span> Recording meeting...';
    if (popupPaused) { if (timerInterval) clearInterval(timerInterval); }
    else chrome.storage.local.get('startTime', ({ startTime }) => startTimer(startTime));
  });
};

function setRecordingUI() {
  startBtn.style.display = 'none'; recRow.style.display = 'flex';
  timer.style.display = 'block';
  statusText.innerHTML = '<span class="pulse"></span> Recording meeting...';
}
function setStoppedUI() {
  startBtn.style.display = 'block'; recRow.style.display = 'none';
  timer.style.display = 'none';
  statusText.innerText = 'Recording saved — generating notes…';
}

function startTimer(startTime) {
  if (timerInterval) clearInterval(timerInterval);
  const updateTimer = () => {
    const elapsedSec = Math.floor((Date.now() - (startTime || Date.now())) / 1000);
    const m = Math.floor(elapsedSec / 60); const s = elapsedSec % 60;
    timer.innerText = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };
  updateTimer();
  timerInterval = setInterval(updateTimer, 1000);
}
