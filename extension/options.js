// Ghost Recorder — Settings logic. Settings stored in chrome.storage.local under "settings".
const DEFAULTS = {
  provider: 'gemini',
  keys: { gemini: '', groq: '', openrouter: '', custom: '', local: '' },
  models: { gemini: 'gemini-3.1-flash-lite', groq: 'llama-3.3-70b-versatile', openrouter: 'google/gemini-2.5-flash', custom: '', local: 'Meta-Llama-3.1-8B-Instruct', chrome_ai: 'gemini-nano' },
  modelHistory: { gemini: [], groq: [], openrouter: [], custom: [], local: [] },
  groqWhisper: 'whisper-large-v3-turbo',
  customBaseUrl: '',
  localSttUrl: 'http://localhost:8000/v1',
  localSttModel: 'whisper-large-v3-turbo',
  localLlmUrl: 'http://localhost:8080/v1',
  localLlmModel: 'Meta-Llama-3.1-8B-Instruct',
  saveFolder: 'Ghost Recordings',
  template: 'general',
  recordMode: 'call',
  language: 'auto',
  videoEnabled: true,
  videoResolution: '1080p',
  videoFps: '30',
  videoCodec: 'vp9',
  videoBitrate: 'auto',
  overlayMode: 'hide_on_video',
  autoSuggest: true,
  consentNote: true,
  email: '',
  emailVia: 'gmail',
  autoEmail: false,
};

const PROVIDER_NAMES = { gemini: 'Gemini', groq: 'Groq', openrouter: 'OpenRouter', local: 'Local AI (llama.cpp / Whisper)', chrome_ai: 'Chrome AI', custom: 'Custom' };
const PROVIDER_INFO = {
  gemini: { key: 'Get a free key at <a href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com/apikey</a>', model: 'e.g. gemini-3.1-flash-lite (default — free & generous) · gemini-2.5-flash · gemini-2.5-pro' },
  groq: { key: 'Get a free key at <a href="https://console.groq.com/keys" target="_blank">consolegroq.com/keys</a>', model: 'e.g. llama-3.3-70b-versatile · openai/gpt-oss-120b' },
  openrouter: { key: 'Get a key at <a href="https://openrouter.ai/keys" target="_blank">openrouter.ai/keys</a>', model: 'any OpenRouter id, e.g. google/gemini-2.5-flash · openai/gpt-4o-mini' },
  local: { key: 'No API key required for local endpoints.', model: 'e.g. Meta-Llama-3.1-8B-Instruct, llama3.2:latest, qwen2.5:7b' },
  chrome_ai: { key: 'Runs 100% on-device inside Chrome. No API key required.', model: 'Gemini Nano (Chrome Built-in AI)' },
  custom: { key: 'Your OpenAI-compatible endpoint key.', model: 'the model id your endpoint expects' },
};

const MODEL_SUGGESTIONS = {
  gemini: ['gemini-3.1-flash-lite', 'gemini-3.1-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'],
  groq: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant'],
  openrouter: ['google/gemini-2.5-flash', 'google/gemini-3.1-flash-lite', 'openai/gpt-4o-mini'],
  local: ['Meta-Llama-3.1-8B-Instruct', 'llama3.2:latest', 'qwen2.5:7b', 'mistral:7b'],
  chrome_ai: ['gemini-nano'],
  custom: [],
};

const $ = (id) => document.getElementById(id);
let state = JSON.parse(JSON.stringify(DEFAULTS));

