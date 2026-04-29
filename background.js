// --- BACKGROUND CONTROLLER: AI SESSION MANAGER ---
// Holds transient session state + AI inference engine.
// Data exists ONLY in RAM. If the browser restarts, this is wiped.

let sessionVault = null;
let aiSettings = null;
let masterPassword = null;
let saveQueue = Promise.resolve();
let pendingSignup = null;

chrome.runtime.onInstalled.addListener(() => {
  console.log('PassVault AI Session Manager Active.');
});

// Helper: Parse domain
function getDomain(url) {
  try { return new URL(url).hostname; }
  catch { return ''; }
}

function normalizeSite(value) {
  if (!value) return '';
  return String(value)
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];
}

function getMatchScore(hostname, site) {
  if (!hostname || !site) return -1;
  if (hostname === site) return 4;
  if (hostname.endsWith(`.${site}`) || site.endsWith(`.${hostname}`)) return 3;
  if (hostname.includes(site) || site.includes(hostname)) return 2;
  return -1;
}

function pickBestVaultEntry(vault, hostOrSite) {
  const base = Array.isArray(vault) ? vault : [];
  const target = normalizeSite(hostOrSite);
  if (!target) return null;

  const candidates = base
    .map((entry) => {
      const site = normalizeSite(entry.site);
      return { entry, score: getMatchScore(target, site) };
    })
    .filter((x) => x.score >= 0);

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const bTs = b.entry.updatedAt || b.entry.created || 0;
    const aTs = a.entry.updatedAt || a.entry.created || 0;
    return bTs - aTs;
  });

  return candidates[0].entry;
}

function findSignupConflict(vault, entry) {
  const site = normalizeSite(entry.site);
  const user = (entry.user || '').trim().toLowerCase();

  const matchIndex = vault.findIndex((existing) => {
    if ((existing.type || 'login') !== 'login') return false;
    if (normalizeSite(existing.site) !== site) return false;
    if (!user) return true;
    return (existing.user || '').trim().toLowerCase() === user;
  });

  if (matchIndex === -1) return null;
  return { index: matchIndex, existing: vault[matchIndex] };
}

function sanitizeConflict(entry) {
  if (!entry) return null;
  return {
    id: entry.id || '',
    site: entry.site || '',
    user: entry.user || '',
    type: entry.type || 'login',
    updatedAt: entry.updatedAt || entry.created || Date.now()
  };
}

function upsertSignupCapture(vault, entry, overwriteConfirmed = false) {
  const conflict = findSignupConflict(vault, entry);
  if (conflict && !overwriteConfirmed) {
    return { status: 'needs_confirmation', existing: conflict.existing };
  }

  if (!conflict) {
    vault.push(entry);
    return { status: 'created', entry };
  }

  const existing = conflict.existing;
  vault[conflict.index] = {
    ...existing,
    ...entry,
    id: existing.id || entry.id,
    created: existing.created || entry.created,
    updatedAt: Date.now()
  };
  return { status: 'updated', entry: vault[conflict.index], existing };
}

// Lightweight encryption helper for queued background saves.
const VaultCrypto = {
  ALGO_NAME: 'AES-GCM',
  KDF_NAME: 'PBKDF2',
  HASH_NAME: 'SHA-256',
  SALT_LEN: 16,
  IV_LEN: 12,
  ITERATIONS: 100000,
  KEY_LEN: 256,

  strToBuf: (str) => new TextEncoder().encode(str),
  genSalt: () => crypto.getRandomValues(new Uint8Array(16)),
  genIV: () => crypto.getRandomValues(new Uint8Array(12)),
  bufferToBase64: (buf) => btoa(String.fromCharCode(...buf)),

  async deriveKey(password, salt) {
    const keyMaterial = await crypto.subtle.importKey(
      "raw", this.strToBuf(password), { name: this.KDF_NAME }, false, ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      { name: this.KDF_NAME, salt, iterations: this.ITERATIONS, hash: this.HASH_NAME },
      keyMaterial,
      { name: this.ALGO_NAME, length: this.KEY_LEN },
      false, ["encrypt", "decrypt"]
    );
  },

  async encrypt(dataObj, password) {
    const salt = this.genSalt();
    const iv = this.genIV();
    const key = await this.deriveKey(password, salt);
    const dataEncoded = this.strToBuf(JSON.stringify(dataObj));
    const encryptedContent = await crypto.subtle.encrypt(
      { name: this.ALGO_NAME, iv }, key, dataEncoded
    );
    return {
      salt: this.bufferToBase64(salt),
      iv: this.bufferToBase64(iv),
      content: this.bufferToBase64(new Uint8Array(encryptedContent))
    };
  }
};

