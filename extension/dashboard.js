// Ghost Recorder — Meetings app (Fathom/Meetily-style redesign):
// Left panel: Collapsible 5-item menu (Home, AI chat, Screen recordings, Meetings, Settings)
// Main area: Home view with stats & mic recorder, Meetings view with grid layout & search, Detail view with video player + summary + transcript/insights/chat tabs

let meetings = [];
let selectedId = null;
let mediaUrl = null;          // active blob: URL (revoked on selection change)
let activeView = 'home';      // 'home' | 'meetings' | 'chat'
let rightTab = 'transcript';  // 'transcript' | 'insights' | 'chat'
let searchQ = '';             // search meetings query
let transcriptSearchQ = '';   // search inside current meeting transcript
let transcriptLang = 'es';    // transcript language dropdown
const chats = {};             // chat history per scope key (meeting id or '::all')
let askBusy = false;

// ---- IndexedDB (shared with offscreen.js: db "ghost", store "pending") ----
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('ghost', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('pending', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(id) {
  const db = await idb();
  return new Promise((res) => {
    const rq = db.transaction('pending', 'readonly').objectStore('pending').get(id);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => res(null);
  });
}
async function idbPut(v) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('pending', 'readwrite');
    tx.objectStore('pending').put(v);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}
async function idbDel(id) {
  const db = await idb();
  return new Promise((res) => {
    const tx = db.transaction('pending', 'readwrite');
    tx.objectStore('pending').delete(id);
    tx.oncomplete = res;
    tx.onerror = res;
  });
}

function load() {
  chrome.storage.local.get(['meetings', 'settings'], ({ meetings: m, settings: s }) => {
    meetings = m || [];
    if (self.GhostI18n) {
      self.GhostI18n.setLanguage((s && s.language) || 'auto');
      self.GhostI18n.translatePage();
    }
    if (s && s.language && s.language !== 'auto') {
      transcriptLang = s.language;
    }
    render();
  });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Minimal markdown renderer (headings, bold, bullets, numbered, links, pipe tables).
function renderMarkdown(md) {
  const lines = (md || '').split('\n');
  let html = '', i = 0;
  const inline = (t) => esc(t)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)_([^_]+)_(?=\s|[.,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  while (i < lines.length) {
    const line = lines[i];
    if (/^>\s?/.test(line)) {
      let q = '';
      while (i < lines.length && /^>\s?/.test(lines[i])) { q += (q ? '<br>' : '') + inline(lines[i].replace(/^>\s?/, '')); i++; }
      html += `<blockquote>${q}</blockquote>`; continue;
    }
    if (/^###\s+/.test(line)) { html += `<h3>${inline(line.replace(/^###\s+/, ''))}</h3>`; i++; continue; }
    if (/^##\s+/.test(line)) { html += `<h2>${inline(line.replace(/^##\s+/, ''))}</h2>`; i++; continue; }
    if (/^#\s+/.test(line)) { html += `<h2>${inline(line.replace(/^#\s+/, ''))}</h2>`; i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(lines[i]); i++; }
      const cells = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      let t = '<table>';
      rows.forEach((r, ri) => {
        if (/^\s*\|[\s:|-]+\|\s*$/.test(r)) return;
        const tag = ri === 0 ? 'th' : 'td';
        t += '<tr>' + cells(r).map((c) => `<${tag}>${inline(c)}</${tag}>`).join('') + '</tr>';
      });
      html += t + '</table>';
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      let li = '';
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { li += `<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`; i++; }
      html += `<ol>${li}</ol>`; continue;
    }
    if (/^\s*[-*]\s*\[([ xX])\]\s*(.*)$/.test(line)) {
      let li = '';
      while (i < lines.length && /^\s*[-*]\s*\[([ xX])\]\s*(.*)$/.test(lines[i])) {
        const m = lines[i].match(/^\s*[-*]\s*\[([ xX])\]\s*(.*)$/);
        const checked = m[1].toLowerCase() === 'x' ? 'checked' : '';
        li += `<li><input type="checkbox" ${checked} disabled> ${inline(m[2])}</li>`;
        i++;
      }
      html += `<ul style="list-style:none;padding-left:4px">${li}</ul>`; continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      let li = '';
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { li += `<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`; i++; }
      html += `<ul>${li}</ul>`; continue;
    }
    if (line.trim() === '') { i++; continue; }
    html += `<p>${inline(line)}</p>`;
    i++;
  }
  return html;
}

// ---- Notes & Transcript Helpers ----
const TS_RE = /^\s*(?:\*\*)?\[?(\d{1,2}):(\d{2})(?::(\d{2}))?\]?(?:\*\*)?\s*(?:(?:\*\*)?([^:*]{1,40}?)(?:\*\*)?\s*:)?\s*(.*)$/;
function splitNotes(notes) {
  const parts = (notes || '').split(/(?=##\s*Full Transcript)/i);
  return { summary: parts[0] || '', transcript: parts.slice(1).join('').replace(/^##\s*Full Transcript\s*/i, '').trim() };
}

function attendeesOf(notes) {
  const { transcript } = splitNotes(notes);
  const names = new Set();
  transcript.split('\n').forEach((l) => {
    const m = TS_RE.exec(l);
    if (m && m[4]) names.add(m[4].trim().replace(/\*\*/g, ''));
  });
  return [...names].slice(0, 12);
}

function badge(state) {
  const s = state || 'unknown';
  const label = { recording: 'RECORDING', processing: 'PROCESSING…', done: 'READY', error: 'FAILED' }[s] || s.toUpperCase();
  return `<span class="tag tag-${s}">${label}</span>`;
}

function localDate(iso) {
  try {
    return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    return (iso || '').replace('T', ' ').slice(0, 16);
  }
}

function friendlyError(err) {
  const e = String(err || 'AI processing failed.');
  let fix = '';
  if (/RECOVERED/i.test(e)) fix = '';
  else if (/401|403|API key|unauthorized|invalid.*key|permission/i.test(e)) fix = 'Your API key was rejected — open Settings, re-paste the key and press Test.';
  else if (/429|rate|quota|overloaded|exhausted/i.test(e)) fix = 'The AI provider is busy or rate-limited — wait a minute, then press Retry.';
  else if (/413|too large|exceed|payload/i.test(e)) fix = 'The recording is too large for this provider — switch to Gemini in Settings, then Retry.';
  else if (/network|fetch|failed to fetch|timeout/i.test(e)) fix = 'Network problem reaching the AI provider — check your connection, then Retry.';
  return { fix, raw: e };
}

// Reusable Custom Modal (Confirm / Prompt)
function showModal({ title = '', message = '', inputVal = null, placeholder = '', confirmText = 'Confirmar', cancelText = 'Cancelar', isDanger = false }) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('modalOverlay');
    const titleEl = document.getElementById('modalTitle');
    const bodyEl = document.getElementById('modalBody');
    const inputWrap = document.getElementById('modalInputWrap');
    const inputEl = document.getElementById('modalInput');
    const confirmBtn = document.getElementById('modalConfirmBtn');
    const cancelBtn = document.getElementById('modalCancelBtn');

    titleEl.textContent = title;
    bodyEl.textContent = message;
    bodyEl.style.display = message ? 'block' : 'none';

    if (inputVal !== null) {
      inputWrap.style.display = 'block';
      inputEl.value = inputVal;
      inputEl.placeholder = placeholder;
    } else {
      inputWrap.style.display = 'none';
      inputEl.value = '';
    }

    confirmBtn.textContent = confirmText;
    confirmBtn.className = isDanger ? 'btn danger' : 'btn';
    cancelBtn.textContent = cancelText;

    const cleanup = () => {
      overlay.classList.remove('active');
      document.removeEventListener('keydown', onKeyDown);
      confirmBtn.onclick = null;
      cancelBtn.onclick = null;
      overlay.onclick = null;
    };

    const confirmAction = () => {
      const result = inputVal !== null ? inputEl.value.trim() : true;
      cleanup();
      resolve(result);
    };

    const cancelAction = () => {
      cleanup();
      resolve(inputVal !== null ? null : false);
    };

    const onKeyDown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        confirmAction();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelAction();
      }
    };

    confirmBtn.onclick = confirmAction;
    cancelBtn.onclick = cancelAction;
    overlay.onclick = (e) => {
      if (e.target === overlay) cancelAction();
    };

    document.addEventListener('keydown', onKeyDown);
    overlay.classList.add('active');

    if (inputVal !== null) {
      setTimeout(() => {
        inputEl.focus();
        inputEl.select();
      }, 50);
    } else {
      setTimeout(() => confirmBtn.focus(), 50);
    }
  });
}

// Complete deletion from IDB + storage
async function removeMeeting(id) {
  const sid = String(id).trim();
  try {
    await idbDel(sid);
    await idbDel('live-' + sid);
  } catch (e) {
    console.warn('[dashboard] idbDel failed:', e);
  }

  try {
    const data = await new Promise((res) => chrome.storage.local.get('meetings', res));
    const currentList = data.meetings || [];
    const updated = currentList.filter((x) => String(x.id).trim() !== sid);
    await new Promise((res) => chrome.storage.local.set({ meetings: updated }, res));
    await new Promise((res) => chrome.storage.local.remove('caps-' + sid, res));
    meetings = updated;
  } catch (e) {
    console.error('[dashboard] storage delete failed:', e);
  }

  chrome.runtime.sendMessage({ action: 'DELETE_MEETING', meetingId: sid }).catch(() => {});

  if (String(selectedId).trim() === sid) {
    selectedId = null;
    activeView = 'meetings';
  }
  render();
}

// =============================================================== RENDER PIPELINE
function render() {
  const detail = document.getElementById('detail');
  if (!detail) return;

  const m = meetings.find((x) => x.id === selectedId);
  detail.classList.toggle('fixed', !live && !!m);

  if (live) { renderLive(detail); return; }

  // If no meeting selected, render active main view (Home, Meetings grid, or AI chat)
  if (!m) {
    if (activeView === 'home') {
      renderHome(detail);
    } else if (activeView === 'chat') {
      chats.scope = 'all';
      renderChatPane(null, detail);
    } else {
      renderMeetingsGrid(detail);
    }
    return;
  }

  // Meeting Detail View Layout
  const presenter = (m.meta && m.meta.author) || 'Daniel Andres';
  const metaParts = [
    presenter,
    localDate(m.date),
    m.duration && m.duration !== 'Unknown' ? m.duration : '',
    m.platform || 'Meetings'
  ].filter(Boolean);

  const currentTpl = (m.settings && m.settings.template) || (m.template) || 'general';
  const tplList = (self.GhostTemplates ? self.GhostTemplates.list : [
    { id: 'general', label: 'General meeting' },
    { id: 'sales', label: 'Sales / discovery call' },
    { id: 'one_on_one', label: '1:1 / Standup' }
  ]);
  const tplOptsHtml = tplList.map((t) => `<option value="${t.id}" ${t.id === currentTpl ? 'selected' : ''}>${esc(t.label)}</option>`).join('');

  detail.innerHTML = `
    <!-- Left Column: Back button, Video Preview & Summary/Resume Below -->
    <div class="mv-left">
      <div class="back-bar">
        <button class="btn ghost mini" id="backToGridBtn">← Back to meetings</button>
      </div>

      <div id="player"></div>

      <div class="mtg-title-row">
        <h1 class="mtg-title">${esc(m.title || m.id)}</h1>
        <div class="mtg-title-actions">
          <button class="btn-icon" id="renameBtn" title="Rename meeting">✎</button>
          <button class="btn-icon" id="deleteBtn" title="Delete recording">🗑</button>
        </div>
      </div>

      <div class="mtg-meta">
        ${metaParts.map((p, idx) => `<span>${esc(p)}</span>${idx < metaParts.length - 1 ? '<span class="dot">•</span>' : ''}`).join('')}
      </div>

      <div class="tpl-bar">
        <div class="tpl-pill">
          <span class="tpl-label">Template:</span>
          <select id="tplSelect" class="tpl-select">
            ${tplOptsHtml}
          </select>
        </div>
        <div class="tpl-actions">
          <button class="btn-icon" id="formatToggleBtn" title="Toggle bullet formatting">≡</button>
          <button class="btn-icon" id="copySumBtn" title="Copy summary">⧉</button>
          <button class="btn-icon" id="emailSumBtn" title="Email notes">✉</button>
          ${(m.files && (m.files.video || m.files.audio || m.files.notes || m.files.vtt || m.files.transcript)) ? `<button class="btn-icon" id="folderBtn" title="Show files in folder">📁</button>` : ''}
          ${m.state === 'error' ? `<button class="btn retry mini" id="retryAiBtn">↻ Retry AI</button>` : ''}
        </div>
      </div>

      <!-- Resume / Summary Content Area -->
      <div id="resumeArea">
        ${renderResumeBlock(m)}
      </div>
    </div>

    <!-- Right Column: Navigation Tabs & Feed -->
    <div class="mv-right">
      <div class="rtabs">
        <button class="rtab ${rightTab === 'transcript' ? 'active' : ''}" data-tab="transcript">Transcript</button>
        <button class="rtab ${rightTab === 'insights' ? 'active' : ''}" data-tab="insights">Insights</button>
        <button class="rtab ${rightTab === 'chat' ? 'active' : ''}" data-tab="chat">AI chat</button>
      </div>
      <div id="rightTabContent"></div>
    </div>`;

  detail.querySelectorAll('.rtab').forEach((btn) => {
    btn.onclick = () => {
      rightTab = btn.dataset.tab;
      detail.querySelectorAll('.rtab').forEach((b) => b.classList.toggle('active', b === btn));
      renderRightContent(m);
    };
  });

  setupLeftColumnActions(m);
  renderRightContent(m);
  attachMedia(m);
}

// Render Left Panel Resume / Notes Block
function renderResumeBlock(m) {
  if (m.state === 'processing') {
    return `
      <div class="notes-loading">
        <div class="loading-label"><span class="spinner" style="border-color:rgba(0,0,0,.15);border-top-color:var(--acc);"></span> Generating notes...</div>
        <div class="skeleton-wrap">
          <div class="sk-bar sk-w-100"></div>
          <div class="sk-bar sk-w-90"></div>
          <div class="sk-bar sk-w-95"></div>
          <div class="sk-bar sk-w-85"></div>
          <div class="sk-bar sk-w-60"></div>
        </div>
      </div>`;
  }

  if (m.state === 'recording') {
    return `
      <div class="notes-loading">
        <div class="loading-label"><span style="color:#ef4444">●</span> Recording in progress…</div>
        <div class="skeleton-wrap">
          <div class="sk-bar sk-w-100"></div>
          <div class="sk-bar sk-w-90"></div>
        </div>
      </div>`;
  }

  if (m.state === 'error') {
    const fe = friendlyError(m.error);
    return `
      <div class="err">
        ${fe.fix ? `<strong>${esc(fe.fix)}</strong><br><br>` : ''}
        ${esc(fe.raw)}
      </div>`;
  }

  if (m.notes) {
    const { summary } = splitNotes(m.notes);
    let warn = (m.warnings && m.warnings.length) ? `<div class="warn">⚠ ${m.warnings.map(esc).join('<br>⚠ ')}</div>` : '';
    if (m.saveError) warn += `<div class="warn">⚠ ${esc(m.saveError)}</div>`;
    return `${warn}<div class="notes" id="notesMarkdown">${renderMarkdown(summary)}</div>`;
  }

  return `<div class="empty" style="margin-top:30px">No notes generated yet.</div>`;
}

// Setup Left Column Actions
function setupLeftColumnActions(m) {
  const isEs = self.GhostI18n && self.GhostI18n.currentLanguage === 'es';

  // Back to meetings button
  const backBtn = document.getElementById('backToGridBtn');
  if (backBtn) {
    backBtn.onclick = () => {
      selectedId = null;
      activeView = 'meetings';
      render();
    };
  }

  // Rename modal
  const renameBtn = document.getElementById('renameBtn');
  if (renameBtn) {
    renameBtn.onclick = async () => {
      const newTitle = await showModal({
        title: isEs ? 'Renombrar reunión' : 'Rename meeting',
        inputVal: m.title || '',
        placeholder: isEs ? 'Nombre de la reunión' : 'Meeting title',
        confirmText: isEs ? 'Guardar' : 'Save',
        cancelText: isEs ? 'Cancelar' : 'Cancel'
      });
      if (newTitle && newTitle.trim()) {
        chrome.runtime.sendMessage({ action: 'RENAME_MEETING', meetingId: m.id, title: newTitle.trim() });
        m.title = newTitle.trim();
        render();
      }
    };
  }

  // Delete modal
  const deleteBtn = document.getElementById('deleteBtn');
  if (deleteBtn) {
    deleteBtn.onclick = async () => {
      const confirmed = await showModal({
        title: isEs ? 'Eliminar grabación' : 'Delete recording',
        message: isEs
          ? '¿Estás seguro de que deseas eliminar esta reunión del listado?\n\nLos archivos ya guardados en tu carpeta de Descargas (.webm, .md, .vtt) se conservarán.'
          : 'Are you sure you want to remove this meeting from the list?\n\nFiles already saved in your Downloads folder (.webm, .md, .vtt) will be kept.',
        confirmText: isEs ? 'Eliminar' : 'Delete',
        cancelText: isEs ? 'Cancelar' : 'Cancel',
        isDanger: true
      });
      if (confirmed) {
        removeMeeting(m.id);
      }
    };
  }

  // Template select
  const tplSelect = document.getElementById('tplSelect');
  if (tplSelect) {
    tplSelect.onchange = () => {
      const tpl = tplSelect.value;
      chrome.runtime.sendMessage({ action: 'RETRY_NOTES', meetingId: m.id, template: tpl });
      m.state = 'processing';
      render();
    };
  }

  // Copy summary
  const copySumBtn = document.getElementById('copySumBtn');
  if (copySumBtn) {
    copySumBtn.onclick = () => {
      if (!m.notes) return;
      navigator.clipboard.writeText(splitNotes(m.notes).summary).then(() => {
        copySumBtn.textContent = '✓';
        setTimeout(() => { copySumBtn.textContent = '⧉'; }, 1600);
      });
    };
  }

  // Email notes
  const emailSumBtn = document.getElementById('emailSumBtn');
  if (emailSumBtn) {
    emailSumBtn.onclick = () => {
      chrome.runtime.sendMessage({ action: 'EMAIL_NOTES', meetingId: m.id }, (r) => {
        if (r && r.error === 'no-email') {
          showModal({
            title: isEs ? 'Correo no configurado' : 'No email configured',
            message: isEs ? 'Configura tu correo en Ajustes para enviar notas automáticamente.' : 'Configure your email in Settings to send notes automatically.',
            confirmText: 'OK'
          });
        } else {
          emailSumBtn.textContent = '✓';
          setTimeout(() => { emailSumBtn.textContent = '✉'; }, 1600);
        }
      });
    };
  }

  // Show in folder
  const folderBtn = document.getElementById('folderBtn');
  if (folderBtn && m.files) {
    folderBtn.onclick = () => {
      const f = m.files;
      const any = f.notes || f.video || f.audio || f.vtt || f.transcript;
      if (any) {
        if (typeof any === 'object' && any.downloadId) chrome.downloads.show(any.downloadId);
        else if (typeof any === 'number') chrome.downloads.show(any);
        else if (typeof any === 'string') chrome.downloads.search({ query: [any] }, (items) => { if (items && items[0]) chrome.downloads.show(items[0].id); });
      }
    };
  }

  // Retry AI
  const retryAiBtn = document.getElementById('retryAiBtn');
  if (retryAiBtn) {
    retryAiBtn.onclick = () => {
      retryAiBtn.disabled = true;
      retryAiBtn.textContent = '↻ Retrying…';
      chrome.runtime.sendMessage({ action: 'RETRY_NOTES', meetingId: m.id });
    };
  }
}

// =============================================================== RIGHT PANEL RENDERERS
function renderRightContent(m) {
  const container = document.getElementById('rightTabContent');
  if (!container) return;

  if (rightTab === 'transcript') {
    renderTranscriptPane(m, container);
  } else if (rightTab === 'insights') {
    renderInsightsPane(m, container);
  } else if (rightTab === 'chat') {
    renderChatPane(m, container);
  }
}

// ---- Speaker Dialogue Turn Parser ----
function parseSpeakerTurns(text) {
  const turns = [];
  let currentTurn = null;
  const lines = (text || '').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line) continue;

    const spkOnlyMatch = line.match(/^(?:\*\*)?Speaker\s*[:\-]?\s*([A-Za-z0-9_\- ]+?)(?:\*\*)?:?$/i);
    if (spkOnlyMatch) {
      const spkName = 'Speaker: ' + spkOnlyMatch[1].trim();
      currentTurn = { speaker: spkName, cues: [] };
      turns.push(currentTurn);
      continue;
    }

    const tsSpkMatch = line.match(/^(?:\*\*)?\[?(\d{1,2}):(\d{2})(?::(\d{2}))?\]?(?:\*\*)?\s*(?:(?:\*\*)?([^:*]{1,40}?)(?:\*\*)?\s*:)?\s*(.*)$/);
    if (tsSpkMatch && (tsSpkMatch[4] || tsSpkMatch[5])) {
      const secs = tsSpkMatch[3] != null ? (+tsSpkMatch[1]) * 3600 + (+tsSpkMatch[2]) * 60 + (+tsSpkMatch[3]) : (+tsSpkMatch[1]) * 60 + (+tsSpkMatch[2]);
      const stamp = tsSpkMatch[3] != null ? `${tsSpkMatch[1]}:${tsSpkMatch[2]}:${tsSpkMatch[3]}` : `${tsSpkMatch[1]}:${tsSpkMatch[2]}`;
      let spk = tsSpkMatch[4] ? tsSpkMatch[4].trim().replace(/\*\*/g, '') : null;
      const textPart = (tsSpkMatch[5] || '').trim();

      if (spk) {
        if (!/^speaker/i.test(spk)) spk = 'Speaker: ' + spk;
        else if (!/^speaker\s*:/i.test(spk)) spk = spk.replace(/^speaker\s*/i, 'Speaker: ');
      }

      if (!currentTurn || (spk && currentTurn.speaker !== spk)) {
        currentTurn = { speaker: spk || (turns.length ? turns[turns.length - 1].speaker : 'Speaker: A'), cues: [] };
        turns.push(currentTurn);
      }
      currentTurn.cues.push({ startSec: secs, stamp, text: textPart });
      continue;
    }

    const colonMatch = line.match(/^([^:]{1,30}):\s*(.*)$/);
    if (colonMatch && !/^\d+$/.test(colonMatch[1])) {
      let spk = colonMatch[1].trim();
      if (!/^speaker/i.test(spk)) spk = 'Speaker: ' + spk;
      else if (!/^speaker\s*:/i.test(spk)) spk = spk.replace(/^speaker\s*/i, 'Speaker: ');
      currentTurn = { speaker: spk, cues: [] };
      turns.push(currentTurn);
      if (colonMatch[2].trim()) {
        currentTurn.cues.push({ startSec: 0, stamp: '', text: colonMatch[2].trim() });
      }
      continue;
    }

    if (!currentTurn) {
      currentTurn = { speaker: 'Speaker: A', cues: [] };
      turns.push(currentTurn);
    }
    currentTurn.cues.push({ startSec: 0, stamp: '', text: line });
  }

  return turns;
}

// ---- Transcript Tab ----
async function renderTranscriptPane(m, container) {
  let transcript = splitNotes(m.notes).transcript;
  if (!transcript && m.captions) transcript = m.captions;
  if (!transcript) {
    const rec = await idbGet(m.id);
    if (rec && rec.captions) transcript = rec.captions;
  }

  if (!transcript) {
    container.innerHTML = `
      <div class="empty" style="margin-top:40px">
        No transcript yet${m.state === 'processing' ? ' — AI is still working.' : '.'}
      </div>`;
    return;
  }

  const safeTitle = (m.title || 'meeting').replace(/[/\\?%*:|"<>]/g, '-').slice(0, 50);

  container.innerHTML = `
    <div class="tr-tools">
      <div class="tr-search-wrap">
        <input type="text" class="tr-search-input" id="trSearchInput" placeholder="Search transcript" value="${esc(transcriptSearchQ)}">
        <span class="tr-search-icon">🔍</span>
      </div>
      <select class="tr-lang-select" id="trLangSelect">
        <option value="es" ${transcriptLang === 'es' ? 'selected' : ''}>Spanish ▾</option>
        <option value="en" ${transcriptLang === 'en' ? 'selected' : ''}>English ▾</option>
        <option value="auto" ${transcriptLang === 'auto' ? 'selected' : ''}>Auto ▾</option>
        <option value="fr" ${transcriptLang === 'fr' ? 'selected' : ''}>French ▾</option>
        <option value="de" ${transcriptLang === 'de' ? 'selected' : ''}>German ▾</option>
        <option value="pt" ${transcriptLang === 'pt' ? 'selected' : ''}>Portuguese ▾</option>
      </select>
      <button class="btn-icon" id="copyTrBtn" title="Copy transcript">⧉</button>
      <button class="btn ghost mini" id="dlTxtTr" title="Download .txt">.txt</button>
      <button class="btn ghost mini" id="dlVttTr" title="Download subtitles">.vtt</button>
    </div>

    <div class="transcript-feed" id="transcriptFeed">
      ${buildTurnsHtml(transcript, transcriptSearchQ)}
    </div>`;

  const sIn = document.getElementById('trSearchInput');
  if (sIn) {
    sIn.oninput = (e) => {
      transcriptSearchQ = e.target.value;
      const feed = document.getElementById('transcriptFeed');
      if (feed) feed.innerHTML = buildTurnsHtml(transcript, transcriptSearchQ);
      hookCueSeek();
    };
  }

  const lSel = document.getElementById('trLangSelect');
  if (lSel) {
    lSel.onchange = (e) => {
      transcriptLang = e.target.value;
    };
  }

  const copyBtn = document.getElementById('copyTrBtn');
  if (copyBtn) {
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(transcript).then(() => {
        copyBtn.textContent = '✓';
        setTimeout(() => { copyBtn.textContent = '⧉'; }, 1600);
      });
    };
  }

  document.getElementById('dlTxtTr').onclick = () => {
    downloadBlob(`${safeTitle}-transcript.txt`, transcript, 'text/plain');
  };
  document.getElementById('dlVttTr').onclick = () => {
    const vtt = transcriptToVtt(transcript);
    downloadBlob(`${safeTitle}-captions.vtt`, vtt, 'text/vtt');
  };

  hookCueSeek();
}

function buildTurnsHtml(transcriptText, searchFilter) {
  const turns = parseSpeakerTurns(transcriptText);
  const q = (searchFilter || '').toLowerCase().trim();

  const filteredTurns = turns.filter((turn) => {
    if (!q) return true;
    if (turn.speaker.toLowerCase().includes(q)) return true;
    return turn.cues.some((c) => c.text.toLowerCase().includes(q));
  });

  if (!filteredTurns.length) {
    return `<div class="empty" style="margin-top:24px">No dialogue lines match "${esc(searchFilter)}"</div>`;
  }

  return filteredTurns.map((turn) => `
    <div class="spk-block">
      <div class="spk-header">${esc(turn.speaker)}</div>
      <div class="spk-cues">
        ${turn.cues.map((cue) => {
          const words = (cue.text || '').split(' ');
          const firstWord = words[0] || '';
          const restWords = words.slice(1).join(' ');
          const formattedRest = q
            ? restWords.replace(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark style="background:#fef08a;color:#854d0e;padding:0 2px;border-radius:2px">$1</mark>')
            : esc(restWords);

          return `
            <div class="cue-row" data-start="${cue.startSec}" title="${cue.stamp ? 'Jump to ' + cue.stamp : ''}">
              ${cue.stamp ? `<span class="cue-ts">${esc(cue.stamp)}</span>` : ''}
              <span class="cue-active-badge">${esc(firstWord)}</span> <span class="cue-text">${formattedRest}</span>
            </div>`;
        }).join('')}
      </div>
    </div>`).join('');
}

function hookCueSeek() {
  document.querySelectorAll('.cue-row').forEach((row) => {
    row.onclick = () => {
      const sec = parseFloat(row.dataset.start);
      const media = document.getElementById('media');
      if (media && !isNaN(sec)) {
        media.currentTime = sec;
        media.play().catch(() => {});
      }
      document.querySelectorAll('.cue-row.active').forEach((x) => x.classList.remove('active'));
      row.classList.add('active');
    };
  });
}

function syncActiveTranscriptCue(curTime) {
  const cues = document.querySelectorAll('.cue-row[data-start]');
  if (!cues.length) return;

  let activeCue = null;
  for (let i = 0; i < cues.length; i++) {
    const startSec = parseFloat(cues[i].dataset.start) || 0;
    if (startSec <= curTime + 0.35) {
      activeCue = cues[i];
    } else {
      break;
    }
  }

  cues.forEach((c) => {
    if (c === activeCue) {
      if (!c.classList.contains('active')) {
        c.classList.add('active');
        const container = document.getElementById('rightTabContent');
        if (container && !container.matches(':hover')) {
          const cTop = c.offsetTop - container.offsetTop;
          if (cTop < container.scrollTop || cTop > container.scrollTop + container.clientHeight - 80) {
            container.scrollTo({ top: Math.max(0, cTop - 60), behavior: 'smooth' });
          }
        }
      }
    } else {
      c.classList.remove('active');
    }
  });
}

// ---- Insights Tab ----
function renderInsightsPane(m, container) {
  const notes = m.notes || '';
  const lines = notes.split('\n');

  const actionItems = [];
  let inAction = false;
  for (const line of lines) {
    if (/^#{1,3}\s*(action|next step|to-?do|tareas)/i.test(line)) { inAction = true; continue; }
    if (inAction && /^#{1,3}\s+/.test(line)) { inAction = false; }
    const chk = line.match(/^[-*]\s*\[([ xX])\]\s*(.*)$/);
    if (chk) {
      actionItems.push({ done: chk[1].toLowerCase() === 'x', text: chk[2] });
    } else if (inAction && /^[-*]\s+(.*)$/.test(line)) {
      actionItems.push({ done: false, text: line.replace(/^[-*]\s+/, '') });
    }
  }

  const decisions = [];
  let inDec = false;
  for (const line of lines) {
    if (/^#{1,3}\s*(decision|acuerdos)/i.test(line)) { inDec = true; continue; }
    if (inDec && /^#{1,3}\s+/.test(line)) { inDec = false; }
    if (inDec && /^[-*]\s+(.*)$/.test(line)) decisions.push(line.replace(/^[-*]\s+/, ''));
  }

  const keyPoints = [];
  let inKp = false;
  for (const line of lines) {
    if (/^#{1,3}\s*(key point|puntos clave|takeaway)/i.test(line)) { inKp = true; continue; }
    if (inKp && /^#{1,3}\s+/.test(line)) { inKp = false; }
    if (inKp && /^[-*]\s+(.*)$/.test(line)) keyPoints.push(line.replace(/^[-*]\s+/, ''));
  }

  const att = notes ? attendeesOf(notes) : [];

  container.innerHTML = `
    <div class="insights-pane">
      <div class="insight-card">
        <div class="insight-header">📌 Action Items</div>
        ${actionItems.length ? actionItems.map((item, idx) => `
          <div class="action-row ${item.done ? 'done' : ''}" data-idx="${idx}">
            <input type="checkbox" ${item.done ? 'checked' : ''}>
            <span>${esc(item.text)}</span>
          </div>`).join('') : '<div class="muted">No action items detected in notes.</div>'}
      </div>

      ${decisions.length ? `
      <div class="insight-card">
        <div class="insight-header">⚖ Decisions</div>
        <ul style="margin:0;padding-left:20px">
          ${decisions.map((d) => `<li style="margin-bottom:6px">${esc(d)}</li>`).join('')}
        </ul>
      </div>` : ''}

      ${keyPoints.length ? `
      <div class="insight-card">
        <div class="insight-header">💡 Key Takeaways</div>
        <ul style="margin:0;padding-left:20px">
          ${keyPoints.map((k) => `<li style="margin-bottom:6px">${esc(k)}</li>`).join('')}
        </ul>
      </div>` : ''}

      ${att.length ? `
      <div class="insight-card">
        <div class="insight-header">👥 Participants</div>
        <div class="attend-list">
          ${att.map((a) => `<span class="attend-chip">${esc(a)}</span>`).join('')}
        </div>
      </div>` : ''}
    </div>`;

  container.querySelectorAll('.action-row').forEach((row) => {
    const chk = row.querySelector('input[type=checkbox]');
    chk.onchange = () => {
      row.classList.toggle('done', chk.checked);
    };
  });
}

// ---- AI Chat Tab ----
const CHIPS = {
  meeting: ['Summarize this meeting', 'Extract all action items', 'What questions were asked?', 'What did I commit to?'],
  all: ['Summarize my recent meetings', 'Things I promised to do', 'What decisions were made this week?', 'Surprise me with an insight'],
};
function askContext(scope, m) {
  if (scope === 'meeting' && m && m.notes) {
    return `Meeting: "${m.title}" — ${localDate(m.date)}${m.duration ? ' · ' + m.duration : ''} · ${m.platform || ''}\n\n${m.notes}`.slice(0, 120000);
  }
  let out = '';
  for (const x of meetings) {
    if (!x.notes) continue;
    const chunk = `\n\n===== Meeting: "${x.title}" — ${localDate(x.date)}${x.duration ? ' · ' + x.duration : ''} =====\n${splitNotes(x.notes).summary}`;
    if (out.length + chunk.length > 100000) break;
    out += chunk;
  }
  return out || 'No meeting notes exist yet.';
}

function renderChatPane(m, container) {
  const scope = (chats.scope === 'all' || !m || !m.notes) ? 'all' : (chats.scope || 'meeting');
  chats.scope = scope;
  const key = scope === 'all' ? '::all' : m.id;
  const hist = chats[key] || (chats[key] = []);

  container.innerHTML = `
    <div class="chat-pane">
      <div class="askhead">
        <span class="muted" style="font-size:.82rem">Ask about:</span>
        <button class="btn ghost mini ${scope === 'meeting' ? 'btn' : ''}" id="scM" ${!m || !m.notes ? 'disabled' : ''}>This meeting</button>
        <button class="btn ghost mini ${scope === 'all' ? 'btn' : ''}" id="scA">All meetings</button>
      </div>
      <div class="chat" id="chat">
        ${hist.length ? hist.map((h) => `<div class="msg ${h.role === 'user' ? 'u' : 'a'}">${h.role === 'user' ? esc(h.text) : renderMarkdown(h.text)}</div>`).join('')
        : `<div class="empty" style="margin:40px 0">Hi — what can I tell you about ${scope === 'all' ? 'your meetings' : 'this meeting'}?</div>`}
        ${askBusy ? '<div class="msg a"><span class="spinner" style="border-color:rgba(0,0,0,.15);border-top-color:var(--acc);"></span> Thinking…</div>' : ''}
      </div>
      <div class="chips">${CHIPS[scope].map((c) => `<button class="chipbtn" data-q="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <div class="askrow">
        <input id="askIn" placeholder="Ask anything…" ${askBusy ? 'disabled' : ''}>
        <button class="btn" id="askGo" ${askBusy ? 'disabled' : ''}>↑</button>
      </div>
    </div>`;

  const chatEl = document.getElementById('chat');
  if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;

  const scM = document.getElementById('scM');
  if (scM) scM.onclick = () => { chats.scope = 'meeting'; renderRightContent(m); };
  const scA = document.getElementById('scA');
  if (scA) scA.onclick = () => { chats.scope = 'all'; renderRightContent(m); };

  const go = (q) => { if (q && q.trim() && !askBusy) sendAsk(q.trim(), key, scope, m); };
  container.querySelectorAll('.chipbtn').forEach((b) => b.onclick = () => go(b.dataset.q));

  const input = document.getElementById('askIn');
  if (input) {
    input.onkeydown = (e) => { if (e.key === 'Enter') go(input.value); };
    if (!askBusy) input.focus();
  }
  const askGo = document.getElementById('askGo');
  if (askGo) askGo.onclick = () => go(input ? input.value : '');
}

async function sendAsk(q, key, scope, m) {
  const hist = chats[key];
  hist.push({ role: 'user', text: q });
  askBusy = true;
  if (m) renderRightContent(m);
  else renderHome(document.getElementById('detail'));
  try {
    const answer = await self.GhostAsk.ask(q, hist.slice(0, -1).slice(-8), askContext(scope, m));
    hist.push({ role: 'ai', text: answer });
  } catch (e) {
    hist.push({ role: 'ai', text: '⚠ ' + e.message });
  }
  askBusy = false;
  if (m) renderRightContent(m);
  else renderHome(document.getElementById('detail'));
}

// ---- Media Attach & Player Controls ----
async function attachMedia(m) {
  const rec = await idbGet(m.id);
  if (rec && rec.video && !m.thumb && m.state === 'done') makeThumb(m.id, rec.video);
  if (selectedId !== m.id) return;

  const holder = document.getElementById('player');
  if (holder && rec && (rec.video || rec.audio)) {
    if (mediaUrl) { URL.revokeObjectURL(mediaUrl); mediaUrl = null; }
    const blob = rec.video || rec.audio;
    mediaUrl = URL.createObjectURL(blob);
    const tag = rec.video ? 'video' : 'audio';

    let trackHtml = '';
    let trText = splitNotes(m.notes).transcript || m.captions;
    if (!trText && rec && rec.captions) trText = rec.captions;
    if (tag === 'video' && trText) {
      const vtt = transcriptToVtt(trText);
      const trackUrl = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
      trackHtml = `<track label="Subtitles" kind="subtitles" srclang="auto" src="${trackUrl}" default>`;
    }

    holder.innerHTML = `
      <div class="player-wrap">
        <${tag} id="media" src="${mediaUrl}" controls preload="metadata" class="vid">${trackHtml}</${tag}>
      </div>
      <div class="speed-bar">
        <span>Speed:</span>
        ${[1, 1.25, 1.5, 2].map((s) => `<button class="spd-btn ${s === 1 ? 'on' : ''}" data-s="${s}">${s}×</button>`).join('')}
      </div>`;

    const media = document.getElementById('media');
    holder.querySelectorAll('.spd-btn').forEach((b) => b.onclick = () => {
      media.playbackRate = Number(b.dataset.s);
      holder.querySelectorAll('.spd-btn').forEach((x) => x.classList.toggle('on', x === b));
    });

    media.ontimeupdate = () => {
      if (rightTab === 'transcript') {
        syncActiveTranscriptCue(media.currentTime);
      }
    };
  } else if (holder && (m.files && (m.files.video || m.files.audio))) {
    holder.innerHTML = `<div class="muted" style="padding:8px 0 4px;font-size:.78rem">▶ Inline playback covers the 12 most recent recordings — this older one only has its files in Downloads ("📁 Show files in folder").</div>`;
  }
}

function downloadBlob(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
}

function transcriptToVtt(text) {
  let vtt = 'WEBVTT - Ghost Recorder Subtitles\n\n';
  let idx = 1;
  const lines = (text || '').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = TS_RE.exec(line);
    if (m && (m[4] || m[5])) {
      const secs = m[3] != null ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : (+m[1]) * 60 + (+m[2]);
      const sH = Math.floor(secs / 3600), sM = Math.floor((secs % 3600) / 60), sS = secs % 60;
      const start = `${String(sH).padStart(2, '0')}:${String(sM).padStart(2, '0')}:${String(sS).padStart(2, '0')}.000`;
      const endSecs = secs + 3;
      const eH = Math.floor(endSecs / 3600), eM = Math.floor((endSecs % 3600) / 60), eS = endSecs % 60;
      const end = `${String(eH).padStart(2, '0')}:${String(eM).padStart(2, '0')}:${String(eS).padStart(2, '0')}.000`;
      const spk = (m[4] ? m[4].trim() : 'Speaker').replace(/\*\*/g, '');
      const txt = (m[5] ? m[5].trim() : '');
      vtt += `${idx}\n${start} --> ${end}\n<v ${spk}>${txt}</v>\n\n`;
      idx++;
    }
  }
  return vtt;
}

// Original Home View (Restored to stats + mic recording trigger + cross-meeting AI chat)
function renderHome(detail) {
  const done = meetings.filter((x) => x.state === 'done').length;
  const week = meetings.filter((x) => Date.now() - new Date(x.date).getTime() < 7 * 864e5).length;
  detail.innerHTML = `
    <h2 class="title" style="font-size:1.35rem;font-weight:700;margin-bottom:16px">🏠 Home</h2>
    <div class="homegrid">
      <div class="stat"><div class="n">${meetings.length}</div><div class="l">meetings recorded</div></div>
      <div class="stat"><div class="n">${done}</div><div class="l">with AI notes</div></div>
      <div class="stat"><div class="n">${week}</div><div class="l">in the last 7 days</div></div>
    </div>
    <div class="livecard">
      <div>
        <div style="font-weight:700">🎙 In-person meeting</div>
        <div class="muted" style="margin-top:3px">Record the room through your mic — live transcript while you talk, AI notes at the end.</div>
      </div>
      <button class="btn" id="offlineBtn" style="background:#dc2626">● Start recording</button>
    </div>
    <h2 class="title" style="font-size:1.05rem;margin-top:28px;margin-bottom:14px;font-weight:700">✨ Ask AI — across all your meetings</h2>
    <div id="homeAskPane"></div>`;

  const offBtn = document.getElementById('offlineBtn');
  if (offBtn) offBtn.onclick = startOffline;
  chats.scope = 'all';
  renderChatPane(null, document.getElementById('homeAskPane'));
}

// Meetings Grid View (Matches Reference Image 2)
function filterMeetings(query) {
  if (!query) return meetings;
  const q = query.toLowerCase().trim();
  return meetings.filter((m) => {
    return (m.title || '').toLowerCase().includes(q) ||
           (m.notes || '').toLowerCase().includes(q) ||
           (m.platform || '').toLowerCase().includes(q);
  });
}

function renderAudioFallbackHtml() {
  return `
    <div class="grid-card-audio-fallback" title="Audio recording">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M2 10v4"/>
        <path d="M6 6v12"/>
        <path d="M10 3v18"/>
        <path d="M14 7v10"/>
        <path d="M18 5v14"/>
        <path d="M22 10v4"/>
      </svg>
      <span class="audio-text">Audio</span>
    </div>`;
}

function renderVideoFallbackHtml() {
  return `
    <div class="grid-card-video-fallback" title="Video recording">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2" y="4" width="15" height="16" rx="2" ry="2"/>
        <path d="m22 7-5 3.5 5 3.5V7z"/>
      </svg>
    </div>`;
}

async function autoGenerateGridThumbnails(list) {
  for (const m of list) {
    if (m.thumb) continue;
    const isAudio = m.isAudioOnly || m.platform === 'In-person' || m.videoEnabled === false;
    if (isAudio) {
      m.isAudioOnly = true;
      continue;
    }
    try {
      const rec = await idbGet(m.id);
      if (rec) {
        if (rec.video && !m.thumb) {
          makeThumb(m.id, rec.video);
        } else if (!rec.video && rec.audio) {
          m.isAudioOnly = true;
          const thumbWrap = document.querySelector(`.grid-card[data-id="${esc(m.id)}"] .grid-card-thumb-wrap`);
          if (thumbWrap && !thumbWrap.querySelector('.grid-card-audio-fallback')) {
            const badgeHtml = `<div class="grid-card-dur">${esc(m.duration && m.duration !== 'Unknown' ? m.duration : '0:00')}</div><div class="grid-card-tag">${badge(m.state)}</div>`;
            thumbWrap.innerHTML = renderAudioFallbackHtml() + badgeHtml;
          }
        }
      }
    } catch (e) {
      console.warn('[dashboard] autoGenerateGridThumbnails error:', e);
    }
  }
}

function renderMeetingsGrid(detail) {
  const visible = filterMeetings(searchQ);

  detail.innerHTML = `
    <div class="grid-container">
      <div class="grid-search">
        <span class="grid-search-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg></span>
        <input type="text" id="gridSearchInput" placeholder="Search for a keyword or phrase" value="${esc(searchQ)}">
      </div>

      <h1 class="grid-page-title">Meetings</h1>
      <div class="grid-section-label">
        <span>Recent recordings</span>
        <span style="opacity:.4">></span>
      </div>

      <div class="meetings-grid" id="meetingsGrid">
        ${visible.length ? visible.map((m) => renderGridCardHtml(m)).join('') : `<div class="empty" style="margin-top:40px;grid-column:1/-1">${meetings.length ? `No recordings match "${esc(searchQ)}"` : 'No meetings yet.<br>Join a meeting and press Record — everything shows up here.'}</div>`}
      </div>
    </div>`;

  const sIn = document.getElementById('gridSearchInput');
  if (sIn) {
    sIn.oninput = (e) => {
      searchQ = e.target.value;
      updateGridSearchOnly();
    };
  }

  attachGridCardListeners(detail);
  autoGenerateGridThumbnails(visible);
}

function updateGridSearchOnly() {
  const gridEl = document.getElementById('meetingsGrid');
  if (!gridEl) return;
  const visible = filterMeetings(searchQ);
  if (visible.length) {
    gridEl.innerHTML = visible.map((m) => renderGridCardHtml(m)).join('');
    attachGridCardListeners(document.getElementById('detail'));
    autoGenerateGridThumbnails(visible);
  } else {
    gridEl.innerHTML = `<div class="empty" style="margin-top:40px;grid-column:1/-1">No recordings match "${esc(searchQ)}"</div>`;
  }
}

function attachGridCardListeners(container) {
  container.querySelectorAll('.grid-card').forEach((card) => {
    card.onclick = () => {
      selectedId = card.dataset.id;
      rightTab = 'transcript';
      render();
    };
  });
}

function renderGridCardHtml(m) {
  const isAudio = m.isAudioOnly || m.platform === 'In-person' || m.videoEnabled === false;
  let thumbInner = '';

  if (m.thumb) {
    thumbInner = `<img class="grid-card-thumb" src="${m.thumb}" alt="">`;
  } else if (isAudio) {
    thumbInner = renderAudioFallbackHtml();
  } else {
    thumbInner = renderVideoFallbackHtml();
  }

  return `
    <div class="grid-card" data-id="${esc(m.id)}">
      <div class="grid-card-thumb-wrap">
        ${thumbInner}
        <div class="grid-card-dur">${esc(m.duration && m.duration !== 'Unknown' ? m.duration : '0:00')}</div>
        <div class="grid-card-tag">${badge(m.state)}</div>
      </div>
      <div class="grid-card-body">
        <div class="grid-card-title-row">
          <div class="grid-card-title" title="${esc(m.title || m.id)}">${esc(m.title || m.id)}</div>
          <div class="grid-card-more">•••</div>
        </div>
        <div class="grid-card-meta">${esc(localDate(m.date))}</div>
      </div>
    </div>`;
}

// =================== In-person recorder
let live = null;
const liveMMSS = () => {
  const s = Math.max(0, Math.floor((Date.now() - live.startMs - live.totalPaused) / 1000));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
};

const LIVE_LANGS = [
  ['auto', 'Auto (browser language)'], ['en-US', 'English (US)'], ['es-ES', 'Español'],
  ['fr-FR', 'Français'], ['de-DE', 'Deutsch'], ['pt-BR', 'Português'], ['it-IT', 'Italiano'],
  ['ja-JP', '日本語 Japanese'], ['zh-CN', '中文 Chinese']
];

async function startOffline() {
  if (live) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { noiseSuppression: true, autoGainControl: true, echoCancellation: false } });
  } catch (e) {
    alert('Microphone is blocked. Open ⚙ Settings and click "🎤 Enable mic" once, then try again.');
    return;
  }
  const { settings } = await chrome.storage.local.get('settings');
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
  const rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 64000 });
  live = { rec, chunks: [], stream, recog: null, startMs: Date.now(), pausedAt: 0, totalPaused: 0, lines: [], timer: null, lang: (settings && settings.liveLang) || 'auto' };
  rec.ondataavailable = (e) => { if (e.data && e.data.size) live.chunks.push(e.data); };
  rec.start(5000);
  startLiveRecog();
  render();
}

function startLiveRecog() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { live.noSR = true; return; }
  const r = new SR();
  r.continuous = true;
  r.interimResults = true;
  r.lang = (live.lang && live.lang !== 'auto') ? live.lang : (navigator.language || 'en-US');
  r.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript.trim();
      if (!t) continue;
      if (e.results[i].isFinal) { live.lines.push(`[${liveMMSS()}] ${t}`); }
      else interim = t;
    }
    updateLiveUI(interim);
  };
  r.onend = () => { if (live && !live.pausedAt) { try { r.start(); } catch (e) { /* */ } } };
  r.onerror = () => {};
  try { r.start(); live.recog = r; } catch (e) { live.noSR = true; }
}

function updateLiveUI(interim) {
  const box = document.getElementById('liveTr');
  if (!box) return;
  box.innerHTML = live.lines.slice(-40).map((l) => `<div class="cue-row" style="color:var(--text)">${esc(l)}</div>`).join('')
    + (interim ? `<div class="cue-row" style="opacity:.5">${esc(interim)}…</div>` : '');
  box.scrollTop = box.scrollHeight;
}

function renderLive(detail) {
  detail.innerHTML = `
    <h2 class="title"><span style="color:#ef4444">●</span> Recording in-person meeting <span class="muted" id="liveTm" style="font-variant-numeric:tabular-nums">00:00</span></h2>
    <div class="muted" style="margin:-4px 0 12px">Keep this tab open. Live transcript below — AI writes polished notes when you stop.</div>
    <div style="display:flex;gap:8px;margin-bottom:14px">
      <button class="btn ghost" id="livePause">${live.pausedAt ? '▶ Resume' : '⏸ Pause'}</button>
      <button class="btn" id="liveStop" style="background:#dc2626">■ Stop &amp; get notes</button>
      <select id="liveLang" style="background:#fff;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:.8rem">
        ${LIVE_LANGS.map(([v, l]) => `<option value="${v}" ${v === live.lang ? 'selected' : ''}>${esc(l)}</option>`).join('')}
      </select>
    </div>
    <div id="liveTr" style="min-height:200px;max-height:52vh;overflow-y:auto;border:1px solid var(--line);border-radius:10px;padding:12px">
      <div class="cue-row">Listening…</div>
    </div>`;
  updateLiveUI('');
  if (live.timer) clearInterval(live.timer);
  live.timer = setInterval(() => { const el = document.getElementById('liveTm'); if (el && !live.pausedAt) el.textContent = liveMMSS(); }, 1000);
  document.getElementById('livePause').onclick = () => {
    if (live.pausedAt) { live.totalPaused += Date.now() - live.pausedAt; live.pausedAt = 0; try { live.rec.resume(); } catch (e) { /* */ } startLiveRecog(); }
    else { live.pausedAt = Date.now(); try { live.rec.pause(); } catch (e) { /* */ } if (live.recog) { const r = live.recog; live.recog = null; try { r.stop(); } catch (e) { /* */ } } }
    render();
  };
  document.getElementById('liveStop').onclick = stopOffline;
  document.getElementById('liveLang').onchange = (e) => {
    live.lang = e.target.value;
    chrome.storage.local.get('settings', ({ settings }) => chrome.storage.local.set({ settings: Object.assign({}, settings || {}, { liveLang: live.lang }) }));
    if (live.recog) { const r = live.recog; live.recog = null; try { r.stop(); } catch (err) { /* */ } }
    live.noSR = false;
    startLiveRecog();
  };
}

async function stopOffline() {
  const L = live; if (!L) return;
  if (L.pausedAt) { L.totalPaused += Date.now() - L.pausedAt; L.pausedAt = 0; }
  if (L.timer) clearInterval(L.timer);
  if (L.recog) { const r = L.recog; L.recog = null; try { r.stop(); } catch (e) { /* */ } }
  await new Promise((res) => { L.rec.onstop = res; try { L.rec.stop(); } catch (e) { res(); } });
  L.stream.getTracks().forEach((t) => t.stop());
  live = null;
  const blob = new Blob(L.chunks, { type: 'audio/webm' });
  if (!blob.size) { alert('Nothing was recorded.'); render(); return; }
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const secs = Math.floor((Date.now() - L.startMs - L.totalPaused) / 1000);
  const duration = `${Math.floor(secs / 60)}m ${secs % 60}s`;
  const captions = L.lines.join('\n');
  await idbPut({ id, audio: blob, video: null, captions, settings: null, meta: { date: new Date().toLocaleString(), platform: 'In-person', duration } });
  chrome.runtime.sendMessage({ action: 'OFFLINE_MEETING', meetingId: id, duration }, () => {
    const url = URL.createObjectURL(blob);
    chrome.runtime.sendMessage({ action: 'SAVE_FILE', meetingId: id, kind: 'audio', url });
    setTimeout(() => URL.revokeObjectURL(url), 180000);
    chrome.runtime.sendMessage({ action: 'RETRY_NOTES', meetingId: id });
    selectedId = id; rightTab = 'transcript';
    render();
  });
}

// Video Thumbnail Maker
function makeThumb(meetingId, blob) {
  if (!blob || !(blob instanceof Blob)) return;
  try {
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'metadata';
    v.src = url;

    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      URL.revokeObjectURL(url);
      v.remove();
    };

    const capture = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 320;
        c.height = 180;
        const ctx = c.getContext('2d');
        ctx.drawImage(v, 0, 0, 320, 180);
        const thumb = c.toDataURL('image/jpeg', 0.7);
        if (thumb && thumb.length > 200) {
          chrome.runtime.sendMessage({ action: 'SET_THUMB', meetingId, thumb });
          const m = meetings.find((x) => String(x.id).trim() === String(meetingId).trim());
          if (m) m.thumb = thumb;
        }
      } catch (e) {
        console.warn('[makeThumb] capture error:', e);
      }
      done();
    };

    v.onloadedmetadata = () => {
      v.currentTime = Math.min(1.5, (v.duration || 1) / 2);
    };
    v.onseeked = capture;
    v.onerror = done;
    setTimeout(done, 5000);
  } catch (e) {
    console.warn('[makeThumb] failed:', e);
  }
}

// Live-update on chrome.storage change
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.meetings) {
    meetings = changes.meetings.newValue || [];
    if (selectedId && !meetings.some((x) => String(x.id).trim() === String(selectedId).trim())) {
      selectedId = meetings.length ? meetings[0].id : null;
    }
    render();
  }
});

document.addEventListener('DOMContentLoaded', () => {
  const appLayout = document.getElementById('appLayout');
  const toggleBtn = document.getElementById('toggleSidebarBtn');

  const applySidebarCollapse = () => {
    const isCollapsed = localStorage.getItem('gr_sidebar_collapsed') === '1';
    if (appLayout) appLayout.classList.toggle('collapsed', isCollapsed);
  };

  if (toggleBtn) {
    toggleBtn.onclick = (e) => {
      e.preventDefault();
      const isCollapsed = appLayout.classList.toggle('collapsed');
      localStorage.setItem('gr_sidebar_collapsed', isCollapsed ? '1' : '0');
    };
  }
  applySidebarCollapse();

  // Active navigation items management
  const setActiveNavItem = (id) => {
    document.querySelectorAll('.nav-item').forEach((item) => {
      item.classList.toggle('active', item.id === id);
    });
  };

  const navHome = document.getElementById('navHome');
  if (navHome) {
    navHome.onclick = (e) => {
      e.preventDefault();
      setActiveNavItem('navHome');
      activeView = 'home';
      selectedId = null;
      render();
    };
  }

  const workspaceBtn = document.getElementById('workspaceBtn');
  if (workspaceBtn) {
    workspaceBtn.onclick = (e) => {
      e.preventDefault();
      setActiveNavItem('navHome');
      activeView = 'home';
      selectedId = null;
      render();
    };
  }

  const navChat = document.getElementById('navChat');
  if (navChat) {
    navChat.onclick = (e) => {
      e.preventDefault();
      setActiveNavItem('navChat');
      activeView = 'chat';
      selectedId = null;
      render();
    };
  }

  const navOffline = document.getElementById('navOffline');
  if (navOffline) {
    navOffline.onclick = (e) => {
      e.preventDefault();
      setActiveNavItem('navOffline');
      startOffline();
    };
  }

  const navMeetings = document.getElementById('navMeetings');
  if (navMeetings) {
    navMeetings.onclick = (e) => {
      e.preventDefault();
      setActiveNavItem('navMeetings');
      activeView = 'meetings';
      selectedId = null;
      render();
    };
  }

  load();
});
