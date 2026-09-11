# Trevuxa Cast Receiver

Custom Google Cast Web Receiver for Trevuxa. Production consists only of:

- `index.html` and `styles.css`;
- `receiver-core.js`, which contains deterministic route, WebVTT, style and sync logic;
- `receiver-trevuxa.js`, the legacy-ES5 CAF runtime;
- the privacy policy and terms.

The sender chooses one explicit route:

- `DIRECT_SOURCE`: one remote MP4, optionally with remote VTT;
- `RECEIVER_SEPARATE_TRACKS`: experimental video plus companion audio;
- `PHONE_REMUX`: one MP4 prepared and served by the Android sender.

Run all compatibility and runtime tests with:

```sh
node --check receiver-core.js
node --check receiver-trevuxa.js
node --test test/*.test.js
```

The Pages workflow tests both `main` and `feature/direct-cast-modes`, but deploys only an explicitly tested `main` commit. It stages an allowlist so historical receiver and MP4Box files are never published accidentally.
