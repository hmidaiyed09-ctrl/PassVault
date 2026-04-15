// --- CRYPTO SERVICE (ZERO KNOWLEDGE) ---
const CryptoService = {
  ALGO_NAME: 'AES-GCM',
  KDF_NAME: 'PBKDF2',
  HASH_NAME: 'SHA-256',
  SALT_LEN: 16,
  IV_LEN: 12,
  ITERATIONS: 100000,
  KEY_LEN: 256,

  strToBuf: (str) => new TextEncoder().encode(str),
  bufToStr: (buf) => new TextDecoder().decode(buf),
  genSalt: () => window.crypto.getRandomValues(new Uint8Array(CryptoService.SALT_LEN)),
  genIV: () => window.crypto.getRandomValues(new Uint8Array(CryptoService.IV_LEN)),

  async deriveKey(password, salt) {
    const keyMaterial = await window.crypto.subtle.importKey(
      "raw", this.strToBuf(password), { name: this.KDF_NAME }, false, ["deriveKey"]
    );
    return window.crypto.subtle.deriveKey(
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
    const encryptedContent = await window.crypto.subtle.encrypt(
      { name: this.ALGO_NAME, iv }, key, dataEncoded
    );
    return {
      salt: this.bufferToBase64(salt),
      iv: this.bufferToBase64(iv),
      content: this.bufferToBase64(new Uint8Array(encryptedContent))
    };
  },

  async decrypt(encryptedPkg, password) {
    try {
      const salt = this.base64ToBuffer(encryptedPkg.salt);
      const iv = this.base64ToBuffer(encryptedPkg.iv);
      const content = this.base64ToBuffer(encryptedPkg.content);
      const key = await this.deriveKey(password, salt);
      const decryptedBuffer = await window.crypto.subtle.decrypt(
        { name: this.ALGO_NAME, iv }, key, content
      );
      return JSON.parse(this.bufToStr(decryptedBuffer));
    } catch (e) {
      console.error("Decryption failed:", e);
      throw new Error("Incorrect Password or Corrupted Data");
    }
  },

  bufferToBase64: (buf) => btoa(String.fromCharCode(...buf)),
  base64ToBuffer: (str) => {
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
};

// --- PASSWORD GENERATOR ---
const PasswordGen = {
  UPPER: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  LOWER: 'abcdefghijklmnopqrstuvwxyz',
  DIGITS: '0123456789',
  SYMBOLS: '!@#$%^&*_-+=?',

  generate(length = 20) {
    const all = this.UPPER + this.LOWER + this.DIGITS + this.SYMBOLS;
    const arr = new Uint32Array(length);
    window.crypto.getRandomValues(arr);

    // Ensure at least one of each type
    let password = '';
    password += this.UPPER[arr[0] % this.UPPER.length];
    password += this.LOWER[arr[1] % this.LOWER.length];
    password += this.DIGITS[arr[2] % this.DIGITS.length];
    password += this.SYMBOLS[arr[3] % this.SYMBOLS.length];

    for (let i = 4; i < length; i++) {
      password += all[arr[i] % all.length];
    }

    // Shuffle
    const shuffled = password.split('');
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = arr[i] % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.join('');
  }
};

// --- ORACLE CLOUD SYNC SERVICE ---
const OracleCloudSync = {
  async push(ordsBaseUrl, username, password, userId, vaultBlob) {
    const url = `${ordsBaseUrl.replace(/\/+$/, '')}/vault/`;
    const auth = btoa(`${username}:${password}`);

    // Try PUT (update) first, then POST (insert) if not found
    const putResp = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        user_id: userId,
        vault_blob: JSON.stringify(vaultBlob),
        updated_at: new Date().toISOString()
      })
    });

    if (putResp.ok) return { success: true, method: 'updated' };

    // If PUT fails, try POST (first time)
    const postResp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        user_id: userId,
        vault_blob: JSON.stringify(vaultBlob),
        updated_at: new Date().toISOString()
      })
    });

    if (!postResp.ok) {
      const errText = await postResp.text();
      throw new Error(`Cloud push failed: ${postResp.status} ${errText}`);
    }
    return { success: true, method: 'created' };
  },

  async pull(ordsBaseUrl, username, password, userId) {
    const url = `${ordsBaseUrl.replace(/\/+$/, '')}/vault/${encodeURIComponent(userId)}`;
    const auth = btoa(`${username}:${password}`);

    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json'
      }
    });

    if (resp.status === 404) return null; // No cloud data yet

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Cloud pull failed: ${resp.status} ${errText}`);
    }

    const data = await resp.json();
    if (data.vault_blob) {
      return typeof data.vault_blob === 'string' ? JSON.parse(data.vault_blob) : data.vault_blob;
    }
    return null;
  }
};

// --- APP STATE ---
const App = {
  vault: [],
  masterPassword: null,
  isNewUser: false,
  activeCategory: 'all',
  saveQueue: Promise.resolve(),
  cloudSettings: {
    ordsBaseUrl: '',
    username: 'ADMIN',
    password: '',
    autoSync: false
  },
  aiSettings: {
    apiKey: '',
    model: 'command-a-03-2025', // legacy fallback
    customModelId: '', // legacy fallback
    domModel: 'command-a-03-2025',
    customDomModelId: '',
    visionModel: 'c4ai-aya-vision-32b',
    customVisionModelId: '',
    enableVisionFallback: true,
    autoDetect: true,
    apiMatch: true
  },

  views: {
    login: document.getElementById('view-login'),
    vault: document.getElementById('view-vault'),
    entry: document.getElementById('view-entry'),
    signup: document.getElementById('view-signup'),
    settings: document.getElementById('view-settings')
  },

  TYPE_CONFIG: {
    login: { icon: '🔑', label: 'LOGIN' },
    api_key: { icon: '🔗', label: 'API' },
    note: { icon: '📝', label: 'NOTE' }
  },

  init() {
    this.bindEvents();
    this.checkStorage();
  },

  bindEvents() {
    // Auth
    document.getElementById('authBtn').addEventListener('click', () => this.handleAuth());
    document.getElementById('masterPassword').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.handleAuth();
    });
    document.getElementById('toggleMasterPass').addEventListener('click', () => {
      const el = document.getElementById('masterPassword');
      el.type = el.type === 'password' ? 'text' : 'password';
    });

    // Navigation
    document.getElementById('addEntryFab').addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = document.getElementById('fabMenu');
      menu.style.display = menu.style.display === 'none' ? 'flex' : 'none';
    });
    document.querySelectorAll('.fab-menu-item').forEach(btn => {
      btn.addEventListener('click', () => {
        document.getElementById('fabMenu').style.display = 'none';
        this.showEntryForm(null, btn.dataset.type);
      });
    });
    document.addEventListener('click', () => {
      document.getElementById('fabMenu').style.display = 'none';
    });
    document.getElementById('quickSignupFab').addEventListener('click', () => this.showSignupView());
    document.getElementById('backToVaultBtn').addEventListener('click', () => this.showView('vault'));
    document.getElementById('backFromSignupBtn').addEventListener('click', () => this.showView('vault'));
    document.getElementById('lockBtn').addEventListener('click', () => this.lockVault());
    document.getElementById('settingsBtn').addEventListener('click', () => this.showSettingsView());
    document.getElementById('backFromSettingsBtn').addEventListener('click', () => this.showView('vault'));

    // Entry Form
    document.getElementById('entryForm').addEventListener('submit', (e) => this.handleSaveEntry(e));
    document.getElementById('togglePassVisibility').addEventListener('click', () => {
      const el = document.getElementById('entryPass');
      el.type = el.type === 'password' ? 'text' : 'password';
    });
    document.getElementById('toggleApiVisibility').addEventListener('click', () => {
      const el = document.getElementById('entryApiKey');
      el.type = el.type === 'password' ? 'text' : 'password';
    });
    document.getElementById('deleteEntryBtn').addEventListener('click', () => this.handleDeleteEntry());
    document.getElementById('entryType').addEventListener('change', (e) => this.handleTypeSwitch(e.target.value));

    // Search
    document.getElementById('searchInput').addEventListener('input', () => this.renderVault());

    // Category Pills
    document.querySelectorAll('.cat-pill').forEach(pill => {
      pill.addEventListener('click', (e) => {
        document.querySelectorAll('.cat-pill').forEach(p => p.classList.remove('active'));
        e.target.classList.add('active');
        this.activeCategory = e.target.dataset.cat;
        this.renderVault();
      });
    });

    // Autofill
    document.getElementById('autofillBtn').addEventListener('click', () => this.handleAutofill());

    // Cloud Sync
    document.getElementById('cloudSyncBtn').addEventListener('click', () => this.handleCloudSync());
    document.getElementById('toggleOrdsPass').addEventListener('click', () => {
      const el = document.getElementById('ordsPassword');
      el.type = el.type === 'password' ? 'text' : 'password';
    });

    // Cloud Restore
    document.getElementById('restoreFromCloudBtn').addEventListener('click', () => this.handleCloudRestore());

    // Copy Utils
    document.querySelectorAll('.copy-input-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const targetId = e.target.dataset.target;
        const val = document.getElementById(targetId).value;
        navigator.clipboard.writeText(val);
        const orig = e.target.textContent;
        e.target.textContent = '✓';
        setTimeout(() => e.target.textContent = orig, 1000);
      });
    });

    // Settings
    document.getElementById('saveSettingsBtn').addEventListener('click', () => this.saveSettings());
    document.getElementById('cohereModel').addEventListener('change', (e) => {
      document.getElementById('customModelWrap').style.display = e.target.value === 'custom' ? 'block' : 'none';
    });
    document.getElementById('cohereVisionModel').addEventListener('change', (e) => {
      document.getElementById('customVisionModelWrap').style.display = e.target.value === 'custom' ? 'block' : 'none';
    });
    document.getElementById('toggleCohereKey').addEventListener('click', () => {
      const el = document.getElementById('cohereApiKey');
      el.type = el.type === 'password' ? 'text' : 'password';
    });

    // Signup Form
    document.getElementById('signupForm').addEventListener('submit', (e) => this.handleSignup(e));
    document.getElementById('regenPasswordBtn').addEventListener('click', () => {
      document.getElementById('suPassword').value = PasswordGen.generate(20);
    });
  },

  handleTypeSwitch(type) {
    document.getElementById('login-fields').style.display = type === 'login' ? 'flex' : 'none';
    document.getElementById('api-fields').style.display = type === 'api_key' ? 'flex' : 'none';
    document.getElementById('note-fields').style.display = type === 'note' ? 'flex' : 'none';
  },

  normalizeSite(value) {
    if (!value) return '';
    return String(value)
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0];
  },

  matchScore(hostname, site) {
    if (!hostname || !site) return -1;
    if (hostname === site) return 4;
    if (hostname.endsWith(`.${site}`) || site.endsWith(`.${hostname}`)) return 3;
    if (hostname.includes(site) || site.includes(hostname)) return 2;
    return -1;
  },

  pickBestVaultMatch(hostOrSite) {
    const target = this.normalizeSite(hostOrSite);
    if (!target) return null;

    const candidates = this.vault
      .map((entry) => {
        const site = this.normalizeSite(entry.site);
        return { entry, score: this.matchScore(target, site) };
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
  },

  upsertLoginEntry(newEntry) {
    const site = this.normalizeSite(newEntry.site);
    const user = (newEntry.user || '').trim().toLowerCase();
    const index = this.vault.findIndex((entry) => {
      if ((entry.type || 'login') !== 'login') return false;
      if (this.normalizeSite(entry.site) !== site) return false;
      if (!user) return true;
      return (entry.user || '').trim().toLowerCase() === user;
    });

    if (index === -1) {
      this.vault.push(newEntry);
      return;
    }

    const existing = this.vault[index];
    this.vault[index] = {
      ...existing,
      ...newEntry,
      id: existing.id || newEntry.id,
      created: existing.created || newEntry.created,
      updatedAt: Date.now()
    };
  },

  findLoginDuplicate(entryLike) {
    const site = this.normalizeSite(entryLike.site);
    const user = (entryLike.user || '').trim().toLowerCase();
    const idx = this.vault.findIndex((entry) => {
      if ((entry.type || 'login') !== 'login') return false;
      if (this.normalizeSite(entry.site) !== site) return false;
      if (!user) return true;
      return (entry.user || '').trim().toLowerCase() === user;
    });
    if (idx === -1) return null;
    return { index: idx, entry: this.vault[idx] };
  },

  compactDuplicateLogins() {
    const sorted = [...this.vault].sort((a, b) => {
      const bTs = b.updatedAt || b.created || 0;
      const aTs = a.updatedAt || a.created || 0;
      return bTs - aTs;
    });

    const seen = new Set();
    const kept = [];
    for (const entry of sorted) {
      if ((entry.type || 'login') !== 'login') {
        kept.push(entry);
        continue;
      }

      const key = `login|${this.normalizeSite(entry.site)}|${(entry.user || '').trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(entry);
    }

    if (kept.length === this.vault.length) return false;

    this.vault = kept.sort((a, b) => (a.created || 0) - (b.created || 0));
    return true;
  },

  async checkStorage() {
    chrome.storage.local.get(['secureVault'], (result) => {
      if (!result.secureVault) {
        this.isNewUser = true;
        document.getElementById('auth-title').textContent = "Create PassVault";
        document.getElementById('auth-subtitle').textContent = "Set a strong master password.";
        document.getElementById('authBtn').textContent = "Create Vault";
        document.getElementById('setup-warning').style.display = 'block';
        document.getElementById('cloud-restore-section').style.display = 'block';
      }
      this.showView('login');
    });
  },

  async handleAuth() {
    const password = document.getElementById('masterPassword').value;
    const errorEl = document.getElementById('auth-error');
    if (!password) { errorEl.textContent = "Password cannot be empty"; return; }
    errorEl.textContent = "Decrypting...";

    if (this.isNewUser) {
      this.masterPassword = password;
      this.vault = [];
      await this.saveVaultToDisk();
      this.unlockUI();
    } else {
      chrome.storage.local.get(['secureVault', 'secureSettings', 'aiSettings'], async (result) => {
        try {
          this.vault = await CryptoService.decrypt(result.secureVault, password);
          this.masterPassword = password;
          await this.loadAISettingsFromStorage(result);
          await this.loadCloudSettingsFromStorage();
          const compacted = this.compactDuplicateLogins();
          if (compacted) await this.saveVaultToDisk();
          this.unlockUI();
        } catch (e) {
          errorEl.textContent = "Incorrect password.";
          document.getElementById('masterPassword').value = '';
        }
      });
    }
  },

  unlockUI() {
    document.getElementById('masterPassword').value = '';
    document.getElementById('auth-error').textContent = '';
    document.getElementById('lockBtn').style.display = 'block';
    document.getElementById('cloudSyncBtn').style.display = 'block';
    document.getElementById('settingsBtn').style.display = 'block';

    chrome.runtime.sendMessage({
      action: 'cache_master',
      masterPassword: this.masterPassword,
      vault: this.vault,
      aiSettings: this.aiSettings
    });

    if (this.aiSettings.apiKey) {
      document.getElementById('ai-status').style.display = 'flex';
      document.getElementById('ai-status-text').textContent = `AI: ${this.aiSettings.domModel || this.aiSettings.model}`;
    }

    this.showView('vault');
    this.renderVault();
  },

  lockVault() {
    this.vault = [];
    this.masterPassword = null;
    chrome.runtime.sendMessage({ action: 'clear_master' });
    document.getElementById('lockBtn').style.display = 'none';
    document.getElementById('settingsBtn').style.display = 'none';
    document.getElementById('cloudSyncBtn').style.display = 'none';
    document.getElementById('ai-status').style.display = 'none';
    this.showView('login');
  },

  showView(viewName) {
    Object.values(this.views).forEach(el => el.classList.remove('active'));
    this.views[viewName].classList.add('active');
  },

  saveVaultToDisk() {
    if (!this.masterPassword) return Promise.resolve();
    const vaultSnapshot = this.vault.map((entry) => ({ ...entry }));
    const passwordSnapshot = this.masterPassword;
    const settingsSnapshot = { ...this.aiSettings };

    this.saveQueue = this.saveQueue.then(async () => {
      const encrypted = await CryptoService.encrypt(vaultSnapshot, passwordSnapshot);
      await new Promise((resolve) => chrome.storage.local.set({ secureVault: encrypted }, resolve));
      chrome.runtime.sendMessage({
        action: 'update_session',
        vault: vaultSnapshot,
        aiSettings: settingsSnapshot
      });
      // Auto-sync to cloud
      if (this.cloudSettings.autoSync && this.cloudSettings.ordsBaseUrl && this.cloudSettings.password) {
        this.pushToCloud().catch(e => console.warn("Auto cloud sync failed:", e));
      }
    }).catch((e) => {
      console.error("Save failed", e);
      alert("Critical Error: Could not save vault.");
    });

    return this.saveQueue;
  },

  saveSettingsToDisk() {
    if (!this.masterPassword) return Promise.resolve();
    const passwordSnapshot = this.masterPassword;
    const settingsSnapshot = { ...this.aiSettings };
    const vaultSnapshot = this.vault.map((entry) => ({ ...entry }));

    this.saveQueue = this.saveQueue.then(async () => {
      const encryptedSettings = await CryptoService.encrypt(settingsSnapshot, passwordSnapshot);
      await new Promise((resolve) => chrome.storage.local.set({ secureSettings: encryptedSettings }, resolve));
      chrome.storage.local.remove('aiSettings');

      chrome.runtime.sendMessage({
        action: 'cache_master',
        masterPassword: passwordSnapshot,
        vault: vaultSnapshot,
        aiSettings: settingsSnapshot
      });
      chrome.runtime.sendMessage({
        action: 'update_session',
        vault: vaultSnapshot,
        aiSettings: settingsSnapshot
      });
    }).catch((e) => {
      console.error("Settings save failed", e);
    });

    return this.saveQueue;
  },

  saveCloudSettingsToDisk() {
    if (!this.masterPassword) return;
    const passwordSnapshot = this.masterPassword;
    const cloudSnapshot = { ...this.cloudSettings };
    CryptoService.encrypt(cloudSnapshot, passwordSnapshot).then(encrypted => {
      chrome.storage.local.set({ secureCloudSettings: encrypted });
    });
  },

  async loadCloudSettingsFromStorage() {
    return new Promise(resolve => {
      chrome.storage.local.get(['secureCloudSettings'], async (result) => {
        if (result.secureCloudSettings) {
          try {
            const decrypted = await CryptoService.decrypt(result.secureCloudSettings, this.masterPassword);
            this.cloudSettings = { ordsBaseUrl: '', username: 'ADMIN', password: '', autoSync: false, ...decrypted };
          } catch (e) {
            console.warn("Failed to decrypt cloud settings", e);
          }
        }
        resolve();
      });
    });
  },

  async loadAISettingsFromStorage(storageResult) {
    const defaults = {
      apiKey: '',
      model: 'command-a-03-2025',
      customModelId: '',
      domModel: 'command-a-03-2025',
      customDomModelId: '',
      visionModel: 'c4ai-aya-vision-32b',
      customVisionModelId: '',
      enableVisionFallback: true,
      autoDetect: true,
      apiMatch: true
    };

    // Preferred source: encrypted settings bound to the master password.
    if (storageResult.secureSettings) {
      try {
        const decrypted = await CryptoService.decrypt(storageResult.secureSettings, this.masterPassword);
        this.aiSettings = { ...defaults, ...decrypted };
        return;
      } catch (e) {
        console.warn("Failed to decrypt secure settings. Falling back to migration path.", e);
      }
    }

    // Legacy source: plaintext settings. Migrate once.
    if (storageResult.aiSettings) {
      this.aiSettings = { ...defaults, ...storageResult.aiSettings };
      await this.saveSettingsToDisk();
      return;
    }

    this.aiSettings = defaults;
  },

  // --- SETTINGS ---
  showSettingsView() {
    document.getElementById('cohereApiKey').value = this.aiSettings.apiKey;
    document.getElementById('cohereModel').value = this.aiSettings.domModel || this.aiSettings.model || 'command-a-03-2025';
    document.getElementById('cohereVisionModel').value = this.aiSettings.visionModel || 'c4ai-aya-vision-32b';
    document.getElementById('customModelId').value = this.aiSettings.customDomModelId || this.aiSettings.customModelId || '';
    document.getElementById('customVisionModelId').value = this.aiSettings.customVisionModelId || '';
    document.getElementById('aiAutoDetect').checked = this.aiSettings.autoDetect;
    document.getElementById('aiApiMatch').checked = this.aiSettings.apiMatch;
    document.getElementById('aiVisionFallback').checked = this.aiSettings.enableVisionFallback !== false;
    document.getElementById('customModelWrap').style.display =
      (this.aiSettings.domModel || this.aiSettings.model) === 'custom' ? 'block' : 'none';
    document.getElementById('customVisionModelWrap').style.display =
      (this.aiSettings.visionModel || '') === 'custom' ? 'block' : 'none';
    document.getElementById('ordsBaseUrl').value = this.cloudSettings.ordsBaseUrl || '';
    document.getElementById('ordsUsername').value = this.cloudSettings.username || 'ADMIN';
    document.getElementById('ordsPassword').value = this.cloudSettings.password || '';
    document.getElementById('cloudAutoSync').checked = this.cloudSettings.autoSync || false;
    this.showView('settings');
  },

  saveSettings() {
    if (!this.masterPassword) {
      alert("Unlock vault first.");
      return;
    }

    this.aiSettings = {
      apiKey: document.getElementById('cohereApiKey').value,
      model: document.getElementById('cohereModel').value, // legacy
      customModelId: document.getElementById('customModelId').value, // legacy
      domModel: document.getElementById('cohereModel').value,
      customDomModelId: document.getElementById('customModelId').value,
      visionModel: document.getElementById('cohereVisionModel').value,
      customVisionModelId: document.getElementById('customVisionModelId').value,
      enableVisionFallback: document.getElementById('aiVisionFallback').checked,
      autoDetect: document.getElementById('aiAutoDetect').checked,
      apiMatch: document.getElementById('aiApiMatch').checked
    };
    this.cloudSettings = {
      ordsBaseUrl: document.getElementById('ordsBaseUrl').value.trim(),
      username: document.getElementById('ordsUsername').value.trim() || 'ADMIN',
      password: document.getElementById('ordsPassword').value,
      autoSync: document.getElementById('cloudAutoSync').checked
    };
    this.saveCloudSettingsToDisk();
    this.saveSettingsToDisk();

    const status = document.getElementById('settings-status');
    status.textContent = '✓ Settings saved';
    setTimeout(() => status.textContent = '', 2000);

    if (this.aiSettings.apiKey) {
      document.getElementById('ai-status').style.display = 'flex';
      document.getElementById('ai-status-text').textContent = `AI: ${this.aiSettings.domModel}`;
    }
  },

  // --- QUICK SIGNUP ---
  showSignupView() {
    document.getElementById('signupForm').reset();
    document.getElementById('suPassword').value = PasswordGen.generate(20);

    // Pre-fill Identity from storage
    chrome.storage.local.get('userProfile', (res) => {
      if (res.userProfile) {
        const p = res.userProfile;
        document.getElementById('suFirstName').value = p.firstName || '';
        document.getElementById('suLastName').value = p.lastName || '';
        document.getElementById('suEmail').value = p.email || '';
        document.getElementById('suUsername').value = p.username || '';
        document.getElementById('suAddress').value = p.address || '';
        document.getElementById('suCity').value = p.city || '';
        document.getElementById('suPhone').value = p.phone || '';
      }
    });

    // Try to get current tab URL for context
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        try {
          const hostname = new URL(tabs[0].url).hostname.replace('www.', '');
          document.getElementById('signup-site-label').textContent =
            `Signing up on: ${hostname}`;
        } catch {
          document.getElementById('signup-site-label').textContent =
            'Fill the fields, we auto-generate a password and save it.';
        }
      }
    });

    this.showView('signup');
  },

  async handleSignup(e) {
    e.preventDefault();

    // Extract data
    const firstName = document.getElementById('suFirstName').value.trim();
    const lastName = document.getElementById('suLastName').value.trim();
    const username = document.getElementById('suUsername').value.trim();
    const email = document.getElementById('suEmail').value.trim();
    const password = document.getElementById('suPassword').value;
    const address = document.getElementById('suAddress').value.trim();
    const city = document.getElementById('suCity').value.trim();
    const phone = document.getElementById('suPhone').value.trim();

    // 1. SAVE PROFILE (PERSIST IDENTITY) - Now includes Username
    const userProfile = { firstName, lastName, email, username, address, city, phone };
    chrome.storage.local.set({ userProfile });

    // Get current site
    let siteName = '';
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]) {
        siteName = new URL(tabs[0].url).hostname.replace('www.', '');
      }
    } catch { /* noop */ }

    if (!siteName) siteName = 'unknown-site';

    // 2. FILL FORM ON PAGE
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          action: 'fillSignup',
          data: { firstName, lastName, username, email, password, address, city, phone }
        });
      }
    });

    // 3. AUTO-CREATE LOGIN IN VAULT
    const displayUser = email || username || `${firstName} ${lastName}`.trim();
    const duplicate = this.findLoginDuplicate({ site: siteName, user: displayUser });
    if (duplicate) {
      const existing = duplicate.entry;
      const ok = window.confirm(`A credential already exists for ${existing.site} (${existing.user || 'unknown user'}). Overwrite it?`);
      if (!ok) {
        this.showView('vault');
        this.renderVault();
        return;
      }
    }

    this.upsertLoginEntry({
      id: crypto.randomUUID(),
      type: 'login',
      site: siteName,
      user: displayUser,
      pass: password,
      created: Date.now(),
      meta: { ...userProfile } // Store all metadata
    });

    await this.saveVaultToDisk();

    // Go to vault and show success
    this.showView('vault');
    this.renderVault();
  },

  // --- CRUD ---
  renderVault() {
    const list = document.getElementById('entries-list');
    list.innerHTML = '';
    const filter = (document.getElementById('searchInput').value || '').toLowerCase();
    const cat = this.activeCategory;

    const filtered = this.vault.filter(e => {
      if (cat !== 'all' && (e.type || 'login') !== cat) return false;
      if (filter) {
        return (e.site || '').toLowerCase().includes(filter) ||
          (e.user || '').toLowerCase().includes(filter);
      }
      return true;
    });

    if (filtered.length === 0) {
      const msg = this.vault.length === 0
        ? 'Your vault is empty. Click + to add.'
        : (cat !== 'all' ? `No ${cat.replace('_', ' ')} entries found.` : 'No results found.');
      list.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 40px 0; font-size: 13px;">${msg}</div>`;
      return;
    }

    filtered.forEach(entry => {
      const type = entry.type || 'login';
      const config = this.TYPE_CONFIG[type] || this.TYPE_CONFIG.login;
      const item = document.createElement('div');
      item.className = 'entry-item';
      item.innerHTML = `
        <div class="entry-icon">${config.icon}</div>
        <div class="entry-info">
          <div class="entry-title">${this.escapeHtml(entry.site)}</div>
          <div class="entry-user">${this.escapeHtml(entry.user || '')}</div>
        </div>
        <span class="entry-type-badge type-${type}">${config.label}</span>
      `;
      item.addEventListener('click', () => this.showEntryForm(entry));
      list.appendChild(item);
    });
  },

  showEntryForm(entry = null, type = null) {
    const form = document.getElementById('entryForm');
    form.reset();
    document.getElementById('deleteEntryBtn').style.display = entry ? 'block' : 'none';

    if (entry) {
      document.getElementById('entry-title').textContent = "Edit Entry";
      document.getElementById('entryId').value = entry.id;
      document.getElementById('entryType').value = entry.type || 'login';
      document.getElementById('entrySite').value = entry.site;
      document.getElementById('entryUser').value = entry.user || '';
      document.getElementById('entryPass').value = entry.pass || '';
      document.getElementById('entryApiKey').value = entry.apiKey || '';
      document.getElementById('entryNote').value = entry.note || '';
      this.handleTypeSwitch(entry.type || 'login');
    } else {
      const selectedType = type || 'login';
      document.getElementById('entry-title').textContent = "New Entry";
      document.getElementById('entryId').value = '';
      document.getElementById('entryType').value = selectedType;
      this.handleTypeSwitch(selectedType);
    }

    this.showView('entry');
  },

  async handleSaveEntry(e) {
    e.preventDefault();
    const id = document.getElementById('entryId').value;
    const type = document.getElementById('entryType').value;
    const site = document.getElementById('entrySite').value;
    const user = document.getElementById('entryUser').value;
    const pass = document.getElementById('entryPass').value;
    const apiKey = document.getElementById('entryApiKey').value;
    const note = document.getElementById('entryNote').value;

    const entryData = { site, type, user, pass, apiKey, note };

    if (id) {
      const index = this.vault.findIndex(x => x.id === id);
      if (index !== -1) this.vault[index] = { ...this.vault[index], ...entryData };
    } else {
      this.vault.push({ id: crypto.randomUUID(), ...entryData, created: Date.now() });
    }

    await this.saveVaultToDisk();
    this.showView('vault');
    this.renderVault();
  },

  async handleDeleteEntry() {
    const id = document.getElementById('entryId').value;
    if (confirm("Are you sure?")) {
      this.vault = this.vault.filter(x => x.id !== id);
      await this.saveVaultToDisk();
      this.showView('vault');
      this.renderVault();
    }
  },

  handleAutofill() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      const tabUrl = tabs[0].url;
      const urlHostname = new URL(tabUrl).hostname;
      const match = this.pickBestVaultMatch(urlHostname);

      if (match) {
        chrome.tabs.sendMessage(tabs[0].id, {
          action: 'fillCredentials',
          user: match.user || '',
          pass: match.pass || match.apiKey || '',
          type: match.type || 'login'
        });
        window.close();
      } else {
        alert("No credentials found for this site.");
      }
    });
  },

  // --- CLOUD RESTORE (from login screen) ---
  async handleCloudRestore() {
    const masterPass = document.getElementById('masterPassword').value;
    const ordsUrl = document.getElementById('restoreOrdsUrl').value.trim();
    const dbUser = document.getElementById('restoreDbUser').value.trim() || 'ADMIN';
    const dbPass = document.getElementById('restoreDbPass').value;
    const statusEl = document.getElementById('restore-status');

    if (!masterPass) { statusEl.textContent = "Enter your master password first."; return; }
    if (!ordsUrl || !dbPass) { statusEl.textContent = "Fill in all Oracle Cloud fields."; return; }

    statusEl.textContent = "☁️ Connecting to Oracle Cloud...";
    statusEl.style.color = 'var(--text-muted)';

    try {
      // Pull all vault entries from Oracle
      const url = `${ordsUrl.replace(/\/+$/, '')}/vault/`;
      const auth = btoa(`${dbUser}:${dbPass}`);
      const resp = await fetch(url, {
        method: 'GET',
        headers: { 'Authorization': `Basic ${auth}`, 'Accept': 'application/json' }
      });

      if (!resp.ok) throw new Error(`Oracle returned ${resp.status}`);
      const data = await resp.json();
      const items = data.items || [];

      if (items.length === 0) {
        statusEl.textContent = "No vault data found in Oracle Cloud.";
        statusEl.style.color = 'var(--danger)';
        return;
      }

      // Try to decrypt each stored vault with the master password
      let restored = false;
      for (const item of items) {
        try {
          const vaultBlob = typeof item.vault_blob === 'string' ? JSON.parse(item.vault_blob) : item.vault_blob;
          const decrypted = await CryptoService.decrypt(vaultBlob, masterPass);
          if (Array.isArray(decrypted)) {
            this.masterPassword = masterPass;
            this.vault = decrypted;
            this.cloudSettings = { ordsBaseUrl: ordsUrl, username: dbUser, password: dbPass, autoSync: true };
            await this.saveVaultToDisk();
            this.saveCloudSettingsToDisk();
            this.isNewUser = false;
            this.unlockUI();
            restored = true;
            break;
          }
        } catch (e) {
          // Wrong master password for this entry, try next
          continue;
        }
      }

      if (!restored) {
        statusEl.textContent = "Master password doesn't match any cloud vault.";
        statusEl.style.color = 'var(--danger)';
      }
    } catch (err) {
      console.error("Cloud restore error:", err);
      statusEl.textContent = "Failed: " + err.message;
      statusEl.style.color = 'var(--danger)';
    }
  },

  // --- CLOUD SYNC ---
  async handleCloudSync() {
    if (!this.masterPassword) { alert("Unlock vault first."); return; }
    if (!this.cloudSettings.ordsBaseUrl || !this.cloudSettings.password) {
      alert("Configure Oracle Cloud in Settings first.");
      return;
    }

    const btn = document.getElementById('cloudSyncBtn');
    btn.textContent = '⏳';
    btn.disabled = true;

    try {
      // Pull from cloud
      const cloudVault = await OracleCloudSync.pull(
        this.cloudSettings.ordsBaseUrl,
        this.cloudSettings.username,
        this.cloudSettings.password,
        this.getUserId()
      );

      if (cloudVault) {
        // Merge: cloud entries that don't exist locally get added
        const localIds = new Set(this.vault.map(e => e.id));
        let added = 0;
        for (const entry of cloudVault) {
          if (!localIds.has(entry.id)) {
            this.vault.push(entry);
            added++;
          }
        }
        if (added > 0) {
          await this.saveVaultToDisk();
          this.renderVault();
        }
      }

      // Push local vault to cloud
      await this.pushToCloud();
      btn.textContent = '✅';
      setTimeout(() => { btn.textContent = '☁️'; }, 2000);
    } catch (err) {
      console.error("Cloud sync error:", err);
      btn.textContent = '❌';
      setTimeout(() => { btn.textContent = '☁️'; }, 2000);
      alert("Cloud sync failed: " + err.message);
    } finally {
      btn.disabled = false;
    }
  },

  async pushToCloud() {
    if (!this.cloudSettings.ordsBaseUrl || !this.cloudSettings.password) return;
    if (!this.masterPassword) return;

    const encrypted = await CryptoService.encrypt(this.vault, this.masterPassword);
    await OracleCloudSync.push(
      this.cloudSettings.ordsBaseUrl,
      this.cloudSettings.username,
      this.cloudSettings.password,
      this.getUserId(),
      encrypted
    );
  },

  getUserId() {
    // Generate a deterministic user ID from master password hash
    let hash = 0;
    const str = 'passvault_' + this.masterPassword;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return 'user_' + Math.abs(hash).toString(36);
  },

  escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
};

App.init();
