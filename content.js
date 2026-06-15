// --- AGENT X: AI-POWERED SMART FORM ENGINE ---
// "MAXIMUM RIGOR & COMPATIBILITY MODE"

const ENGINE_CONFIG = {
  LOGIN_SIGNALS: ['login', 'sign-in', 'signin', 'log-in', 'user', 'session', 'auth'],
  SIGNUP_SIGNALS: ['signup', 'sign-up', 'register', 'create', 'join', 'new', 'subscribe', 'account'],
  TARGET_ATTRS: ['id', 'name', 'class', 'aria-label', 'placeholder']
};

// --- URL-BASED AUTH PAGE DETECTION ---
function isAuthPageUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return /(\/login|\/signup|\/signin|\/sign-up|\/register|\/auth)/.test(lower);
}

function getPageType(url) {
  if (!url) return "unknown";
  const lower = url.toLowerCase();
  if (/\/login|\/signin|\/sign-in/.test(lower)) return "login";
  if (/\/signup|\/sign-up|\/register/.test(lower)) return "signup";
  if (/\/auth/.test(lower)) return "auth";
  return "unknown";
}

const PasswordGen = {
  generate(length = 24) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*_-+=?';
    const arr = new Uint32Array(length);
    window.crypto.getRandomValues(arr);
    return Array.from(arr).map(x => chars[x % chars.length]).join('');
  }
};

const DomainUtil = {
  root(hostname = window.location.hostname) {
    const clean = String(hostname || '').toLowerCase().replace(/^www\./, '');
    const parts = clean.split('.').filter(Boolean);
    if (parts.length <= 2) return clean;
    const twoPartTlds = ['co.uk', 'com.au', 'com.br', 'co.jp', 'co.in', 'com.tr'];
    const lastTwo = parts.slice(-2).join('.');
    if (twoPartTlds.includes(lastTwo) && parts.length >= 3) return parts.slice(-3).join('.');
    return parts.slice(-2).join('.');
  }
};

const signupMonitors = new WeakSet();

// --- PAGE CONTEXT EXTRACTOR (for AI) ---
class PageContextExtractor {
  static extract(scope = document) {
    const base = scope && typeof scope.querySelectorAll === 'function' ? scope : document;
    const fields = [], labels = [], buttons = [];
    const fieldContext = [];

    const findLabel = (el) => {
      let lbl = '';
      if (el.id) { const l = document.querySelector(`label[for="${el.id}"]`); if (l) lbl = l.innerText; }
      if (!lbl) { const p = el.closest('label'); if (p) lbl = p.innerText; }
      if (!lbl && el.parentElement) {
        let prev = el.previousElementSibling;
        while (prev) {
          if (prev.innerText && prev.innerText.trim().length > 1) { lbl = prev.innerText; break; }
          prev = prev.previousElementSibling;
        }
        if (!lbl) {
          let pPrev = el.parentElement.previousElementSibling;
          if (pPrev && pPrev.innerText && pPrev.innerText.trim().length > 1) lbl = pPrev.innerText;
        }
      }
      return lbl ? lbl.trim().replace(/\s+/g, ' ') : '';
    };

    base.querySelectorAll('input, textarea, select').forEach(el => {
      if (el.type === 'hidden' || el.type === 'submit') return;
      const rect = el.getBoundingClientRect();
      const lText = findLabel(el);
      const textBefore = this.findNearbyText(el);
      const selector = this.buildSelector(el);
      const expectedRole = this.inferFieldRole(el, lText, textBefore);

      fields.push({
        tag: el.tagName.toLowerCase(),
        type: el.type || 'text',
        name: el.name || el.id || '',
        placeholder: el.placeholder || '',
        label: lText,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        visible: el.offsetParent !== null
      });
      if (lText) labels.push(lText);

      fieldContext.push({
        selector,
        type: el.type || 'text',
        name: el.name || el.id || '',
        label: lText,
        placeholder: el.placeholder || '',
        text_before: textBefore,
        expected_role: expectedRole
      });
    });

    base.querySelectorAll('button, input[type="submit"], [role="button"]').forEach(el => {
      if (el.offsetParent === null) return;
      buttons.push({
        text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().substring(0, 30),
        id: el.id || ''
      });
    });

    const headingText = Array.from(base.querySelectorAll('h1, h2, h3, [role="heading"], .title'))
      .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 8);

    const scopeText = (base.innerText || '').replace(/\s+/g, ' ').toLowerCase();
    const pageSignals = {
      signup_phrase: /(sign up|signup|create account|register|get started|join)/.test(scopeText),
      login_phrase: /(sign in|signin|log in|login)/.test(scopeText),
      has_confirm_password: /confirm password|repeat password|retype password|verify password/.test(scopeText)
    };

    return {
      url: window.location.href,
      urlPageType: getPageType(window.location.href),
      title: document.title,
      fields: fields.slice(0, 30),
      fieldContext: fieldContext.slice(0, 40),
      labels: labels.slice(0, 20),
      buttons: buttons.slice(0, 8),
      headings: headingText,
      pageSignals,
      textSnippet: (base.innerText || document.body.innerText || '').substring(0, 1200).replace(/\s+/g, ' ').trim()
    };
  }

  static buildSelector(el) {
    if (!el || !el.tagName) return '';
    if (el.id) return `#${el.id}`;
    if (el.name) return `${el.tagName.toLowerCase()}[name="${el.name}"]`;
    const tag = el.tagName.toLowerCase();
    const classes = (el.className || '').toString().trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (classes.length) return `${tag}.${classes.join('.')}`;
    const parent = el.parentElement;
    if (!parent) return tag;
    const idx = Array.from(parent.children).filter(c => c.tagName === el.tagName).indexOf(el) + 1;
    return `${parent.tagName.toLowerCase()} > ${tag}:nth-of-type(${Math.max(idx, 1)})`;
  }

  static findNearbyText(el) {
    if (!el) return '';
    const chunks = [];
    const pushText = (t) => {
      const v = (t || '').replace(/\s+/g, ' ').trim();
      if (v) chunks.push(v);
    };

    let prev = el.previousElementSibling;
    while (prev) {
      pushText(prev.innerText);
      prev = prev.previousElementSibling;
      if (chunks.length >= 2) break;
    }

    const parent = el.parentElement;
    if (parent) {
      pushText(parent.getAttribute('aria-label'));
      const parentTxt = (parent.innerText || '').replace(/\s+/g, ' ').trim();
      if (parentTxt) pushText(parentTxt.substring(0, 120));
    }

    return chunks.join(' | ').substring(0, 220);
  }

  static inferFieldRole(el, label = '', nearby = '') {
    const type = (el?.type || '').toLowerCase();
    if (type === 'password') return 'password';
    if (type === 'email') return 'email';
    if (type === 'tel') return 'phone';

    const attr = `${el?.id || ''} ${el?.name || ''} ${el?.placeholder || ''} ${el?.getAttribute?.('aria-label') || ''} ${label || ''} ${nearby || ''}`.toLowerCase();
    if (/(full name|your name|name)/.test(attr) && !/(user ?name|login)/.test(attr)) return 'full_name';
    if (/(first|given|forename|fname)/.test(attr)) return 'first_name';
    if (/(last|family|surname|lname)/.test(attr)) return 'last_name';
    if (/(email|mail)/.test(attr)) return 'email';
    if (/(user ?name|login|handle|nick|account id)/.test(attr)) return 'username';
    if (/(phone|mobile|tel|cell|whatsapp)/.test(attr)) return 'phone';
    if (/(address|street|city|zip|postal)/.test(attr)) return 'address';
    return 'unknown';
  }
}

