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

The Pages workflow tests both `main` and `feature/direct-cast-modes`. A `main` push deploys only the production allowlist. Ordinary feature pushes only run tests. An explicit `staging/*` branch keeps an archived `main` tree byte-for-byte at the site root and adds that tested candidate below `/staging/<candidate-commit>/`. This gives the Cast Developer Console a commit-bound HTTPS receiver URL without changing the production Cast registration or merging feature code into `main`. The staging URL remains available until a later Pages deployment replaces it.
