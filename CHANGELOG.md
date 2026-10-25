# Changelog

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