function applyProviderView() {
  const p = $('provider').value;
  const isLocal = p === 'local';
  const isChromeAi = p === 'chrome_ai';
  const isCustom = p === 'custom';

  $('baseUrlField').classList.toggle('hidden', !isCustom);
  $('modelField').classList.toggle('hidden', isLocal);
  $('localManagerCard').classList.toggle('hidden', !isLocal);
  $('chromeAiCard').classList.toggle('hidden', !isChromeAi);
  $('apiKeyField').classList.toggle('hidden', isChromeAi || isLocal);

  $('keyHint').innerHTML = PROVIDER_INFO[p].key;
  $('modelHint').textContent = PROVIDER_INFO[p].model;
  $('apiKey').value = state.keys[p] || '';
  $('model').value = state.models[p] || DEFAULTS.models[p] || '';
  $('baseUrl').value = state.customBaseUrl || '';

  if (isLocal) {
    $('localSttUrl').value = state.localSttUrl || 'http://localhost:8000/v1';
    $('localSttModel').value = state.localSttModel || 'whisper-large-v3-turbo';
    $('localLlmUrl').value = state.localLlmUrl || 'http://localhost:8080/v1';
    $('localLlmModel').value = state.localLlmModel || 'Meta-Llama-3.1-8B-Instruct';
  }

  const dl = $('modelList');
  if (dl) {
    const hist = (state.modelHistory && state.modelHistory[p]) || [];
    const opts = hist.concat((MODEL_SUGGESTIONS[p] || []).filter((x) => !hist.includes(x)));
    dl.innerHTML = opts.map((x) => `<option value="${x}">`).join('');
  }

  if (isChromeAi) checkChromeAiStatus();
}

function loadLanguageOptions() {
  const sel = $('language');
  if (!sel || !self.GhostI18n) return;
  sel.innerHTML = self.GhostI18n.getLanguageList()
    .map((l) => `<option value="${l.code}">${l.name}</option>`)
    .join('');
}

function load() {
  loadLanguageOptions();
  const sel = $('template');
  if (sel && self.GhostTemplates) {
    sel.innerHTML = '';
    self.GhostTemplates.list.forEach((t) => {
      const o = document.createElement('option'); o.value = t.id; o.textContent = t.label; sel.appendChild(o);
    });
  }

  chrome.storage.local.get('settings', ({ settings }) => {
    const s = settings || {};
    state = Object.assign({}, DEFAULTS, s, {
      keys: Object.assign({}, DEFAULTS.keys, s.keys || {}),
      models: Object.assign({}, DEFAULTS.models, s.models || {}),
      modelHistory: Object.assign({}, DEFAULTS.modelHistory, s.modelHistory || {}),
    });

    $('provider').value = state.provider;
    $('template').value = state.template;
    $('recordMode').value = state.recordMode || 'call';
    $('language').value = state.language || 'auto';
    $('email').value = state.email || '';
    $('saveFolder').value = state.saveFolder || 'Ghost Recordings';
    $('videoEnabled').checked = !!state.videoEnabled;
    $('videoResolution').value = state.videoResolution || '1080p';
    $('videoFps').value = state.videoFps || '30';
    $('videoCodec').value = state.videoCodec || 'vp9';
    $('overlayMode').value = state.overlayMode || 'hide_on_video';
    $('autoSuggest').checked = state.autoSuggest !== false;
    $('autoEmail').checked = !!state.autoEmail;
    $('consentNote').checked = state.consentNote !== false;

    if (self.GhostI18n) {
      self.GhostI18n.setLanguage(state.language);
      self.GhostI18n.translatePage();
    }

    applyProviderView();
    renderConfigured();
  });
}

function renderConfigured() {
  const have = Object.keys(PROVIDER_NAMES).filter((k) => (k === 'local' || k === 'chrome_ai' || (state.keys[k] || '').trim()));
  $('configuredHint').textContent = have.length ? 'Configured providers: ' + have.map((k) => PROVIDER_NAMES[k] + ' ✓').join(', ') : 'No providers ready.';
}

$('revealBtn').addEventListener('click', () => { const i = $('apiKey'); i.type = i.type === 'password' ? 'text' : 'password'; });

// Local Endpoints Presets
$('presetSttWhisper').addEventListener('click', () => { $('localSttUrl').value = 'http://localhost:8000/v1'; });
$('presetSttOllama').addEventListener('click', () => { $('localSttUrl').value = 'http://localhost:11434/v1'; });

$('presetLlmLlamaCpp').addEventListener('click', () => { $('localLlmUrl').value = 'http://localhost:8080/v1'; });
$('presetLlmOllama').addEventListener('click', () => { $('localLlmUrl').value = 'http://localhost:11434/v1'; });
$('presetLlmLmStudio').addEventListener('click', () => { $('localLlmUrl').value = 'http://localhost:1234/v1'; });

