# Model aliases (model-alias)

## What problem this solves

The built-in "Settings → Models" page splits its add flow in two:

- **Custom providers** can be added repeatedly, because each lands at its own key `llm-pi-ai.providers.<name>`;
- **Standard vendors** (OpenAI, Anthropic, Moonshot, … — the installed catalog) disappear from the add list once configured (`addable` lists only unconfigured vendors; when none is left the vendor tab disables with "exhausted").

So a second API key for the same vendor has nowhere to go. This plugin adds that ability:

- a new settings page **"Model aliases"** right after Models;
- the vendor select lists **every standard vendor at all times** — configured ones carry a marker but stay selectable, so the option never exhausts;
- each entry carries an **alias** (the profile's `displayName`, which is what the composer model picker shows) and **its own API key** under the route's derived credential reference (e.g. `OPENAI_WORK_API_KEY`).

## How it works

It writes exactly the pi-ai profile shape the built-in "custom provider" flow uses:

```yaml
# user layer of the llm-pi-ai settings section
providers:
  openai-work:                 # route id (immutable after creation; it addresses the profile)
    displayName: OpenAI work   # alias → its own group in the model picker
    api: openai-completions    # anthropic → anthropic-messages, Gemini → google-generative-ai
    baseURL: https://api.openai.com/v1
    apiKeyEnv: OPENAI_WORK_API_KEY
    models:
      - id: gpt-4o
```

- A route key outside the installed catalog is a **hand-declared route**: `api`, `baseURL`, and a non-empty `models` list are required (the form enforces all three);
- The model list can be **fetched from the vendor endpoint** (`llm/discoverModels` with the freshly typed key) or filled in by hand; fetched entries merge with hand-added ones and never overwrite existing rows;
- After creation the route appears on the built-in Models page (tagged "custom") and as its own provider group in the composer model picker.

Editing an existing alias uses **minimal path ops**: only changed fields are written (alias / base URL / protocol / models / new key), so deployment-owned fields (retryPolicy, headers, …) survive; model-list edits merge over the stored entries and keep fields this form does not manage (e.g. `reasoningEfforts`, `compat`). **Removal** unsets the credential first, then the route; both steps are idempotent and safe to retry.

## Why not patch the built-in Models page

- The client module table rejects duplicate factory registrations, so no bundle can replace the shipped `@deepseek-ai/dsh-client-ui-settings-models` implementation;
- Shadowing the shipped `settings.section` cell with the same id would require reimplementing the whole page (provider cards, editors, onboarding — thousands of lines) and would break on upgrades.
- The plugin is therefore purely additive: keep using the built-in page for each vendor's first configuration; manage every additional key here.

## Data locations

- Route profiles: the user layer of the `llm-pi-ai` settings section (same document the built-in page reads);
- API keys: the credentials service (`credentials/set`), under `<ROUTE>_API_KEY`;
- Uninstalling the plugin removes only the entry point; declared routes keep serving (the configuration lives in the settings document, not in the plugin).

## Known limitations

- Covers the pi-ai family (standard key vendors) only; official DeepSeek (`llm-deepseek`, single whole-section profile) and account sign-in are out of scope;
- A route id cannot change after creation (rename = delete + recreate);
- On read-only deployments every write control is disabled.