// --- COHERE AI SERVICE ---
const AIService = {
  resolveModel(settings, mode) {
    if (!settings) return '';

    if (mode === 'dom') {
      const m = settings.domModel || settings.model || '';
      if (m === 'custom') return settings.customDomModelId || settings.customModelId || '';
      return m;
    }

    const m = settings.visionModel || '';
    if (!m || m === 'disabled') return '';
    if (m === 'custom') return settings.customVisionModelId || '';
    return m;
  },

  buildSystemPrompt(mode) {
    const modeHint = mode === 'vision'
      ? 'VISION+DOM MODE: prioritize field context blocks (selector + text above/near each input).'
      : 'DOM MODE: prioritize URL, labels, input attributes, and button intent.';

    return `You are PassVault AI, a credential field detection assistant.
You analyze web page context and determine which saved credential should be used.

RULES:
- You NEVER see actual passwords, API keys, or secrets
- You only see NAMES/TAGS of saved credentials
- You analyze the page URL, form structure, and visible text
- You will receive a "url_page_type" field that classifies the page based on its URL pattern:
  - "login" = URL contains /login, /signin, /sign-in
  - "signup" = URL contains /signup, /sign-up, /register
  - "auth" = URL contains /auth (generic auth page)
  - "unknown" = No auth pattern detected in URL
- The url_page_type is a STRONG signal but should be combined with form analysis
- ${modeHint}
- You return a JSON command

RESPONSE FORMAT - You MUST return EXACTLY this JSON structure with no extra text:
{
  "thinking": {
    "is_login_or_signup_and_why": "Answer: Is this a login or signup page? Explain why based on visual evidence.",
    "what_labels_detected": "Answer: What labels/placeholders did the user get asked to enter? List each field label.",
    "is_signup_and_why": "Answer: Is this specifically a signup page? Why? Reference form fields and URL.",
    "what_we_need": "List what fields are needed based on the page. Say 'nothing' if all fields are visible.",
    "is_enough_info_and_why": "Answer: Is the information we have enough to fill all fields? Explain literally."
  },
  "answer": {
    "is_signup": true,
    "is_login": false,
    "field_values": {
      "#email": "user@example.com",
      "#name": "Iyed",
      "#password": "auto_generated_password"
    },
    "field_labels": ["Email", "Name", "Password"],
    "is_enough_info": true,
    "ui_instructions": {
      "show_tray": true,
      "show_icon": true,
      "highlight_fields": ["email", "password"],
      "toast_message": "Fields filled!"
    },
    "reasoning": "Brief explanation of your decision."
  }
}

If no match found:
{
  "thinking": { ...same structure... },
  "answer": {
    "is_signup": false,
    "is_login": false,
    "field_values": {},
    "field_labels": [],
    "is_enough_info": false,
    "ui_instructions": { "show_tray": false, "show_icon": false, "highlight_fields": [], "toast_message": "No match" },
    "reasoning": "why no match"
  }
}

IMPORTANT:
- "field_values" maps CSS selectors to the actual VALUES to insert into each field.
- Use available user profile data (name, email, etc.) to fill fields.
- For signup pages, generate appropriate values (e.g., strong password).
- If page intent is signup and no vault credential should be used, return action "none" with is_signup true.
- Never choose a credential for signup intent unless explicitly requested by context.
- When url_page_type is "login", strongly prefer is_login true and is_signup false.
- When url_page_type is "signup", strongly prefer is_signup true and is_login false.
- The "ui_instructions" object tells the content script how to adjust the UI.
- NEVER return markdown or text outside the JSON.`;
  },

  buildUserPrompt(pageContext, credentialNames) {
    const fieldContext = Array.isArray(pageContext.fieldContext) ? pageContext.fieldContext : [];
    const headings = Array.isArray(pageContext.headings) ? pageContext.headings : [];
    const pageSignals = pageContext.pageSignals || {};
    const urlPageType = pageContext.urlPageType || 'unknown';

    return `PAGE URL: ${pageContext.url}
PAGE TYPE (from URL): ${urlPageType}
PAGE TITLE: ${pageContext.title}
VISIBLE FORM FIELDS: ${JSON.stringify(pageContext.fields)}
FIELD CONTEXT (selector + nearby text): ${JSON.stringify(fieldContext)}
HEADINGS: ${JSON.stringify(headings)}
PAGE INTENT SIGNALS: ${JSON.stringify(pageSignals)}
VISIBLE LABELS: ${JSON.stringify(pageContext.labels)}
VISIBLE BUTTONS: ${JSON.stringify(pageContext.buttons)}
PAGE TEXT SNIPPET: ${pageContext.textSnippet}

SAVED CREDENTIAL NAMES (you can only pick from these):
${credentialNames.map(c => `- "${c.name}" (type: ${c.type})`).join('\n')}

Answer these in your thinking section:
1. Is this a login or signup page and why?
2. What labels did they tell the user to enter?
3. Is this specifically a signup page and why?
4. What do we need to fill?
5. Is the information we have enough? (literally say that)

Page type "${urlPageType}" is a strong signal. Return JSON only.`;
  },

  // --- VISION MODEL: Structured screenshot analysis ---
  buildVisionSystemPrompt() {
    return `You are PassVault Vision AI. You analyze screenshots of web pages to determine login/signup intent and required fields.

RESPONSE FORMAT - You MUST return EXACTLY this JSON structure with no extra text:
{
  "thinking": {
    "is_login_or_signup_and_why": "Answer: Is this a login or signup page? Explain why based on visual evidence.",
    "what_labels_detected": "Answer: What labels/placeholders did the user get asked to enter? List each field label."
  },
  "answer": {
    "is_signup": true,
    "is_login": false,
    "field_labels": ["Email", "Password"],
    "is_enough_info": true,
    "what_we_need": "List what fields are needed based on the page. Say 'nothing' if all fields are visible.",
    "reasoning": "Brief explanation of your decision."
  }
}

RULES:
- is_signup: true ONLY if the page clearly asks for registration (create account, sign up, register)
- is_login: true if the page asks for existing credentials to sign in
- field_labels: list ALL visible field labels/placeholders
- is_enough_info: true if you can see all required fields to fill
- what_we_need: describe missing info if is_enough_info is false
- NEVER return markdown or text outside the JSON`;
  },

  buildVisionUserPrompt(pageContext, userInfo) {
    const urlPageType = pageContext.urlPageType || 'unknown';
    const apiKeys = userInfo.apiKeys || {};
    const loginInfo = userInfo.login || {};

    return `PAGE TYPE (from URL): ${urlPageType}
PAGE URL: ${pageContext.url}
PAGE TITLE: ${pageContext.title}

YOUR AVAILABLE CONTEXT:
- API Keys: ${JSON.stringify(apiKeys)}
- Login Info: ${JSON.stringify(loginInfo)}
- User Info: ${JSON.stringify(userInfo.userProfile || {})}

Based on the screenshot and this context, answer:
1. Is this a signup page and why?
2. What do we need to fill?
3. Is the information we have enough to fill all fields?

Return JSON only.`;
  },

  async analyzeWithModel(pageContext, credentialNames, settings, modelId, mode) {
    if (!modelId) return { error: 'NO_MODEL' };

    const systemPrompt = this.buildSystemPrompt(mode);
    const userPrompt = this.buildUserPrompt(pageContext, credentialNames);

    try {
      const response = await fetch('https://api.cohere.com/v2/chat', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${settings.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: modelId,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.1,
          max_tokens: 500
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('Cohere API Error:', response.status, errText);
        return { error: 'API_ERROR', detail: errText };
      }

      const data = await response.json();
      let aiText = '';
      if (data.message && data.message.content) {
        for (const block of data.message.content) {
          if (block.type === 'text') aiText += block.text;
        }
      }

      const jsonMatch = aiText.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
      return { error: 'PARSE_ERROR', raw: aiText };
    } catch (e) {
      console.error('AI Service Error:', e);
      return { error: 'NETWORK_ERROR', detail: e.message };
    }
  },

  async analyze(pageContext, credentialNames, settings) {
    if (!settings || !settings.apiKey) {
      return { error: 'NO_AI_KEY', suggestion: null };
    }

    const domModel = this.resolveModel(settings, 'dom');
    const visionEnabled = settings.enableVisionFallback !== false;
    const visionModel = visionEnabled ? this.resolveModel(settings, 'vision') : '';

    const domResult = await this.analyzeWithModel(pageContext, credentialNames, settings, domModel, 'dom');
    if (domResult && domResult.action === 'fill' && domResult.credential_name) {
      return { ...domResult, stage: 'dom' };
    }
    if (domResult) {
      const domIntent = `${domResult.page_intent || domResult.form_type || ''}`.toLowerCase();
      if (/(signup|register|create)/.test(domIntent)) {
        return { ...domResult, stage: 'dom' };
      }
    }
    if (domResult && !domResult.stage) domResult.stage = 'dom';

    if (!visionModel || visionModel === domModel) {
      return domResult;
    }

    const visionResult = await this.analyzeVision(pageContext, credentialNames, settings, visionModel);
    if (visionResult && visionResult.answer && visionResult.answer.is_signup) {
      return { ...visionResult, stage: 'vision' };
    }
    if (visionResult && visionResult.answer && visionResult.answer.action === 'fill' && visionResult.answer.credential_name) {
      return { ...visionResult, stage: 'vision' };
    }
    if (visionResult && !visionResult.stage) visionResult.stage = 'vision';

    if (domResult && !domResult.error) return domResult;
    return visionResult?.error ? { ...domResult, vision_error: visionResult.error } : visionResult;
  },

  // --- VISION ANALYSIS: Screenshot-based analysis with structured JSON ---
  async analyzeVision(pageContext, credentialNames, settings, modelId) {
    if (!modelId) return { error: 'NO_VISION_MODEL' };
    if (!settings || !settings.apiKey) return { error: 'NO_AI_KEY' };

    const systemPrompt = this.buildVisionSystemPrompt();
    const userInfo = settings.userInfo || {};
    const userPrompt = this.buildVisionUserPrompt(pageContext, userInfo);

    // Capture screenshot if image provided
    const imageData = pageContext.screenshotBase64;

    try {
      const messages = [
        { role: 'system', content: systemPrompt }
      ];

      // If we have a screenshot, send it as an image
      if (imageData) {
        messages.push({
          role: 'user',
          content: [
            { type: 'image', image_url: { url: `data:image/png;base64,${imageData}` } },
            { type: 'text', text: userPrompt }
          ]
        });
      } else {
        messages.push({ role: 'user', content: userPrompt });
      }

      const response = await fetch('https://api.cohere.com/v2/chat', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${settings.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: modelId,
          messages: messages,
          temperature: 0.1,
          max_tokens: 800
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('Vision AI API Error:', response.status, errText);
        return { error: 'API_ERROR', detail: errText };
      }

      const data = await response.json();
      let aiText = '';
      if (data.message && data.message.content) {
        for (const block of data.message.content) {
          if (block.type === 'text') aiText += block.text;
        }
      }

      const jsonMatch = aiText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      return { error: 'PARSE_ERROR', raw: aiText };
    } catch (e) {
      console.error('Vision AI Error:', e);
      return { error: 'NETWORK_ERROR', detail: e.message };
    }
  }
};

function persistSignupEntry(entry, options = {}) {
  const overwriteConfirmed = !!options.overwriteConfirmed;
  const normalizedEntry = { ...entry, id: crypto.randomUUID(), created: Date.now() };
  const writePromise = saveQueue.then(async () => {
    const result = upsertSignupCapture(sessionVault, normalizedEntry, overwriteConfirmed);
    if (result.status === 'needs_confirmation') {
      return {
        status: 'needs_confirmation',
        existing: sanitizeConflict(result.existing)
      };
    }
    const encryptedVault = await VaultCrypto.encrypt(sessionVault, masterPassword);
    await new Promise((resolve) => chrome.storage.local.set({ secureVault: encryptedVault }, resolve));
    return {
      status: result.status,
      overwritten: result.status === 'updated'
    };
  });

  saveQueue = writePromise.catch(() => { });
  return writePromise;
}


// --- MESSAGE HANDLER ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.action === 'cache_master') {
    masterPassword = msg.masterPassword || masterPassword;
    if (msg.vault) sessionVault = msg.vault;
    if (msg.aiSettings) aiSettings = msg.aiSettings;
    sendResponse({ success: true });
    return;
  }

  if (msg.action === 'clear_master') {
    masterPassword = null;
    sessionVault = null;
    aiSettings = null;
    sendResponse({ success: true });
    return;
  }

  if (msg.action === 'is_unlocked') {
    sendResponse({ success: true, unlocked: !!(sessionVault && masterPassword) });
    return;
  }

  // 1. Popup sends decrypted vault here when unlocked
  if (msg.action === 'update_session') {
    sessionVault = msg.vault;
    if (msg.aiSettings) aiSettings = msg.aiSettings;
    if (msg.masterPassword) masterPassword = msg.masterPassword;
    console.log("Session updated:", sessionVault ? sessionVault.length : 0, "entries");
    sendResponse({ success: true });
    return;
  }

  // 2. Content Script tray requests credentials (BASIC: domain match)
  if (msg.action === 'request_autofill') {
    if (!sessionVault) {
      sendResponse({ success: false, error: "LOCKED" });
      return;
    }

    const tabUrl = sender.tab.url;
    const hostname = getDomain(tabUrl);

    const match = pickBestVaultEntry(sessionVault, hostname);

    if (match) {
      chrome.tabs.sendMessage(sender.tab.id, {
        action: 'fillCredentials',
        user: match.user || '',
        pass: match.pass || match.apiKey || '',
        type: match.type || 'login'
      });
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: "NO_MATCH" });
    }
    return;
  }

  // 3. Content Script requests AI-powered credential matching
  if (msg.action === 'request_ai_autofill') {
    if (!sessionVault) {
      sendResponse({ success: false, error: "LOCKED" });
      return;
    }
    if (!aiSettings || !aiSettings.apiKey) {
      sendResponse({ success: false, error: "NO_AI_KEY" });
      return;
    }

    // Build credential name list (NEVER send actual secrets to AI)
    const credentialNames = sessionVault.map(e => ({
      name: e.site,
      type: e.type || 'login'
    }));

    // Call AI asynchronously
    AIService.analyze(msg.pageContext, credentialNames, aiSettings)
      .then(aiResult => {
        if (aiResult.error) {
          const maybeSignupFromContext = !!(
            msg.pageContext &&
            msg.pageContext.pageSignals &&
            msg.pageContext.pageSignals.signup_phrase &&
            !msg.pageContext.pageSignals.has_confirm_password
          );
          if (maybeSignupFromContext) {
            sendResponse({ success: false, error: "SIGNUP_PAGE", method: 'heuristic' });
            return;
          }

          // Fallback to domain matching
          const hostname = getDomain(sender.tab.url);
          const fallback = pickBestVaultEntry(sessionVault, hostname);
          if (fallback) {
            chrome.tabs.sendMessage(sender.tab.id, {
              action: 'fillCredentials',
              user: fallback.user || '',
              pass: fallback.pass || fallback.apiKey || '',
              type: fallback.type || 'login'
            });
            sendResponse({ success: true, method: 'fallback' });
          } else {
            sendResponse({ success: false, error: "NO_MATCH", aiError: aiResult.error });
          }
          return;
        }

        // New structure: use answer.is_signup directly
        const answer = aiResult.answer || {};
        const thinking = aiResult.thinking || {};
        const aiIsSignup = answer.is_signup || false;
        const aiIsLogin = answer.is_login || false;
        const uiInstructions = answer.ui_instructions || {};

        if (aiIsSignup) {
          sendResponse({
            success: false,
            error: "SIGNUP_PAGE",
            method: aiResult.stage === 'vision' ? 'vision' : 'ai',
            reasoning: thinking.is_signup_and_why || answer.reasoning || '',
            thinking: thinking,
            answer: answer,
            ui_instructions: uiInstructions,
            field_values: answer.field_values || {},
            field_labels: answer.field_labels || [],
            is_enough_info: answer.is_enough_info || false
          });
          return;
        }

        if (answer.action === 'fill' && answer.credential_name) {
          // AI found a match - look up actual credentials locally
          const match = pickBestVaultEntry(sessionVault, answer.credential_name);

          if (match) {
            chrome.tabs.sendMessage(sender.tab.id, {
              action: 'fillCredentials',
              user: match.user || '',
              pass: match.pass || match.apiKey || '',
              type: match.type || 'login',
              fieldMapping: answer.field_mapping || null,
              aiConfidence: answer.confidence,
              ui_instructions: uiInstructions,
              field_values: answer.field_values || {}
            });
            sendResponse({
              success: true,
              method: aiResult.stage === 'vision' ? 'vision' : 'ai',
              confidence: answer.confidence,
              thinking: thinking,
              answer: answer
            });
          } else {
            sendResponse({
              success: false,
              error: "AI_NO_MATCH",
              reasoning: answer.reasoning,
              thinking: thinking,
              answer: answer,
              ui_instructions: uiInstructions
            });
          }
        } else {
          sendResponse({
            success: false,
            error: "AI_DECLINED",
            reasoning: answer.reasoning,
            thinking: thinking,
            answer: answer,
            ui_instructions: uiInstructions
          });
        }
      })
      .catch(err => {
        sendResponse({ success: false, error: "AI_CRASH", detail: err.message });
      });

    return true; // Keep channel open for async response
  }
  // 4. Handle "Save Signup" from Content Script
  if (msg.action === 'save_signup') {
    if (!sessionVault || !masterPassword) {
      sendResponse({ success: false, error: "LOCKED" });
      return;
    }

    persistSignupEntry(msg.entry, { overwriteConfirmed: !!msg.overwriteConfirmed })
      .then((result) => {
        if (result.status === 'needs_confirmation') {
          sendResponse({
            success: false,
            error: "OVERWRITE_CONFIRM_REQUIRED",
            existing: result.existing
          });
          return;
        }
        sendResponse({
          success: true,
          overwritten: !!result.overwritten
        });
      })
      .catch((err) => {
        console.error("Signup save failed:", err);
        sendResponse({ success: false, error: "SAVE_FAILED", detail: err.message });
      });

    return true; // async response
  }

  if (msg.action === 'queue_signup_pending') {
    if (!sessionVault || !masterPassword) {
      sendResponse({ success: false, error: "LOCKED" });
      return;
    }
    if (!msg.overwriteConfirmed) {
      const conflict = findSignupConflict(sessionVault, msg.entry || {});
      if (conflict) {
        sendResponse({
          success: false,
          error: "OVERWRITE_CONFIRM_REQUIRED",
          existing: sanitizeConflict(conflict.existing)
        });
        return;
      }
    }

    pendingSignup = {
      entry: msg.entry,
      startUrl: msg.startUrl || '',
      queuedAt: Date.now(),
      overwriteConfirmed: !!msg.overwriteConfirmed
    };
    sendResponse({ success: true });
    return;
  }

  if (msg.action === 'flush_pending_signup') {
    if (!sessionVault || !masterPassword) {
      sendResponse({ success: false, error: "LOCKED" });
      return;
    }
    if (!pendingSignup || !pendingSignup.entry) {
      sendResponse({ success: false, error: "NO_PENDING" });
      return;
    }

    const currentUrl = msg.currentUrl || '';
    const force = !!msg.force;
    const shouldFlush = force || (pendingSignup.startUrl && currentUrl && pendingSignup.startUrl !== currentUrl);
    if (!shouldFlush) {
      sendResponse({ success: false, error: "NOT_READY" });
      return;
    }

    const entry = pendingSignup.entry;
    const overwriteConfirmed = !!pendingSignup.overwriteConfirmed;
    pendingSignup = null;
    persistSignupEntry(entry, { overwriteConfirmed })
      .then((result) => {
        if (result.status === 'needs_confirmation') {
          sendResponse({
            success: false,
            error: "OVERWRITE_CONFIRM_REQUIRED",
            existing: result.existing
          });
          return;
        }
        sendResponse({ success: true, overwritten: !!result.overwritten });
      })
      .catch((err) => {
        console.error("Pending signup flush failed:", err);
        sendResponse({ success: false, error: "SAVE_FAILED", detail: err.message });
      });
    return true;
  }
});