// Test Local Endpoints
$('testLocalBtn').addEventListener('click', async () => {
  const sttUrl = $('localSttUrl').value.trim() || 'http://localhost:8000/v1';
  const llmUrl = $('localLlmUrl').value.trim() || 'http://localhost:8080/v1';
  const resEl = $('localTestResult');
  resEl.textContent = 'Testing local endpoints…'; resEl.style.color = '#94a3b8';

  let sttOk = false, llmOk = false, errs = [];

  try {
    const r1 = await fetch(llmUrl.replace(/\/$/, '') + '/models');
    if (r1.ok) llmOk = true; else errs.push(`LLM ${r1.status}`);
  } catch (e) { errs.push(`LLM offline (${e.message})`); }

  try {
    const r2 = await fetch(sttUrl.replace(/\/$/, '') + '/models');
    if (r2.ok) sttOk = true; else errs.push(`STT ${r2.status}`);
  } catch (e) { errs.push(`STT offline (${e.message})`); }

  if (llmOk) {
    save();
    resEl.textContent = `✓ Local LLM connected! ${sttOk ? '(Faster-Whisper STT connected)' : '(STT offline — will use Google Meet/Teams captions)'}`;
    resEl.style.color = '#34d399';
  } else {
    resEl.textContent = `✗ ${errs.join(' · ')}. Make sure llama.cpp / Faster-Whisper is running.`;
    resEl.style.color = '#fca5a5';
  }
});

// Chrome Built-in AI (Gemini Nano)
async function checkChromeAiStatus() {
  const textEl = $('chromeAiStatusText');
  const btn = $('downloadChromeAiBtn');
  if (!textEl || !btn) return;

  const lm = self.ai?.languageModel || self.LanguageModel;
  if (!lm) {
    textEl.innerHTML = '⚠️ Chrome Prompt API is not available. Enable <code>chrome://flags/#prompt-api-for-gemini-nano</code>.';
    btn.classList.add('hidden');
    return;
  }

  try {
    const caps = typeof lm.capabilities === 'function' ? await lm.capabilities() : { available: 'readily' };
    const avail = caps.available || caps;
    if (avail === 'readily' || avail === 'no-issue') {
      textEl.textContent = '✓ Gemini Nano is downloaded and ready to use on-device!';
      textEl.style.color = '#34d399';
      btn.classList.add('hidden');
    } else if (avail === 'after-download') {
      textEl.textContent = 'Gemini Nano is available for download on your device.';
      btn.classList.remove('hidden');
    } else {
      textEl.textContent = `Status: ${avail}. Enable Prompt API in chrome://flags.`;
    }
  } catch (e) {
    textEl.textContent = 'Chrome AI status check error: ' + e.message;
  }
}

$('downloadChromeAiBtn').addEventListener('click', async () => {
  const lm = self.ai?.languageModel || self.LanguageModel;
  const wrap = $('chromeAiProgressWrap');
  const bar = $('chromeAiProgressBar');
  const txt = $('chromeAiProgressText');
  if (!lm) return;

  wrap.classList.remove('hidden');
  txt.textContent = 'Triggering Gemini Nano download…';
  try {
    await lm.create({
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          const pct = Math.round((e.loaded / e.total) * 100);
          txt.textContent = `Downloading Gemini Nano: ${pct}%`;
          bar.style.width = `${pct}%`;
        });
      },
    });
    txt.textContent = '✓ Gemini Nano downloaded and ready!';
    txt.style.color = '#34d399';
    bar.style.width = '100%';
    checkChromeAiStatus();
  } catch (e) {
    txt.textContent = 'Download failed: ' + e.message;
    txt.style.color = '#fca5a5';
  }
});

