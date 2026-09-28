// Ghost Recorder — "Ask AI" (Fathom-style chat) for dashboard.
// Answers questions grounded ONLY in meeting notes/transcripts, via BYOK or local provider.
function normalizeGeminiModel(model) {
  if (!model || typeof model !== 'string') return 'gemini-2.5-flash';
  const m = model.trim();
  if (!m) return 'gemini-2.5-flash';
  const lower = m.toLowerCase();
  if (lower === 'gemini-flash') return 'gemini-2.5-flash';
  if (lower === 'gemini-pro') return 'gemini-2.5-pro';
  return m;
}

(function () {
  const DEF = {
    provider: 'gemini', keys: {}, customBaseUrl: '', localLlmUrl: 'http://localhost:8080/v1', localLlmModel: 'Meta-Llama-3.1-8B-Instruct',
    models: { gemini: 'gemini-2.5-flash', groq: 'llama-3.3-70b-versatile', openrouter: 'google/gemini-2.5-flash', custom: '', local: 'Meta-Llama-3.1-8B-Instruct', chrome_ai: 'gemini-nano' },
  };
  function getSettings() {
    return new Promise((r) => chrome.storage.local.get('settings', ({ settings }) => {
      const s = settings || {};
      r(Object.assign({}, DEF, s, { keys: Object.assign({}, s.keys || {}), models: Object.assign({}, DEF.models, s.models || {}) }));
    }));
  }

  const SYS = `You are Ask Ghost — the AI assistant inside the Ghost Recorder meeting app.
Answer the user's questions using ONLY the meeting context provided. Rules:
- PRIMARY SOURCE IS THE TRANSCRIPT. Re-derive your answer from what was actually SAID in the transcript.
- Be concise and specific. Use markdown bullets/bold where it helps scanning.
- Cite speaker names, and [mm:ss] timestamps when referring to a moment.
- For action items: verb-first, concrete, with owner and any stated deadline — "- [ ] Owner — do X (due: date) [mm:ss]".
- If context does not contain the answer, say plainly that it wasn't discussed — never invent facts.`;

  async function askGemini(s, question, history, context) {
    const key = (s.keys.gemini || '').trim();
    if (!key) throw new Error('Add your Gemini key in Settings.');
    const contents = [
      { role: 'user', parts: [{ text: SYS + '\n\nMEETING CONTEXT:\n' + context }] },
      { role: 'model', parts: [{ text: 'Understood — ask me anything about these meetings.' }] },
    ];
    (history || []).forEach((h) => contents.push({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: h.text }] }));
    contents.push({ role: 'user', parts: [{ text: question }] });
    const chain = [normalizeGeminiModel(s.models.gemini), 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.5-pro'].filter((m, i, a) => a.indexOf(m) === i);
    let lastErr;
    for (const model of chain) {
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents, generationConfig: { temperature: 0.3, maxOutputTokens: 2048 } }),
      });
      if (!resp.ok) { lastErr = new Error('Gemini ' + resp.status + ': ' + (await resp.text()).slice(0, 200)); if ([404, 429, 500, 502, 503].includes(resp.status)) continue; throw lastErr; }
      const d = await resp.json();
      const t = d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts;
      const text = t && t.map((p) => p.text || '').join('').trim();
      if (text) return text;
      lastErr = new Error('AI returned no answer — try again.');
    }
    throw lastErr || new Error('Gemini failed');
  }

  async function askChromeAi(s, question, history, context) {
    const lm = self.ai?.languageModel || self.LanguageModel;
    if (!lm) throw new Error('Chrome Prompt API is not available on this device.');
    const session = await lm.create({ systemPrompt: SYS });
    let fullPrompt = `MEETING CONTEXT:\n${context}\n\n`;
    (history || []).forEach((h) => { fullPrompt += `${h.role}: ${h.text}\n`; });
    fullPrompt += `user: ${question}`;
    const ans = await session.prompt(fullPrompt);
    try { session.destroy(); } catch (e) {}
    return ans;
  }

  async function askOpenAI(s, question, history, context) {
    let base, key, model, extra = {};
    if (s.provider === 'groq') {
      base = 'https://api.groq.com/openai/v1'; key = s.keys.groq; model = s.models.groq;
    } else if (s.provider === 'openrouter') {
      base = 'https://openrouter.ai/api/v1'; key = s.keys.openrouter; model = s.models.openrouter; extra = { 'HTTP-Referer': 'https://ghost-recorder.app', 'X-Title': 'Ghost Recorder' };
    } else if (s.provider === 'local') {
      base = (s.localLlmUrl || s.customBaseUrl || 'http://localhost:8080/v1').trim();
      key = (s.keys.local || 'local-key').trim();
      model = s.localLlmModel || (s.models && s.models.local) || 'Meta-Llama-3.1-8B-Instruct';
    } else {
      base = (s.customBaseUrl || '').trim(); key = s.keys.custom; model = s.models.custom;
      if (!base || !model) throw new Error('Custom provider needs Base URL + model in Settings.');
    }

    if (s.provider !== 'local' && !(key || '').trim()) throw new Error('Add your ' + s.provider + ' key in Settings.');

    const messages = [
      { role: 'system', content: SYS },
      { role: 'user', content: 'MEETING CONTEXT:\n' + context },
      { role: 'assistant', content: 'Understood — ask me anything about these meetings.' },
    ];
    (history || []).forEach((h) => messages.push({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text }));
    messages.push({ role: 'user', content: question });

    const headers = Object.assign({ 'Content-Type': 'application/json' }, extra);
    if (key) headers['Authorization'] = 'Bearer ' + key.trim();

    const resp = await fetch(base.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', headers,
      body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 2048 }),
    });
    if (!resp.ok) throw new Error('Ask ' + resp.status + ': ' + (await resp.text()).slice(0, 200));
    const t = (await resp.json()).choices?.[0]?.message?.content;
    if (!t) throw new Error('AI returned no answer.');
    return t.trim();
  }

  async function ask(question, history, context) {
    const s = await getSettings();
    const p = s.provider || 'gemini';
    if (p === 'gemini') return askGemini(s, question, history, context);
    if (p === 'chrome_ai') return askChromeAi(s, question, history, context);
    return askOpenAI(s, question, history, context);
  }

  self.GhostAsk = { ask };
})();
