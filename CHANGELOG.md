# Changelog

## [0.2.16](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/compare/v0.2.15...v0.2.16) (2026-10-28)


### Features

* **portal:** restyle sign-in and no-access pages ([#189](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/189)) ([3d0ddd0](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/3d0ddd0771c58f1c00281f5aae449b37a88b3604))

## [0.2.15](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/compare/v0.2.14...v0.2.15) (2026-10-28)


### Features

* **deploy:** portal zip-deploy script ([#185](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/185)) ([75e9e10](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/75e9e100d5452db7a841e8217c4e65eb1a05efb9))


### Bug Fixes

* **infra:** drop stale github-oauth-client-secret from portal secret names ([#184](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/184)) ([90d8e3d](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/90d8e3dc8532ae600d6641818df70518119570be))
* **infra:** portal public access and optional IPv4 allowlist ([#183](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/183)) ([a40877f](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/a40877fac35a12a0c76ae12f88bd92e28926fc4d))

## [0.2.14](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/compare/v0.2.13...v0.2.14) (2026-10-28)


### Features

* **infra:** enable raw archive blob recovery protection ([#181](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/181)) ([d954a9f](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/d954a9f41186479ed337bac0e0119cbfee0b403e))

## [0.2.13](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/compare/v0.2.12...v0.2.13) (2026-10-28)


### Features

* add explicit Entra initial-access bootstrap ([#180](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/180)) ([02aa431](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/02aa4315a54c8854a9755783f6ebcfb8b0c96427))
* add partial feedback list and vote slice ([#177](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/177)) ([d789f61](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/d789f61366618d3637d6aa36f9446649761d8b65))
* add read-only Budget Lookup module ([#176](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/176)) ([d09363a](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/d09363aa8d3bab49814653073ff512a0baadd010))
* budget mvp contract ([#165](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/165)) ([973991d](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/973991df9a4e81280f84cc3aa3a1fef9b0a30370))
* **db:** add bounded historical grant-conflict contract ([#179](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/179)) ([d474dd1](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/d474dd14be2032c06d3b5bd2385853bc033c4cf8)), closes [#172](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/172)
* implement metrics reconciliation report ([#166](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/166)) ([b996221](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/b9962218c00f26415fa3a5b4ec469a6ed9483496))
* port existing-principal administration workflows ([#178](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/178)) ([25bf1da](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/25bf1daa70dd70be84e07408a2a0f4e44192b0ae))


### Bug Fixes

* bound local E2E sign-in route readiness ([#175](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/175)) ([365d6c4](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/365d6c4cc2c2270a6a3fd6a7857685a502c99846))
* limit break-glass authorization to SQL outages ([#174](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/174)) ([29f7801](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/29f7801cb642797b7ab7188fec7388a0f0a8eac0))

## [0.2.12](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/compare/v0.2.11...v0.2.12) (2026-10-27)


### Features

* acquire metrics reports and package the gated timer ([#150](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/150)) ([cdf69bb](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/cdf69bbb5070e211f3988e37446d15c1eff3a4af))
* add metrics reconciliation comparison contract ([#163](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/163)) ([556b183](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/556b183257f2acb0447f2cc83e305e3b9878ed80))
* add one-time legacy metrics importer ([#161](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/161)) ([502a1c4](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/502a1c4583418cf542c65d252402d830c0afcbd0))
* **db:** add component-scoped ingestion SQL contract ([#158](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/158)) ([2d0e600](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/2d0e600f420330fee7649fe325d10bc808c6d85e))
* register directory Functions timer ([#148](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/148)) ([433f589](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/433f58939655e7800c708de2c5b7ebbb0992daa6))
* switch metrics user writer to component procedure ([#160](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/160)) ([7db0298](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/7db02980de54321e62e1b5f7b6eb7fd7e18431e2))


### Bug Fixes

* include validated peers in metrics artifact closure ([4a4151a](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/4a4151a1d85dfdbc360f0560c0c570c04855c2a4))
* key reference mapper family rows by their own name field ([#140](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/140)) ([08a974e](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/08a974e034ba736c726c8cb646ae929f0b58fa83)), closes [#133](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/133)
* lock directory artifact dependencies ([41be19b](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/41be19b90db04765d4555e99c193b03d45bd5f9a))

## [0.2.11](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/compare/v0.2.10...v0.2.11) (2026-10-27)


### Features

* add fixture-backed directory synchronization ([#146](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/146)) ([8b490b3](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/8b490b39d982c08212db70d5bba49d16f8f193d0))
* add per-user manager resolution contract ([#156](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/156)) ([c78d94a](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/c78d94a0a95712364cdc6f65585e64e65f5c8bf3))


### Bug Fixes

* require per-user evidence for team manager edges ([5ea8d98](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/5ea8d98f0d6c0e47d5e586ed4dd27f81d070af78))
* retain negative directory evidence across publication rollback ([1ffe3be](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/1ffe3be73a218747cefea074d4326bb347f224c0))

## [0.2.10](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/compare/v0.2.9...v0.2.10) (2026-10-27)


### Features

* add explicit user-only Key Vault operator access ([#155](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/155)) ([f0e0ea4](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/f0e0ea4c4a94986577904076abcfbc6c0f409a98))


### Bug Fixes

* configure the portal canonical authentication URL ([#152](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/152)) ([32bdb00](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/32bdb00fb8ae270f522f0884d64ceba1d718801e))

## [0.2.9](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/compare/v0.2.8...v0.2.9) (2026-10-27)


### Features

* add immutable-identity sign-in and fail-closed access states ([#101](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/101)) ([041fa87](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/041fa87edd42aa4c2d9ebec8a313b8639c9ba420))
* add metrics day loader ([#117](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/117)) ([3ed10cb](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/3ed10cb868622d997c887ad9014c8f8e59a58042))
* add metrics runtime configuration ([#136](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/136)) ([c7f4562](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/c7f456292c0b13abfcaebb2893121698b9be4822))
* add restoration schema and null-only compatibility ([#125](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/125)) ([400b152](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/400b152d745ec43fd537b7a94ec6cda68eaad175))
* add scoped period request contract ([#135](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/135)) ([413e1ce](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/413e1ce9e6c78502e11edf8e0d4cc3811877dadf))
* add scoped portal usage API ([#108](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/108)) ([ab73438](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/ab7343865ecd4dedc50c87d8a9e496bd69c5c897))
* **contracts:** add live GitHub Budget Lookup contract ([#102](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/102)) ([33b5e1e](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/33b5e1ec659e69beb0199c7055328a8b56e36419))
* define core-view API DTO and exact-credit contracts ([#131](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/131)) ([df1b114](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/df1b114763eb1d618e9d1cbecbcbdd8358202079))
* define Phase 2 ingestion settings and directory inputs ([#98](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/98)) ([1a3ac3d](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/1a3ac3dae706caf630331a55d680e7f90e09fc85)), closes [#69](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/69)
* **infra:** portal sign-in and access-state deployment settings ([#111](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/111)) ([96ddb53](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/96ddb53859e3d21241ddf2a40d2073ac0cc34985))
* isolate directory runtime infrastructure ([#118](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/118)) ([dc02203](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/dc0220326cb08ae823ac017ddd9b951cf07764c3))
* move raw archive to Cool tier ([#83](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/83)) ([ed1372a](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/ed1372a7741048d6fc8807dbdbac9f71ea244dd4))
* portal shell and core pages ([#89](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/89)) ([#105](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/105)) ([6104fd1](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/6104fd1649d42ed12bfca01f3bb26e63b5f2b5e6))
* preserve core-view source metrics ([#132](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/132)) ([1dd239e](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/1dd239e2d492042669493cd6d991b4f65ace51c3))
* publish portal FAQ and contextual help links ([#126](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/126)) ([53db8ba](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/53db8ba37f83cb374e4558e921abfa4ed797ffa3))


### Bug Fixes

* **e2e:** isolate Safe Alpha secondary CI server ([126b708](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/126b708e37b1fa70ce2f75f41e211447e9e5410b))
* **e2e:** isolate secondary CI from Turbopack reloads ([fb8adf5](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/fb8adf52577f2948a809b9947f6f83dd4cdaea9d))
* **e2e:** wait for exact Help title before axe scan ([#139](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/139)) ([0813743](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/0813743dccaf9de944c6ccfa6738e21f60744059))
* honor Copilot App IDE prompt availability ([#147](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/147)) ([c810f76](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/c810f76f64ff30e9c6731532a3bf05aa08ec759b))
* recover feature-backed Copilot App IDE aggregates ([#123](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/123)) ([a6a8f38](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/a6a8f3897edad6a3e26a5c30a43c7419594a3dc4))
* respect unavailable Copilot App prompt counts ([6f92cd4](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/6f92cd4bf09554fe91016927e8df382b1cafb79b))
* restore Copilot App IDE prompt fallback ([ef1ecc8](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/ef1ecc802b4aecde23c0fba915c14e7e7234fbc3))
* restrict alpha Key Vault access to app egress ([#151](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/151)) ([84994d6](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/84994d68a8c91dc76e39fbadf86e3c41f6761954))
* restrict safe alpha portal surface ([783cef5](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/783cef5a48141f371bc7050a5e20a368f9d62107))
* restrict Safe Alpha portal surface ([#149](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/149)) ([e75d760](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/e75d7604fe9cbe61fa329cc6c194d3d1ba7ece7a))

## [0.2.8](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/compare/v0.2.7...v0.2.8) (2026-10-25)


### Bug Fixes

* harden shared contract validation and billing keys ([#62](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/62)) ([bd0bae1](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/bd0bae1d03e5a7e65b4ce59cd591c9165b712a07))
* refuse test sign-in in production ([#58](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/58)) ([0e24326](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/0e243262a8ef0dfe3f818c95f13f4e91f4e8fb23))

## [0.2.7](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/compare/v0.2.6...v0.2.7) (2026-10-25)


### Features

* access-model contracts (issue [#44](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/44)) ([#48](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/48)) ([011ddc2](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/011ddc2c4eea581a90bcab505ceafd01c4a961cd))
* Phase 1 foundations (migration runner, local stack, integration harness, runbooks) ([#52](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/52)) ([44791ff](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/44791ff4279ad98af8aec3913c0819f0670a47c9))

## [0.2.6](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/compare/v0.2.5...v0.2.6) (2026-10-25)


### Features

* D-47 data contracts (migrations, docs, shared types, contract tests) ([#39](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/39)) ([69e674d](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/69e674dcddd698b795fcd58d9ba0ccc0dad26cfe))

## [0.2.5](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/compare/v0.2.4...v0.2.5) (2026-10-24)


### Bug Fixes

* **infra:** make default SKUs deployable (zone redundancy, SQL size and serverless min capacity) ([#31](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/31)) ([4ac8d4b](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/4ac8d4b9aba4ab337598750b31b63878ca16a9b9))

## [0.2.4](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/compare/v0.2.3...v0.2.4) (2026-10-24)


### Bug Fixes

* **infra:** stop creating Key Vault secrets in Terraform ([#29](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/29)) ([db8437e](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/db8437e087e5ad7986a8f70c3df77e49ddfffcef))

## [0.2.3](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/compare/v0.2.2...v0.2.3) (2026-10-24)


### Features

* **infra:** split deploy-infra.sh into init, validate, plan and apply steps ([#27](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/27)) ([2b282d8](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/2b282d8b57fb701bcae6548038296c18a86c955a))


### Bug Fixes

* **infra:** use Entra and OIDC auth for the state backend ([#26](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/26)) ([5d81414](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/5d81414f3896907a474678a74b62636f02a2970b))

## [0.2.2](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/compare/v0.2.1...v0.2.2) (2026-10-24)


### Bug Fixes

* **infra:** fail early when terraform or az is missing ([#24](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/24)) ([f75f29c](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/f75f29c3968f0b84dc4df796427ab8ae1a9c160c))

## [0.2.1](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/compare/v0.2.0...v0.2.1) (2026-10-24)


### Features

* **infra:** support deploying into an existing resource group ([#21](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/21)) ([7e82cf6](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/7e82cf637c46c45cea1e783dbd809cdd6c46eb0f))

## [0.2.0](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/compare/v0.1.0...v0.2.0) (2026-10-24)


### Features

* add storage, key vault, sql, apps, alerts and infra deploy scripts ([#19](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/19)) ([406b8cc](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/406b8cce45eb69439f4b5a6292fdd86daed62e94))
* **infra:** add monitoring and runtime identities from AVM ([#17](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/17)) ([1abb6b1](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/1abb6b164e11d8c69d9f0ca291b399186ceb77aa))

## 0.1.0 (2026-10-24)


### Features

* **infra:** add Terraform skeleton with module flags and validation ([#13](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/13)) ([c4ec489](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/c4ec4898f8617b4229ff7d2aef3efa0d34b14f9a))
* Phase 0 PoC and Phase 1 skeleton ([#2](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/2)) ([30ece7f](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/30ece7f72f732d7a3af7a4722626fdc05ee79e15))


### Bug Fixes

* run bug-backlog script without top-level await ([#10](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/10)) ([10c01d5](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/10c01d5467b17e1263a8b7009cf9bfa7a8885b38))
* start first release at 0.1.0 ([#16](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/issues/16)) ([1e28187](https://github.com/MohamedSahbi/github-copilot-enterprise-usage-metrics/commit/1e28187bc691d99cc5845be9295dde56501df5db))