$('testBtn').addEventListener('click', async () => {
  const p = $('provider').value, key = $('apiKey').value.trim(), base = $('baseUrl').value.trim(), r = $('testResult');
  r.textContent = 'Testing…'; r.style.color = '#94a3b8';
  if (p === 'local' || p === 'chrome_ai') {
    if (p === 'local') {
      $('testLocalBtn').click();
    } else {
      checkChromeAiStatus();
      r.textContent = '✓ Chrome AI selected'; r.style.color = '#34d399';
    }
    return;
  }
  if (!key) { r.textContent = '✗ Enter a key first'; r.style.color = '#fca5a5'; return; }
  let url, headers;
  if (p === 'gemini') { url = 'https://generativelanguage.googleapis.com/v1beta/models'; headers = { 'x-goog-api-key': key }; }
  else if (p === 'groq') { url = 'https://api.groq.com/openai/v1/models'; headers = { Authorization: 'Bearer ' + key }; }
  else if (p === 'openrouter') { url = 'https://openrouter.ai/api/v1/models'; headers = { Authorization: 'Bearer ' + key }; }
  else { if (!base) { r.textContent = '✗ Enter a Base URL'; r.style.color = '#fca5a5'; return; } url = base.replace(/\/$/, '') + '/models'; headers = { Authorization: 'Bearer ' + key }; }
  try {
    const resp = await fetch(url, { headers });
    if (resp.ok) { save(); r.textContent = '✓ Key works — saved'; r.style.color = '#34d399'; }
    else { r.textContent = '✗ ' + resp.status + ' — key rejected'; r.style.color = '#fca5a5'; }
  } catch (e) { r.textContent = '✗ ' + e.message; r.style.color = '#fca5a5'; }
});

$('provider').addEventListener('change', () => {
  const prev = state.provider;
  state.keys[prev] = $('apiKey').value.trim();
  state.models[prev] = $('model').value.trim();
  if (prev === 'custom') state.customBaseUrl = $('baseUrl').value.trim();
  state.provider = $('provider').value;
  applyProviderView();
});

function save() {
  const p = $('provider').value;
  state.provider = p;
  state.keys[p] = $('apiKey').value.trim();
  state.models[p] = $('model').value.trim() || DEFAULTS.models[p];

  if (!state.modelHistory) state.modelHistory = { gemini: [], groq: [], openrouter: [], custom: [], local: [] };
  const mh = state.modelHistory[p] || (state.modelHistory[p] = []);
  if (state.models[p] && !mh.includes(state.models[p])) { mh.unshift(state.models[p]); if (mh.length > 10) mh.pop(); }

  if (p === 'local') {
    state.localSttUrl = $('localSttUrl').value.trim() || 'http://localhost:8000/v1';
    state.localSttModel = $('localSttModel').value;
    state.localLlmUrl = $('localLlmUrl').value.trim() || 'http://localhost:8080/v1';
    state.localLlmModel = $('localLlmModel').value.trim() || 'Meta-Llama-3.1-8B-Instruct';
  } else if (p === 'custom') {
    state.customBaseUrl = $('baseUrl').value.trim();
  }

  state.template = $('template').value;
  state.recordMode = $('recordMode').value;
  state.language = $('language').value;
  state.email = $('email').value.trim();
  state.saveFolder = $('saveFolder').value.trim() || 'Ghost Recordings';
  state.videoEnabled = $('videoEnabled').checked;
  state.videoResolution = $('videoResolution').value;
  state.videoFps = $('videoFps').value;
  state.videoCodec = $('videoCodec').value;
  state.overlayMode = $('overlayMode').value;
  state.autoSuggest = $('autoSuggest').checked;
  state.autoEmail = $('autoEmail').checked;
  state.consentNote = $('consentNote').checked;

  if (self.GhostI18n) {
    self.GhostI18n.setLanguage(state.language);
    self.GhostI18n.translatePage();
  }

  chrome.storage.local.set({ settings: state }, () => {
    const t = $('saved'); t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 1500); renderConfigured();
  });
}
$('save').addEventListener('click', save);

$('language').addEventListener('change', () => {
  const lang = $('language').value;
  if (self.GhostI18n) {
    self.GhostI18n.setLanguage(lang);
    self.GhostI18n.translatePage();
  }
});

$('micBtn').addEventListener('click', async () => {
  $('micMsg').textContent = 'Requesting…'; $('micMsg').style.color = '#94a3b8';
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    $('micMsg').textContent = '✓ Microphone enabled — your voice will be recorded in Call Mode.';
    $('micMsg').style.color = '#34d399';
  } catch (e) {
    $('micMsg').textContent = '✗ Mic blocked: ' + e.message + '. Calls will capture remote audio only.';
    $('micMsg').style.color = '#fca5a5';
  }
});

document.addEventListener('DOMContentLoaded', load);