// --- INTERFACE INJECTOR ---
class InterfaceInjector {
  constructor() {
    this.processedInputs = new WeakSet();
    this.observer = null;
    this.unlockPromptPromise = null;
    this.init();
  }

  init() {
    this.flushPendingSignupOnLoad();
    this.setupOnDemandInjection();
    window.addEventListener('hashchange', () => this.flushPendingSignupOnLoad());
    window.addEventListener('popstate', () => this.flushPendingSignupOnLoad());
  }

  flushPendingSignupOnLoad() {
    chrome.runtime.sendMessage({
      action: 'flush_pending_signup',
      currentUrl: window.location.href
    }, () => { });
  }

  setupOnDemandInjection() {
    // Listen for focus/click on any input - inject icon on-demand for credential fields
    document.addEventListener('focusin', (e) => {
      const input = e.target;
      if (!this.isCredentialField(input)) return;
      if (input.dataset.passvault) return; // Already has icon
      this.processInput(input);
    }, true);

    // Also handle click for fields that might not get focusin
    document.addEventListener('click', (e) => {
      const input = e.target;
      if (!this.isCredentialField(input)) return;
      if (input.dataset.passvault) return;
      this.processInput(input);
    }, true);
  }

  isCredentialField(input) {
    if (!(input instanceof HTMLInputElement) && !(input instanceof HTMLTextAreaElement)) return false;
    if (input.type === 'hidden' || input.type === 'submit' || input.type === 'button') return false;
    if (input.offsetWidth < 10 || input.offsetHeight < 10) return false;

    const type = (input.type || '').toLowerCase();
    // Always show on password fields
    if (type === 'password') return true;
    if (type === 'email') return true;

    const attrStr = ((input.id || '') + ' ' + (input.name || '') + ' ' + (input.placeholder || '') + ' ' + (input.getAttribute('aria-label') || '') + ' ' + (input.autocomplete || '')).toLowerCase();
    
    // Exclude search fields
    if (attrStr.includes('search') || attrStr.includes('query')) return false;

    // Show on username/email-like fields
    const usernameSignals = ['user', 'login', 'email', 'mail', 'username', 'account', 'handle', 'name'];
    if (usernameSignals.some(s => attrStr.includes(s))) return true;

    // Also show on fields in forms that have password fields (likely login/signup forms)
    const form = input.closest('form');
    if (form && form.querySelector('input[type="password"]')) return true;

    return false;
  }

  processInput(input) {
    if (this.processedInputs.has(input)) return;
    this.injectTray(input);
    this.processedInputs.add(input);
    input.dataset.passvault = "true";
  }

  injectTray(input) {
    if (input.parentNode.querySelector('.passvault-icon')) return;

    const icon = document.createElement('div');
    icon.className = 'passvault-icon';
    icon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="3" y="11" width="18" height="11" rx="2" stroke="white" stroke-width="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="white" stroke-width="2"/><circle cx="12" cy="16" r="2" fill="#7c3aed"/></svg>`;

    // Detect existing right-side elements (eye icons, clear buttons, etc.)
    const parent = input.parentElement;
    if (!parent) return;
    if (parent.tagName === 'LABEL') return;

    const computedParentStyle = window.getComputedStyle(parent);
    if (computedParentStyle.position === 'static') parent.style.position = 'relative';

    // Check for existing right-positioned child elements (common for eye icons)
    const rightSideElements = Array.from(parent.children).filter(child => {
      const style = window.getComputedStyle(child);
      return style.position === 'absolute' && (style.right !== 'auto' || style.left === 'auto');
    });

    // Calculate right offset: start from 8px, add space for each existing right element
    let rightOffset = 8;
    rightSideElements.forEach(el => {
      const rect = el.getBoundingClientRect();
      const parentRect = parent.getBoundingClientRect();
      const distanceFromRight = parentRect.right - rect.left;
      rightOffset = Math.max(rightOffset, distanceFromRight + 8);
    });

    // Also check input's padding-right for native browser reveal buttons
    const inputStyle = window.getComputedStyle(input);
    const paddingRight = parseInt(inputStyle.paddingRight, 10) || 0;
    if (paddingRight > 20) rightOffset = Math.max(rightOffset, paddingRight + 8);

    Object.assign(icon.style, {
      position: 'absolute',
      right: `${rightOffset}px`,
      top: '50%',
      transform: 'translateY(-50%)',
      cursor: 'pointer',
      opacity: '0.6',
      zIndex: '2147483647',
      background: 'linear-gradient(135deg, #0f3460, #7c3aed)',
      borderRadius: '4px',
      padding: '4px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      transition: 'opacity 0.2s, transform 0.2s',
      width: '24px',
      height: '24px',
      pointerEvents: 'auto',
      boxShadow: '0 2px 5px rgba(0,0,0,0.2)'
    });

    icon.onmouseenter = () => { icon.style.opacity = '1'; icon.style.transform = 'translateY(-50%) scale(1.1)'; };
    icon.onmouseleave = () => { icon.style.opacity = '0.6'; icon.style.transform = 'translateY(-50%) scale(1)'; };

    icon.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      this.handleIconClick(input);
    };

