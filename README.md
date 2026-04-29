# PassVault AI

PassVault AI is a Chrome extension that stores credentials in an encrypted local vault and helps fill login or signup forms with a hybrid engine (heuristics + AI context analysis).

## What this project does

PassVault AI combines three major capabilities:

1. **Local secure vault**
   - Stores login credentials, API keys, and secure notes.
   - Uses Web Crypto with **AES-GCM** encryption.
   - Derives encryption keys from the master password using **PBKDF2 (SHA-256)**.
   - Keeps decrypted vault data only in extension runtime memory while unlocked.

2. **Smart autofill and signup assistance**
   - Detects auth pages and injects fill actions on login/signup forms.
   - Uses rule-based detection and fallback logic for compatibility across many websites.
   - If the vault is locked, clicking the injected field icon opens an in-page unlock prompt (master password) before autofill continues.
   - Supports AI-assisted field analysis (DOM context and optional vision fallback via Cohere models).
   - Provides quick signup flow with generated passwords and profile-based field filling.
   - Captures new signup credentials and stores them back into the vault with conflict checks.

3. **Cloud backup/sync (Oracle ORDS)**
   - Pushes encrypted vault blobs to Oracle Cloud endpoints.
   - Pulls and merges cloud vault data with local data.
   - Supports restore from cloud during first-time setup.
   - Optional auto-sync on save.

## Architecture overview

### `popup.js`
- Main extension UI and state controller.
- Handles:
  - Master password setup/unlock/lock
  - Vault CRUD operations
  - Encryption/decryption and persistence to `chrome.storage.local`
  - AI settings and cloud settings management
  - Quick signup workflow and user profile persistence

### `background.js`
- Session manager for unlocked runtime state.
- Handles:
  - In-memory session vault + AI settings cache
  - Message routing between popup and content scripts
  - AI request orchestration and response interpretation
  - Signup queue/flush flow and safe overwrite handling
  - Encrypted background persistence for queued signup saves

### `content.js`
- Runs on pages and handles form interaction logic.
- Handles:
  - Page context extraction (fields, labels, headings, signals)
  - Login/signup intent heuristics
  - Robust filling routines compatible with modern frontend frameworks
  - Signup monitoring/capture and deferred save triggers
  - Toast feedback and injected tray/icon UX on auth pages

### `manifest.json`
- Manifest V3 configuration.
- Registers:
  - Background service worker
  - Content script on all URLs
  - Required permissions (`storage`, `activeTab`, `scripting`, `tabs`)
  - Host permissions for Cohere API and Oracle Cloud endpoints

## Security model

- Vault data is stored encrypted in local extension storage (`secureVault`).
- Encryption keys are derived from the user master password and not hardcoded.
- Background/runtime state is session-oriented and cleared when the vault is locked.
- AI matching uses credential names/tags for selection logic; secrets remain local.

## Feature details

- Vault entry types:
  - Login credentials
  - API keys
  - Secure notes
- Search + category filtering in popup UI.
- Per-entry create/edit/delete.
- Password generator with mixed character classes.
- AI settings:
  - DOM model selection
  - Vision model fallback
  - Auto-detect and API-key matching toggles
- Cloud settings:
  - ORDS base URL
  - DB username/password
  - Auto-sync toggle

## Setup and run (development)

1. Clone this repository.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select this project folder.
5. Open the extension popup:
   - First launch: create a master password.
   - Existing vault: unlock with the master password.
6. (Optional) Configure:
   - Cohere API key and models in **AI Settings**
   - Oracle Cloud ORDS credentials in **AI Settings > Oracle Cloud Sync**

## Typical usage flow

1. Unlock vault with master password.
2. Save credentials in the vault (or use quick signup).
3. Open a login/signup page.
4. Trigger fill:
   - from page tray/icon,
   - from popup autofill button, or
   - through AI-assisted matching.
5. On signup, generated credentials can be captured and persisted automatically.
6. Optionally sync encrypted vault state with Oracle Cloud.

## Project structure

```text
.
|- manifest.json
|- popup.html
|- popup.css
|- popup.js
|- background.js
|- content.js
`- icons/
```

## Notes

- This project currently ships as a plain extension codebase (no build step required).
- Keep API keys and cloud database credentials private.
- If you lose your master password, encrypted vault contents cannot be recovered.
