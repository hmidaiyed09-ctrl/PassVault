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
- ${modeHint}
- You return a JSON command

RESPONSE FORMAT (strict JSON only, no markdown):
{
  "action": "fill_or_none (use exactly fill or none)",
  "page_intent": "signup_or_login_or_unknown (use exactly signup or login or unknown)",
  "confidence": 0.95,
  "credential_name": "the_best_matching_credential_name_or_null",
  "reasoning": "brief explanation",
  "field_mapping": {
    "username_selector": "suggested CSS selector or null",
    "password_selector": "suggested CSS selector or null"
  },
  "input_roles": [
    {"selector": "css selector", "role": "full_name|first_name|last_name|email|username|password|phone|address|unknown", "reason": "short reason"}
  ],
  "form_type": "login_or_signup_or_unknown (use exactly login or signup or unknown)"
}

If no match found:
{"action": "none", "page_intent": "signup_or_login_or_unknown", "reasoning": "why no match", "input_roles": []}

IMPORTANT:
- If page intent is signup and no vault credential should be used, return action "none", page_intent "signup", and include input_roles.
- Never choose a credential for signup intent unless explicitly requested by context.`;
  },

  buildUserPrompt(pageContext, credentialNames) {
    const fieldContext = Array.isArray(pageContext.fieldContext) ? pageContext.fieldContext : [];
    const headings = Array.isArray(pageContext.headings) ? pageContext.headings : [];
    const pageSignals = pageContext.pageSignals || {};
    return `PAGE URL: ${pageContext.url}
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

Classify page intent first (signup/login/unknown), then decide credential action. Return JSON only.`;
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

    const visionResult = await this.analyzeWithModel(pageContext, credentialNames, settings, visionModel, 'vision');
    if (visionResult && visionResult.action === 'fill' && visionResult.credential_name) {
      return { ...visionResult, stage: 'vision' };
    }
    if (visionResult && !visionResult.stage) visionResult.stage = 'vision';

    if (domResult && !domResult.error) return domResult;
    return visionResult?.error ? { ...domResult, vision_error: visionResult.error } : visionResult;
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

        const intentRaw = `${aiResult.page_intent || aiResult.form_type || ''}`.toLowerCase();
        const aiDetectsSignup = /(signup|register|create)/.test(intentRaw);
        if (aiDetectsSignup) {
          sendResponse({
            success: false,
            error: "SIGNUP_PAGE",
            method: aiResult.stage === 'vision' ? 'vision' : 'ai',
            reasoning: aiResult.reasoning || '',
            inputRoles: Array.isArray(aiResult.input_roles) ? aiResult.input_roles : []
          });
          return;
        }

        if (aiResult.action === 'fill' && aiResult.credential_name) {
          // AI found a match - look up actual credentials locally
          const match = pickBestVaultEntry(sessionVault, aiResult.credential_name);

          if (match) {
            chrome.tabs.sendMessage(sender.tab.id, {
              action: 'fillCredentials',
              user: match.user || '',
              pass: match.pass || match.apiKey || '',
              type: match.type || 'login',
              fieldMapping: aiResult.field_mapping || null,
              aiConfidence: aiResult.confidence
            });
            sendResponse({ success: true, method: aiResult.stage === 'vision' ? 'vision' : 'ai', confidence: aiResult.confidence });
          } else {
            sendResponse({ success: false, error: "AI_NO_MATCH", reasoning: aiResult.reasoning });
          }
        } else {
          sendResponse({ success: false, error: "AI_DECLINED", reasoning: aiResult.reasoning });
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