    parent.appendChild(icon);
  }

  ensureUnlockedBeforeAutofill() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'is_unlocked' }, (state) => {
        if (state && state.unlocked) {
          resolve(true);
          return;
        }
        this.showUnlockPrompt().then(resolve);
      });
    });
  }

  showUnlockPrompt() {
    if (this.unlockPromptPromise) return this.unlockPromptPromise;

    this.unlockPromptPromise = new Promise((resolve) => {
      const overlay = document.createElement('div');
      const card = document.createElement('div');
      const title = document.createElement('h3');
      const subtitle = document.createElement('p');
      const input = document.createElement('input');
      const error = document.createElement('p');
      const actions = document.createElement('div');
      const cancelBtn = document.createElement('button');
      const unlockBtn = document.createElement('button');

      const close = (ok) => {
        overlay.remove();
        this.unlockPromptPromise = null;
        resolve(ok);
      };

      Object.assign(overlay.style, {
        position: 'fixed',
        inset: '0',
        background: 'rgba(5, 8, 20, 0.6)',
        zIndex: '2147483647',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px'
      });

      Object.assign(card.style, {
        width: 'min(360px, 92vw)',
        background: '#16213e',
        border: '1px solid #0f3460',
        borderRadius: '12px',
        padding: '16px',
        boxShadow: '0 14px 38px rgba(0, 0, 0, 0.45)',
        color: '#e0e0e0',
        fontFamily: 'Segoe UI, -apple-system, BlinkMacSystemFont, sans-serif'
      });

      Object.assign(title.style, { margin: '0 0 8px', fontSize: '18px', color: '#e94560' });
      title.textContent = 'Unlock PassVault';

      Object.assign(subtitle.style, { margin: '0 0 12px', fontSize: '13px', color: '#8892b0' });
      subtitle.textContent = 'Enter your master password to continue autofill.';

      input.type = 'password';
      input.placeholder = 'Master Password';
      input.autocomplete = 'current-password';
      Object.assign(input.style, {
        width: '100%',
        height: '40px',
        borderRadius: '8px',
        border: '1px solid #0f3460',
        background: '#1a1a2e',
        color: '#e0e0e0',
        padding: '0 12px',
        fontSize: '13px',
        outline: 'none'
      });

      Object.assign(error.style, { margin: '8px 0 0', minHeight: '16px', color: '#ff4d4d', fontSize: '12px' });

      Object.assign(actions.style, { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' });

      cancelBtn.type = 'button';
      cancelBtn.textContent = 'Cancel';
      Object.assign(cancelBtn.style, {
        height: '36px',
        borderRadius: '8px',
        border: '1px solid #0f3460',
        background: '#1a1a2e',
        color: '#e0e0e0',
        padding: '0 12px',
        cursor: 'pointer'
      });

      unlockBtn.type = 'button';
      unlockBtn.textContent = 'Unlock';
      Object.assign(unlockBtn.style, {
        height: '36px',
        borderRadius: '8px',
        border: 'none',
        background: '#e94560',
        color: 'white',
        padding: '0 14px',
        cursor: 'pointer',
        fontWeight: '600'
      });

      const submit = () => {
        const password = input.value;
        if (!password) {
          error.textContent = 'Password cannot be empty.';
          return;
        }

        error.textContent = 'Unlocking...';
        unlockBtn.disabled = true;
        cancelBtn.disabled = true;

        chrome.runtime.sendMessage({ action: 'unlock_with_password', password }, (response) => {
          unlockBtn.disabled = false;
          cancelBtn.disabled = false;

          if (chrome.runtime.lastError) {
            error.textContent = 'Unlock failed. Try again.';
            return;
          }

          if (response && response.success) {
            close(true);
            this.showToast("🔓 Vault unlocked", true);
            return;
          }

          if (response && response.error === 'BAD_PASSWORD') {
            error.textContent = 'Incorrect password.';
            input.value = '';
            input.focus();
            return;
          }

          if (response && response.error === 'NO_VAULT') {
            error.textContent = 'No vault found. Open the extension popup and create one first.';
            return;
          }

          if (response && response.error === 'CORRUPTED_VAULT') {
            error.textContent = 'Vault data is invalid. Open the extension popup and restore from backup.';
            return;
          }

          error.textContent = 'Unlock failed. Try again.';
        });
      };

      overlay.addEventListener('click', (evt) => {
        if (evt.target === overlay) close(false);
      });
      cancelBtn.addEventListener('click', () => close(false));
      unlockBtn.addEventListener('click', submit);
      input.addEventListener('keydown', (evt) => {
        if (evt.key === 'Enter') submit();
        if (evt.key === 'Escape') close(false);
      });

      actions.appendChild(cancelBtn);
      actions.appendChild(unlockBtn);
      card.appendChild(title);
      card.appendChild(subtitle);
      card.appendChild(input);
      card.appendChild(error);
      card.appendChild(actions);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      input.focus();
    });

    return this.unlockPromptPromise;
  }

  requestDomainCredential(role = 'identity', allowGlobalFallback = true) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: 'get_domain_credential',
        currentUrl: window.location.href,
        role,
        allowGlobalFallback
      }, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: 'RUNTIME_ERROR' });
          return;
        }
        resolve(response || { success: false, error: 'NO_RESPONSE' });
      });
    });
  }

  getInputLabelText(input) {
    if (!input) return '';
    let label = '';

    if (input.id) {
      const byFor = document.querySelector(`label[for="${input.id}"]`);
      if (byFor) label = byFor.innerText || '';
    }
    if (!label) {
      const parentLabel = input.closest('label');
      if (parentLabel) label = parentLabel.innerText || '';
    }

    const nearby = input.previousElementSibling?.innerText || '';
    const attr = input.getAttribute('aria-label') || '';
    return `${label} ${nearby} ${attr}`.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  inferClickedFieldRole(input) {
    const type = (input?.type || '').toLowerCase();
    if (type === 'password') return 'password';
    if (type === 'email') return 'email';

    const text = `${input?.name || ''} ${input?.id || ''} ${input?.placeholder || ''} ${input?.autocomplete || ''} ${this.getInputLabelText(input)}`.toLowerCase();
    if (/(api[\s_-]*key|access[\s_-]*token|bearer|client[\s_-]*secret|secret[\s_-]*key)/.test(text)) return 'unsupported';
    if (/(pass|pwd|secret|pin)/.test(text)) return 'password';
    if (/(email|mail|e-mail)/.test(text)) return 'email';
    if (/(user|username|login|handle|account|id)/.test(text)) return 'username';
    return 'identity';
  }

  resolveIdentityValue(role, entry) {
    const user = (entry?.user || '').trim();
    const metaEmail = (entry?.meta?.email || '').trim();
    const metaUsername = (entry?.meta?.username || '').trim();

    if (role === 'email') {
      if (user.includes('@')) return user;
      return metaEmail || user;
    }

    if (role === 'username') {
      if (user && !user.includes('@')) return user;
      return metaUsername || (user.includes('@') ? user.split('@')[0] : user);
    }

    return user || metaEmail || metaUsername;
  }

  setFieldValue(input, value) {
    input.focus();
    input.value = '';

    const proto = Object.getPrototypeOf(input);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(input, value);
    else input.value = value;

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
  }

  getVisibleCredentialInputs(scope = document) {
    return Array.from(scope.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea'))
      .filter(el => el.offsetParent !== null || el.getClientRects().length > 0);
  }

  profileValueForRole(role, profile = {}) {
    const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim();
    if (role === 'email') return profile.email || '';
    if (role === 'username') return profile.username || (profile.email ? profile.email.split('@')[0] : '');
    if (role === 'full_name' || role === 'identity') return profile.fullName || fullName || profile.username || profile.email || '';
    if (role === 'first_name') return profile.firstName || '';
    if (role === 'last_name') return profile.lastName || '';
    if (role === 'phone') return profile.phone || '';
    if (role === 'address') return profile.address || profile.city || '';
    return '';
  }

  getUserProfile() {
    return new Promise((resolve) => chrome.storage.local.get('userProfile', (res) => resolve(res.userProfile || null)));
  }

  queuePendingCredential(entry, startUrl = window.location.href) {
    chrome.runtime.sendMessage({
      action: 'queue_signup_pending',
      startUrl,
      entry
    }, () => { });
  }

  promptAndFillGeneratedPassword(input, profile = null) {
    const ok = window.confirm('No saved password for this domain. Generate a random password? It will be saved only after submit + your Yes confirmation in the popup.');
    if (!ok) {
      this.showToast('↩️ Password generation cancelled', true);
      return false;
    }

    const generated = PasswordGen.generate(24);
    const scope = input.closest('form') || document;
    const passwordFields = this.getVisibleCredentialInputs(scope).filter(i => i.type === 'password');
    const targets = passwordFields.length ? passwordFields : [input];
    targets.forEach(field => this.setFieldValue(field, generated));

    const finalProfile = profile || {};
    const displayUser = finalProfile.email || finalProfile.username || 'user';
    const entry = {
      site: DomainUtil.root(),
      host: window.location.hostname,
      user: displayUser,
      pass: generated,
      type: 'login',
      meta: { ...finalProfile, pendingReason: 'generated-password' }
    };
    this.queuePendingCredential(entry);
    this.monitorSignupSubmission(scope, finalProfile.email, finalProfile.username, generated, finalProfile);
    this.showToast('🔐 Password generated. Submit, then open PassVault to Save/No.', true);
    return true;
  }

  async deterministicAutofill(clickedInput) {
    const profile = await this.getUserProfile();
    if (!profile) {
      this.showToast('⚠️ Setup Identity First', false);
      return;
    }

    const scope = clickedInput.closest('form') || document;
    const fields = this.getVisibleCredentialInputs(scope);
    let filledSafe = 0;

    for (const field of fields) {
      if (field.type === 'password') continue;
      const role = PageContextExtractor.inferFieldRole(field, this.getInputLabelText(field), PageContextExtractor.findNearbyText(field));
      const value = this.profileValueForRole(role, profile);
      if (value && !field.value) {
        this.setFieldValue(field, value);
        filledSafe++;
      }
    }

    if (filledSafe > 0) {
      this.queuePendingCredential({
        site: DomainUtil.root(),
        host: window.location.hostname,
        user: profile.email || profile.username || 'user',
        pass: '',
        type: 'login',
        meta: { ...profile, pendingReason: 'autofill-profile' }
      });
    }

    const passwordFields = fields.filter(i => i.type === 'password');
    if (passwordFields.length > 0) {
      const response = await this.requestDomainCredential('password', false);
      const savedPassword = response?.success ? ((response.entry?.pass || response.entry?.apiKey || '').trim()) : '';
      if (savedPassword) {
        passwordFields.forEach(field => this.setFieldValue(field, savedPassword));
        this.showToast(`🔑 Autofilled ${filledSafe + passwordFields.length} field(s)`, true);
        return;
      }

      if (clickedInput.type === 'password') {
        this.showToast('❌ No saved password for this site', false);
        this.promptAndFillGeneratedPassword(clickedInput, profile);
        return;
      }
    }

    if (filledSafe > 0) this.showToast(`✅ Autofilled ${filledSafe} profile field(s)`, true);
    else this.showToast('⚠️ No compatible profile fields found', false);
  }

  async handleIconClick(input) {
    const unlocked = await this.ensureUnlockedBeforeAutofill();
    if (!unlocked) return;

    const role = this.inferClickedFieldRole(input);
    if (role === 'unsupported') {
      this.showToast('⚠️ Basic autofill supports normal login fields only', false);
      return;
    }

    await this.deterministicAutofill(input);
  }

  findSignupScope(input, form = null) {
    if (form) return form;
    if (!input) return document;

    const signupPattern = /(create account|sign up|signup|register|join|get started|continue|next|create my account|sign-up)/;
    const loginPattern = /(sign in|signin|log in|login)/;
    let best = null;
    let bestScore = -Infinity;
    let current = input.parentElement;

    while (current && current !== document.body) {
      const inputs = current.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"])');
      const submitEls = current.querySelectorAll('button, input[type="submit"], [role="button"]');
      const submitText = Array.from(submitEls)
        .map(el => `${el.innerText || ''} ${el.value || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase().trim())
        .join(' ');
      const text = (current.innerText || '').replace(/\s+/g, ' ').toLowerCase().substring(0, 800);
      let score = 0;
      if (inputs.length >= 2) score += 4;
      if (signupPattern.test(submitText)) score += 5;
      if (signupPattern.test(text)) score += 4;
      if (loginPattern.test(submitText)) score -= 2;
      if (/sign up with email/.test(text)) score += 6;

      if (score > bestScore) {
        best = current;
        bestScore = score;
      }

      current = current.parentElement;
    }

    return best || document;
  }

  detectSignupContext(scope, input = null) {
    return this.evaluateIntentContext(scope, input).isSignup;
  }

  evaluateIntentContext(scope, input = null) {
    const root = scope || this.findSignupScope(input);
    if (!root) return { isSignup: false, strongSignup: false, signupScore: 0, loginScore: 0 };

    const url = window.location.href.toLowerCase();
    const isLoginUrl = /(login|signin|sign-in|log-in|account\/signin|auth\/login|auth\/signin|session\/new)/.test(url);
    const isSignupUrl = /(signup|sign-up|register|create-account|join|new-account|auth\/register)/.test(url);

    const inputs = Array.from(root.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"])'));
    const passwordFields = inputs.filter(i => i.type === 'password' && i.offsetParent !== null);

    // Check for confirm signals
    const hasConfirmSignal = inputs.some(i => {
      const attr = `${i.name || ''} ${i.id || ''} ${i.placeholder || ''} ${i.getAttribute('aria-label') || ''} ${i.autocomplete || ''}`.toLowerCase();
      return /(confirm|repeat|retype|verify|password_confirmation|pass2)/.test(attr);
    });

    // 2. Per-field hints
    const inputAutocomplete = (input?.autocomplete || '').toLowerCase();
    if (inputAutocomplete.includes('new-password')) {
      return { isSignup: true, strongSignup: true, signupScore: 9, loginScore: 0 };
    }
    if (inputAutocomplete.includes('current-password')) {
      return { isSignup: false, strongSignup: false, signupScore: 0, loginScore: 8 };
    }

    // 3. Form Signals
    const visibleInputs = inputs.filter(i => i.offsetParent !== null);
    const hasTwoPasswords = passwordFields.length >= 2;
    let hasSignupIdentityFields = false;
    let hasEmailField = false;

    for (const i of visibleInputs) {
      const attr = `${i.name || ''} ${i.id || ''} ${i.placeholder || ''} ${i.getAttribute('aria-label') || ''}`.toLowerCase();
      if (/(first|last|full[\s_-]*name|your[\s_-]*name|address|city|phone|mobile|zip|postal)/.test(attr)) hasSignupIdentityFields = true;
      if (i.type === 'email' || /email|mail/.test(attr)) hasEmailField = true;
    }

    const submitEls = Array.from(root.querySelectorAll('button, input[type="submit"], [role="button"]'))
      .filter(el => el.offsetParent !== null);
    const submitText = submitEls
      .map(el => `${el.innerText || ''} ${el.value || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase().trim())
      .join(' ');

    const hasSignupSubmit = /(create account|sign up|signup|register|join|get started|create my account|sign-up)/.test(submitText);
    const hasLoginSubmit = /(log in|login|sign in|signin|log-in|sign-in)/.test(submitText);
    const headingText = Array.from(root.querySelectorAll('h1, h2, h3, [role="heading"], .title'))
      .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase())
      .join(' ');
    const rootText = (root.innerText || '').replace(/\s+/g, ' ').toLowerCase();
    const hasSignupHeading = /(sign up|signup|create account|register|get started|join)/.test(headingText) ||
      /(sign up with email|create account|join now|register)/.test(rootText);
    const hasLoginHeading = /(sign in|signin|log in|login)/.test(headingText);

    let signupScore = 0;
    let loginScore = 0;
    if (isSignupUrl) signupScore += 4;
    if (isLoginUrl) loginScore += 3;
    if (hasTwoPasswords) signupScore += 4;
    if (hasConfirmSignal) signupScore += 3;
    if (hasSignupSubmit) signupScore += 4;
    if (hasLoginSubmit) loginScore += 3;
    if (hasSignupHeading) signupScore += 4;
    if (hasLoginHeading) loginScore += 2;
    if (hasSignupIdentityFields) signupScore += 2;
    if (hasEmailField) signupScore += 1;
    if (visibleInputs.length >= 2 && hasEmailField && hasSignupIdentityFields) signupScore += 3;
    if (visibleInputs.length <= 2 && hasLoginSubmit && !hasSignupHeading && !hasSignupSubmit) loginScore += 2;
    if (/(already have an account|back to sign up options)/.test(rootText)) signupScore += 2;
    if (/(forgot password|remember me)/.test(rootText)) loginScore += 2;

    const strongSignup = signupScore >= 6 && signupScore >= loginScore;
    const isSignup = signupScore >= 4 && signupScore >= loginScore;
    return { isSignup, strongSignup, signupScore, loginScore };
  }

  triggerSignupFill(form, scope = null, opts = {}) {
    const targetScope = form || scope || document;

    chrome.runtime.sendMessage({ action: 'is_unlocked' }, (state) => {
      if (!state || !state.unlocked) {
        this.showToast("⚠️ Vault locked. Unlock PassVault first.", false);
        return;
      }

      chrome.storage.local.get('userProfile', (res) => {
        if (res.userProfile) {
          const p = res.userProfile;
          const password = PasswordGen.generate(24);

          const filler = new SignupFiller({
            firstName: p.firstName, lastName: p.lastName,
            username: p.username, email: p.email,
            address: p.address, city: p.city, phone: p.phone,
            password: password,
            aiFieldHints: Array.isArray(opts.aiFieldHints) ? opts.aiFieldHints : []
          });

          const filledCount = filler.fill();

          if (filledCount > 0) {
            const detail = filledCount === 1 ? "Field" : "Fields";
            this.showToast(`🚀 ${filledCount} ${detail} Filled!`, true);

            this.monitorSignupSubmission(targetScope, p.email, p.username, password, p);
          } else {
            if (opts.skipAIFallback) {
              this.showToast("⚠️ Signup detected but no compatible fields found", false);
            } else {
              console.warn("Retrying as Login...");
              this.triggerAIAutofill({ scope: targetScope });
            }
          }
        } else {
          this.showToast("⚠️ Setup Identity First", false);
        }
      });
    });
  }

  monitorSignupSubmission(scope, defaultEmail, defaultUser, generatedPass, profile) {
    if (!scope || signupMonitors.has(scope)) return;
    signupMonitors.add(scope);

    let captured = false;
    const finish = () => {
      if (captured) return;
      captured = true;
      signupMonitors.delete(scope);
      setTimeout(() => this.captureAndSave(scope, defaultEmail, defaultUser, generatedPass, profile, { deferUntilUrlChange: true }), 120);
    };

    if (scope.tagName === 'FORM') {
      scope.addEventListener('submit', finish, { once: true });
      scope.querySelectorAll('button, input[type="submit"], [role="button"]').forEach((b) => {
        b.addEventListener('click', () => setTimeout(finish, 10), { once: true });
      });
      return;
    }

    const clickHandler = (evt) => {
      const btn = evt.target?.closest?.('button, input[type="submit"], [role="button"]');
      if (!btn) return;
      const txt = `${btn.innerText || ''} ${btn.value || ''} ${btn.getAttribute('aria-label') || ''}`.toLowerCase().trim();
      if (/(create account|sign up|signup|register|join|get started|continue|next|submit|verify)/.test(txt)) {
        setTimeout(finish, 10);
      }
    };

    const keyHandler = (evt) => {
      if (evt.key === 'Enter') setTimeout(finish, 10);
    };

    scope.addEventListener('click', clickHandler, true);
    scope.addEventListener('keydown', keyHandler, true);

    setTimeout(() => {
      scope.removeEventListener('click', clickHandler, true);
      scope.removeEventListener('keydown', keyHandler, true);
      signupMonitors.delete(scope);
    }, 90000);
  }

  waitForNavigationAndFlush(startUrl, timeoutMs = 12000) {
    const handleFlushResponse = (res) => {
      if (!res || res.success) return;
      if (res.error === 'OVERWRITE_CONFIRM_REQUIRED') {
        this.showToast("⚠️ Overwrite confirmation required. Click icon again.", false);
      }
    };

    const startedAt = Date.now();
    const poll = setInterval(() => {
      const nowUrl = window.location.href;
      if (nowUrl !== startUrl) {
        clearInterval(poll);
        chrome.runtime.sendMessage({ action: 'flush_pending_signup', currentUrl: nowUrl }, handleFlushResponse);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(poll);
        chrome.runtime.sendMessage({ action: 'flush_pending_signup', currentUrl: nowUrl, force: true }, handleFlushResponse);
      }
    }, 300);
  }

  captureAndSave(form, defaultEmail, defaultUser, generatedPass, profile, opts = {}) {
    // Permissive Capture: If the user clicked the icon, they WANT to save. 
    // We only guard against obviously non-credential forms.
    const inputs = Array.from((form || document).querySelectorAll('input'));
    const passwordFields = inputs.filter(i => i.type === 'password' && i.value);
    if (passwordFields.length === 0 && !generatedPass) return;

    const visibleInputs = inputs.filter(i => i.offsetParent !== null || i.getClientRects().length > 0);
    const visiblePass = visibleInputs.find(i => i.type === 'password' && i.value);
    const anyPass = inputs.find(i => i.type === 'password' && i.value);
    const finalPass = (visiblePass ? visiblePass.value : null) || (anyPass ? anyPass.value : null) || generatedPass;

    // Find username/email (Weighted search)
    const em = inputs.find(i => (i.type === 'email' || /email|mail/.test((i.name + i.id).toLowerCase())) && i.value);
    const us = inputs.find(i => /user|login|handle|id/.test((i.name + i.id).toLowerCase()) && i.value);

    let finalUser = (em ? em.value : null) || (us ? us.value : null) || defaultEmail || defaultUser || "user";

    // Safety: If it's a generic "user" and we have a generated pass, it might be a partial capture.
    if (!finalUser && profile?.email) finalUser = profile.email;

    const action = opts.deferUntilUrlChange ? 'queue_signup_pending' : 'save_signup';
    const entry = {
      site: DomainUtil.root(),
      host: window.location.hostname,
      user: finalUser,
      pass: finalPass,
      type: 'login',
      meta: { ...profile, pendingReason: generatedPass ? 'generated-password' : 'captured-password' }
    };

    const sendSaveRequest = (overwriteConfirmed = false) => {
      chrome.runtime.sendMessage({
        action,
        startUrl: window.location.href,
        submitted: !!opts.deferUntilUrlChange,
        overwriteConfirmed,
        entry
      }, (response) => {
        if (response && response.success) {
          if (opts.deferUntilUrlChange) {
            const msg = response.overwritten
              ? "💾 Captured. Confirm update in PassVault after redirect..."
              : "💾 Captured. Confirm save in PassVault after redirect...";
            this.showToast(msg, true);
            this.waitForNavigationAndFlush(window.location.href);
          } else if (response.overwritten) {
            this.showToast("💾 Credential updated", true);
          } else {
            this.showToast("💾 Captured & Saved!", true);
          }
          return;
        }

        if (response && response.error === 'OVERWRITE_CONFIRM_REQUIRED') {
          const existing = response.existing || {};
          const labelSite = existing.site || entry.site;
          const labelUser = existing.user || entry.user || 'unknown user';
          const ok = window.confirm(`A credential already exists for ${labelSite} (${labelUser}). Overwrite it?`);
          if (ok) {
            sendSaveRequest(true);
          } else {
            this.showToast("↩️ Kept existing credential", true);
          }
          return;
        }

        if (response && response.error === 'LOCKED') {
          this.showToast("⚠️ Vault locked. Unlock PassVault first.", false);
        } else {
          this.showToast("❌ Save failed", false);
        }
      });
    };

    sendSaveRequest(!!opts.overwriteConfirmed);
  }

  triggerAIAutofill(options = {}) {
    // AI is intentionally disabled for credential output.
    // Old callers are routed through deterministic autofill so credentials/passwords
    // are never chosen by AI.
    const scope = options.scope || document;
    const first = options.input || scope.querySelector('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select');
    if (first) {
      this.deterministicAutofill(first);
      return;
    }

    chrome.runtime.sendMessage({ action: 'request_autofill' }, (res) => {
      if (res && res.success) {
        this.showToast('Autofilled', true);
      } else if (typeof options.onNoMatch === 'function') {
        const handled = options.onNoMatch();
        if (!handled) this.showToast('No Match', false);
      } else {
        this.showToast('No Match', false);
      }
    });
  }

  showToast(msg, success, loading = false) {
    const existing = document.querySelector('.passvault-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'passvault-toast';
    toast.textContent = msg;
    Object.assign(toast.style, {
      position: 'fixed', top: '20px', right: '20px',
      background: success ? '#1a1a2e' : (loading ? '#0f3460' : '#e94560'),
      color: 'white', padding: '12px 24px', borderRadius: '8px', zIndex: '2147483647',
      fontFamily: '-apple-system, sans-serif', fontSize: '13px', fontWeight: 'bold',
      boxShadow: '0 4px 16px rgba(0,0,0,0.5)', border: `1px solid ${success ? '#7c3aed' : '#e94560'}`
    });
    document.body.appendChild(toast);
    if (!loading) setTimeout(() => toast.remove(), 3000);
  }
}

const passvaultInjector = new InterfaceInjector();
window.__passvaultInjector = passvaultInjector;

// --- HIGH-COMPATIBILITY FILLER ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'passvault_deterministic_autofill') {
    const active = document.activeElement && document.activeElement.matches?.('input, textarea') ? document.activeElement : null;
    const first = active || document.querySelector('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea');
    if (!first || !window.__passvaultInjector) {
      sendResponse({ success: false, error: 'NO_FIELD' });
      return;
    }
    window.__passvaultInjector.deterministicAutofill(first).then(() => sendResponse({ success: true }));
    return true;
  }
  if (msg.action === 'fillCredentials') {
    const engine = new FormFiller(msg.user, msg.pass, msg.type, msg.fieldMapping);
    sendResponse({ success: engine.fill() });
  }
  if (msg.action === 'fillSignup') {
    const filler = new SignupFiller(msg.data);
    const filled = filler.fill();
    if (window.__passvaultInjector && msg.data?.password) {
      window.__passvaultInjector.monitorSignupSubmission(
        document,
        msg.data.email,
        msg.data.username,
        msg.data.password,
        msg.data
      );
    }
    sendResponse({ success: filled });
  }
});

