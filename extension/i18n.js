// Ghost Recorder — Localization (i18n) & Language Management Layer
// Key-value dictionary system supporting multiple languages and LLM prompt directives.

(function () {
  'use strict';

  const LANGUAGES = [
    { code: 'auto', name: 'Auto-detect (Same as meeting spoken language)' },
    { code: 'en', name: 'English' },
    { code: 'es', name: 'Español (Spanish)' },
    { code: 'fr', name: 'Français (French)' },
    { code: 'de', name: 'Deutsch (German)' },
    { code: 'pt', name: 'Português (Portuguese)' },
    { code: 'it', name: 'Italiano (Italian)' },
    { code: 'ja', name: '日本語 (Japanese)' },
    { code: 'zh', name: '中文 (Chinese)' },
  ];

  const DICTIONARY = {
    en: {
      app_name: 'Ghost Recorder',
      settings_title: 'Ghost Recorder — Settings',
      meetings_title: 'Ghost Recorder — Meetings',
      rec_mode_call: 'Call Mode (Both sides)',
      rec_mode_system: 'System Audio Only (Webinar/Podcast)',
      start_recording: 'Start Recording',
      stop_recording: 'Stop',
      pause_recording: 'Pause',
      resume_recording: 'Resume',
      settings: 'Settings',
      meetings: 'Meetings',
      home: 'Home',
      hide_list: '◀ Hide list',
      show_list: '▶ Show list',
      search_placeholder: 'Search meetings, notes, transcripts…',
      select_meeting_hint: 'Select a meeting on the left.',
      record_video: 'Record video',
      off_audio_only: 'Off = audio only (lighter)',
      recording_mode: 'Recording Mode',
      note_style: 'Note style',
      meeting_notes_language: 'Meeting & Notes Language',
      video_resolution: 'Video Resolution',
      frame_rate: 'Frame Rate (FPS)',
      video_codec: 'Video Codec',
      overlay_display: 'In-Tab Recording Overlay Display',
      microphone_label: 'Microphone (records YOUR voice; remote audio is captured automatically)',
      enable_mic: '🎤 Enable mic',
      grant_mic_hint: 'Grant mic access once so your side is recorded',
      auto_suggest_label: 'Auto-suggest recording when a meeting is detected',
      auto_suggest_sub: 'Show a "Record this meeting?" prompt',
      consent_note_label: 'Add a consent / recording note to the notes',
      consent_note_sub: 'Append "recorded with an AI notetaker" to saved/emailed notes',
      recordings_folder: 'Recordings folder (inside your Downloads)',
      email_notes_to: 'Email notes to',
      send_notes_auto: 'Send notes automatically after meeting ends',
      save_settings: 'Save settings',
      saved_notice: 'Saved!',
      ai_provider: 'AI provider',
      base_url: 'Base URL (OpenAI Endpoint)',
      api_key: 'API key',
      model: 'Model',
      local_model: 'Local Model (llama.cpp / Faster-Whisper)',
      chrome_ai: 'Chrome Built-in AI (Gemini Nano)',
      video_quality_1080p: '1080p Full HD (1920×1080 — Recommended)',
      video_quality_1440p: '1440p 2K QHD (2560×1440)',
      video_quality_4k: '4K UHD (3840×2160)',
      video_quality_720p: '720p HD (1280×720, 30 fps)',
      video_quality_720p_low: '720p Low CPU (1280×720, 10 fps)',
      sub_tagline: 'One-click meeting recorder for any platform. High-res video, local AI models (llama.cpp / Faster-Whisper), zero telemetry.',
      popup_sub: 'AI meeting notes — any platform',
      ready_status: 'Ready to capture this meeting',
      meeting_prompt: "Looks like you're in a meeting — record it?",
      not_now: 'Not now',
      listening_overlay: 'Listening… AI transcribes full audio.',
    },
    es: {
      app_name: 'Ghost Recorder',
      settings_title: 'Ghost Recorder — Configuración',
      meetings_title: 'Ghost Recorder — Reuniones',
      rec_mode_call: 'Modo Llamada (Ambos lados)',
      rec_mode_system: 'Solo audio del sistema (Webinar/Podcast)',
      start_recording: 'Iniciar grabación',
      stop_recording: 'Detener',
      pause_recording: 'Pausar',
      resume_recording: 'Reanudar',
      settings: 'Configuración',
      meetings: 'Reuniones',
      home: 'Inicio',
      hide_list: '◀ Ocultar lista',
      show_list: '▶ Mostrar lista',
      search_placeholder: 'Buscar reuniones, notas, transcripciones…',
      select_meeting_hint: 'Selecciona una reunión a la izquierda.',
      record_video: 'Grabar video',
      off_audio_only: 'Desactivado = solo audio (más ligero)',
      recording_mode: 'Modo de grabación',
      note_style: 'Estilo de notas',
      meeting_notes_language: 'Idioma de reunión y notas',
      video_resolution: 'Resolución de video',
      frame_rate: 'Fotogramas por segundo (FPS)',
      video_codec: 'Códec de video',
      overlay_display: 'Visualización del panel de grabación en pestaña',
      microphone_label: 'Micrófono (graba TU voz; el audio remoto se captura automáticamente)',
      enable_mic: '🎤 Habilitar mic',
      grant_mic_hint: 'Concede acceso al micrófono para grabar tu voz',
      auto_suggest_label: 'Sugerir grabación automáticamente al detectar una reunión',
      auto_suggest_sub: 'Mostrar un aviso de "¿Grabar esta reunión?"',
      consent_note_label: 'Agregar una nota de consentimiento/grabación a las notas',
      consent_note_sub: 'Añadir "grabado con notetaker IA" a las notas guardadas o enviadas',
      recordings_folder: 'Carpeta de grabaciones (dentro de Descargas)',
      email_notes_to: 'Enviar notas por correo a',
      send_notes_auto: 'Enviar notas automáticamente al finalizar la reunión',
      save_settings: 'Guardar configuración',
      saved_notice: '¡Guardado!',
      ai_provider: 'Proveedor de IA',
      base_url: 'URL base (Endpoint OpenAI)',
      api_key: 'Clave API',
      model: 'Modelo',
      local_model: 'Modelo Local (llama.cpp / Faster-Whisper)',
      chrome_ai: 'IA integrada de Chrome (Gemini Nano)',
      video_quality_1080p: '1080p Full HD (1920×1080 — Recomendado)',
      video_quality_1440p: '1440p 2K QHD (2560×1440)',
      video_quality_4k: '4K UHD (3840×2160)',
      video_quality_720p: '720p HD (1280×720, 30 fps)',
      video_quality_720p_low: '720p Bajo CPU (1280×720, 10 fps)',
      sub_tagline: 'Grabador de reuniones con un clic para cualquier plataforma. Video de alta resolución, modelos de IA locales (llama.cpp / Faster-Whisper), cero telemetría.',
      popup_sub: 'Notas de reunión con IA en cualquier plataforma',
      ready_status: 'Listo para capturar esta reunión',
      meeting_prompt: 'Parece que estás en una reunión. ¿Deseas grabarla?',
      not_now: 'Ahora no',
      listening_overlay: 'Escuchando… La IA transcribe todo el audio.',
    },
    fr: {
      app_name: 'Ghost Recorder',
      rec_mode_call: 'Mode Appel (Les deux côtés)',
      rec_mode_system: 'Audio système uniquement (Webinaire/Podcast)',
      start_recording: 'Démarrer l\'enregistrement',
      stop_recording: 'Arrêter',
      pause_recording: 'Pause',
      resume_recording: 'Reprendre',
      settings: 'Paramètres',
      meetings: 'Réunions',
    },
    de: {
      app_name: 'Ghost Recorder',
      rec_mode_call: 'Anruf-Modus (Beide Seiten)',
      rec_mode_system: 'Nur Systemaudio (Webinar/Podcast)',
      start_recording: 'Aufnahme starten',
      stop_recording: 'Stopp',
      pause_recording: 'Pause',
      resume_recording: 'Fortsetzen',
      settings: 'Einstellungen',
      meetings: 'Meetings',
    },
    pt: {
      app_name: 'Ghost Recorder',
      rec_mode_call: 'Modo Chamada (Ambos os lados)',
      rec_mode_system: 'Apenas Áudio do Sistema (Webinar/Podcast)',
      start_recording: 'Iniciar gravação',
      stop_recording: 'Parar',
      pause_recording: 'Pausar',
      resume_recording: 'Retomar',
      settings: 'Configurações',
      meetings: 'Reuniões',
    },
    it: {
      app_name: 'Ghost Recorder',
      rec_mode_call: 'Modalità Chiamata (Entrambi i lati)',
      rec_mode_system: 'Solo Audio di Sistema (Webinar/Podcast)',
      start_recording: 'Avvia registrazione',
      stop_recording: 'Interrompi',
      pause_recording: 'Pausa',
      resume_recording: 'Riprendi',
    },
    ja: {
      app_name: 'Ghost Recorder',
      rec_mode_call: '通話モード（両方の音声）',
      rec_mode_system: 'システム音声のみ（ウェビナー/ポッドキャスト）',
      start_recording: '録音開始',
      stop_recording: '停止',
      pause_recording: '休憩',
      resume_recording: '再開',
    },
    zh: {
      app_name: 'Ghost Recorder',
      rec_mode_call: '通话模式（双方声音）',
      rec_mode_system: '仅系统音频（研讨会/播客）',
      start_recording: '开始录音',
      stop_recording: '停止',
      pause_recording: '暂停',
      resume_recording: '继续',
    },
  };

  let activeLang = 'en';

  function setLanguage(lang) {
    activeLang = lang || 'en';
  }

  function t(key, fallback) {
    const dict = DICTIONARY[activeLang] || DICTIONARY.en;
    if (dict && dict[key]) return dict[key];
    if (DICTIONARY.en[key]) return DICTIONARY.en[key];
    return fallback || key;
  }

  function translatePage(root = document) {
    const elements = root.querySelectorAll('[data-i18n]');
    elements.forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (!key) return;
      const translation = t(key);
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        if (el.hasAttribute('placeholder')) el.placeholder = translation;
        else el.value = translation;
      } else {
        el.textContent = translation;
      }
    });
  }

  function getLanguageList() {
    return LANGUAGES.slice();
  }

  function getLanguagePromptDirective(langCode) {
    if (!langCode || langCode === 'auto') {
      return 'LANGUAGE DIRECTIVE: Output the meeting notes, action items, summaries, and full transcript in the SAME language as spoken in the meeting audio/transcript. Do NOT translate unless requested.';
    }
    const target = LANGUAGES.find((l) => l.code === langCode);
    const name = target ? target.name.split(' (')[0] : langCode;
    return `CRITICAL LANGUAGE REQUIREMENT: Output the ENTIRE meeting summary, key points, decisions, action items, and full transcript in ${name} (${langCode.toUpperCase()}). Ensure all section contents are written in ${name}.`;
  }

  self.GhostI18n = {
    setLanguage,
    t,
    translatePage,
    getLanguageList,
    getLanguagePromptDirective,
  };
})();