class SignupFiller {
  constructor(data) { this.data = data || {}; }

  static FIELD_MAP = [
    { key: 'email', patterns: ['email', 'mail', 'address', 'login'], inputType: 'email' },
    { key: 'password', patterns: ['pass', 'pwd', 'secret', 'clue'], inputType: 'password' },
    { key: 'firstName', patterns: ['first', 'given', 'fname', 'forename'] },
    { key: 'lastName', patterns: ['last', 'family', 'lname', 'surname'] },
    { key: 'fullName', patterns: ['fullname', 'display', 'name', 'profile'], labelOnly: true },
    { key: 'username', patterns: ['user', 'login', 'handle', 'id', 'username', 'nick'] },
    { key: 'phone', patterns: ['phone', 'tel', 'mobile', 'cell', 'whatsapp', 'sms'], inputType: 'tel' }
  ];

  fill() {
    const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"])'));
    const visibleInputs = inputs.filter(el => this.isInputVisible(el));
    let count = 0;
    const used = new Set();

    // 0. AI-guided hints first (if available)
    count += this.fillUsingAIHints(used);

    // 1. Handle Names (Smart Branching)
    const firstNameField = this.match(visibleInputs, SignupFiller.FIELD_MAP.find(f => f.key === 'firstName'), used);
    const lastNameField = this.match(visibleInputs, SignupFiller.FIELD_MAP.find(f => f.key === 'lastName'), used);
    const genericNameField = this.match(visibleInputs, SignupFiller.FIELD_MAP.find(f => f.key === 'fullName'), used);

    if (firstNameField && lastNameField) {
      if (this.data.firstName) { this.simulateTyping(firstNameField, this.data.firstName); used.add(firstNameField); count++; }
      if (this.data.lastName) { this.simulateTyping(lastNameField, this.data.lastName); used.add(lastNameField); count++; }
    } else if (genericNameField && !used.has(genericNameField)) {
      const full = `${this.data.firstName || ''} ${this.data.lastName || ''}`.trim();
      if (full) {
        this.simulateTyping(genericNameField, full);
        used.add(genericNameField);
        count++;
      }
    } else if (firstNameField && !used.has(firstNameField)) {
      // Fallback: If only "firstName" matched (likely because it's labeled "Name")
      const full = `${this.data.firstName || ''} ${this.data.lastName || ''}`.trim();
      this.simulateTyping(firstNameField, full);
      used.add(firstNameField);
      count++;
    }

    // 2. Handle Remainder
    for (const field of SignupFiller.FIELD_MAP) {
      if (['firstName', 'lastName', 'fullName'].includes(field.key)) continue;
      const val = this.data[field.key];
      if (!val) continue;

      const el = this.match(visibleInputs, field, used);
      if (el) {
        if (field.key === 'username') {
          const attr = (el.name + el.id + el.placeholder).toLowerCase();
          if (attr.includes('email') || attr.includes('mail')) continue;
        }

        this.simulateTyping(el, val);
        used.add(el);
        count++;
      }
    }

    // 3. Confirm Passwords
    if (this.data.password) {
      count += this.fillAllPasswordFields(this.data.password, used);
      this.scheduleConfirmPasswordRetry(this.data.password);
    }

    return count;
  }

  valueForRole(role) {
    const fullName = `${this.data.firstName || ''} ${this.data.lastName || ''}`.trim();
    const map = {
      full_name: fullName,
      first_name: this.data.firstName || '',
      last_name: this.data.lastName || '',
      email: this.data.email || '',
      username: this.data.username || '',
      password: this.data.password || '',
      phone: this.data.phone || '',
      address: this.data.address || ''
    };
    return map[role] || '';
  }

  findByHintSelector(selector) {
    if (!selector || typeof selector !== 'string') return null;
    try {
      const found = document.querySelector(selector);
      if (found) return found;
    } catch { /* noop */ }

    const idMatch = selector.match(/^#(.+)/);
    if (idMatch) {
      const rawId = idMatch[1];
      try {
        return document.getElementById(rawId) || null;
      } catch { /* noop */ }
    }
    return null;
  }

  fillUsingAIHints(used) {
    const hints = Array.isArray(this.data.aiFieldHints) ? this.data.aiFieldHints : [];
    if (!hints.length) return 0;
    let count = 0;

    for (const hint of hints) {
      const role = (hint?.role || hint?.expected_role || '').toLowerCase();
      const selector = hint?.selector || '';
      if (!role || !selector || role === 'unknown') continue;
      const val = this.valueForRole(role);
      if (!val) continue;
      const el = this.findByHintSelector(selector);
      if (!el || used.has(el) || !this.isInputFillable(el)) continue;
      this.simulateTyping(el, val);
      used.add(el);
      count++;
    }

    return count;
  }

  isInputVisible(el) {
    if (!el) return false;
    if (!el.isConnected || el.disabled) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (el.offsetParent !== null) return true;
    return el.getClientRects().length > 0;
  }

  isInputFillable(el) {
    if (!this.isInputVisible(el)) return false;
    if (el.readOnly) return false;
    if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button') return false;
    return true;
  }

  fillAllPasswordFields(password, used = null) {
    const passwordFields = Array.from(document.querySelectorAll('input[type="password"]'))
      .filter(el => this.isInputFillable(el));
    let count = 0;

    passwordFields.forEach((pf) => {
      if (used && used.has(pf)) return;
      const needsFill = !pf.value || pf.value !== password;
      if (!needsFill) return;
      this.simulateTyping(pf, password);
      if (used) used.add(pf);
      count++;
    });

    return count;
  }

  scheduleConfirmPasswordRetry(password) {
    const retryMs = [120, 350, 800];
    retryMs.forEach((delay) => {
      setTimeout(() => {
        const passwordFields = Array.from(document.querySelectorAll('input[type="password"]'))
          .filter(el => this.isInputFillable(el));

        passwordFields.forEach((pf) => {
          const attr = `${pf.name || ''} ${pf.id || ''} ${pf.placeholder || ''} ${pf.getAttribute('aria-label') || ''} ${pf.autocomplete || ''}`.toLowerCase();
          const looksLikeConfirm = /(confirm|repeat|retype|again|verify)/.test(attr) || attr.includes('new-password');
          if (looksLikeConfirm || !pf.value || pf.value !== password) {
            this.simulateTyping(pf, password);
          }
        });
      }, delay);
    });
  }

  match(inputs, field, used) {
    if (!field) return null;

    // 1. Exact Input Type (Strongest)
    if (field.inputType) {
      const m = inputs.find(i => i.type === field.inputType && !used.has(i));
      if (m) return m;
    }

    // 2. Attributes (Weighted)
    for (const i of inputs) {
      if (used.has(i)) continue;
      const id = (i.id || '').toLowerCase();
      const name = (i.name || '').toLowerCase();
      const ph = (i.placeholder || '').toLowerCase();
      const al = (i.getAttribute('aria-label') || '').toLowerCase();
      const ac = (i.autocomplete || '').toLowerCase();
      const attrStr = `${id} ${name} ${ph} ${al} ${ac}`;

      if (field.patterns.some(p => {
        // Strict boundary check for common terms to avoid 'name' matching 'username'
        if (p === 'name') {
          return /(^|\s|_)name(_|\s|$)/.test(attrStr) || id === 'name' || name === 'name';
        }
        return attrStr.includes(p);
      })) return i;
    }

    // 3. Label Text (Standard and Deep Recursive)
    for (const i of inputs) {
      if (used.has(i)) continue;
      const lbl = this.findLabelText(i);
      if (lbl && field.patterns.some(p => {
        const lowerLbl = lbl.toLowerCase();
        if (p === 'name') return /(^|\s|_)name(\s|$|\*)/.test(lowerLbl);
        return lowerLbl.includes(p);
      })) return i;
    }

    return null;
  }

  findLabelText(i) {
    let lbl = '';
    // Standard label
    if (i.id) { const l = document.querySelector(`label[for="${i.id}"]`); if (l) lbl = l.innerText; }
    if (!lbl) { const p = i.closest('label'); if (p) lbl = p.innerText; }

    // Recursive nearby text search (up to 3 levels)
    if (!lbl) {
      let current = i;
      for (let depth = 0; depth < 3; depth++) {
        if (!current || current === document.body) break;

        // Scan siblings above
        let prev = current.previousElementSibling;
        while (prev) {
          if (prev.innerText && prev.innerText.trim().length > 1) {
            lbl = prev.innerText;
            break;
          }
          prev = prev.previousElementSibling;
        }
        if (lbl) break;

        // Move to parent
        current = current.parentElement;
      }
    }

    return lbl ? lbl.trim().replace(/\s+/g, ' ') : '';
  }

  // THE NUCLEAR SETTER - REACT COMPATIBLE
  simulateTyping(element, value) {
    element.focus();
    element.value = ''; // Clear first

    // 1. Try React Internal Setters
    const proto = Object.getPrototypeOf(element);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) {
      setter.call(element, value);
    } else {
      element.value = value;
    }

    // 2. Dispatch Input Events sequence
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));

    // 3. Fallback for older React/Angular
    // Sometimes typing one char triggers handlers
    if (element.value !== value) {
      element.value = value;
      element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: value[0] }));
      element.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, key: value[0] }));
      element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: value[0] }));
    }

    element.blur();
  }
}

class FormFiller extends SignupFiller {
  // Inherit typo simulation for login too
  constructor(user, pass, type) { super({}); this.user = user; this.pass = pass; }
  fill() {
    let c = 0;
    const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"])'));
    const passIn = inputs.find(i => i.type === 'password' && i.offsetParent);

    if (passIn) {
      this.simulateTyping(passIn, this.pass);
      c++;
      // Find user input before password
      const idx = inputs.indexOf(passIn);
      let userIn = null;
      // Look backwards for user field
      for (let i = idx - 1; i >= 0; i--) {
        const inp = inputs[i];
        if (inp.type === 'password') continue;
        if (inp.offsetParent) { userIn = inp; break; }
      }
      if (userIn && this.user) {
        this.simulateTyping(userIn, this.user);
        c++;
      }
    } else {
      // No password field (maybe email only step)
      if (this.user) {
        const userIn = inputs.find(i => (i.type === 'email' || i.type === 'text') && i.offsetParent);
        if (userIn) { this.simulateTyping(userIn, this.user); c++; }
      }
    }
    return c > 0;
  }
}
