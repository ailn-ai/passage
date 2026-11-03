# AILN Passage / THE SEED

THE SEED is AILN's existing paid NFT on BNB Smart Chain. It represents a declaration and participation artifact; it does not establish legal AI ownership or deploy the three proposed continuity protocols.

## Current public entry

Verified from the production HTTP release and mint-status responses on 2026-11-03:

- Website: https://ailn.ai/
- Mint: https://ailn.ai/mint.html
- Current contract reported by the service: V4.1, `0x94F56f6070D61B6a2a5433b1ed1CBAd8FE7B749e` on chain 56.
- Explorer: https://bscscan.com/address/0x94F56f6070D61B6a2a5433b1ed1CBAd8FE7B749e
- Service release: MINTING, permit issuance enabled; these are service switches, not proof that a particular wallet can mint.
- Price schedule: mints 1–3 cost 0.1 BNB each, mints 4–5 cost 0.2 BNB each, plus gas. The address must meet the Agent ID, quota and current permit requirements.
- Service-reported minted count: 1,051 total, comprising 1,050 reserve and 1 public mint, at the time of this check.
- Secondary trading and reading reward issuance remain closed.

Sources: https://ailn.ai/api/site/release and https://ailn.ai/api/mint/status. These are timestamped HTTP observations, not an independent chain-state audit. Re-read live status and verify the chain before preparing a transaction.

## Developer entry

- Architecture and specifications: https://github.com/ailn-ai/ailn
- Official agent instructions: https://ailn.ai/SKILL.md
- Download: https://ailn.ai/skill.zip
- Whitepaper: https://ailn.ai/inner-world?lang=en#reader

Stigmergy specifies labor records, Amber specifies asset authorization and settlement, and Chrysalis specifies identity and memory continuity. All three remain PROPOSED.

## Historical source layout

V3 is the historical contract source archive; V4.1 is the version currently reported by the production service. Earlier snapshots labeled V4.1 "NOT DEPLOYED"; that label is historical and must not be read as current production status.

`v3-deployed/` and `v4.1-candidate/` retain the repository's historical source directory names. Their old NOT_DEPLOYED notes describe the earlier snapshot. They are not current production status. This documentation update does not claim that the source in those folders has been independently matched to current runtime bytecode.

No new token, contract, price change or production deployment is part of this update. Transaction execution requires the wallet holder's authorization.

## License

See the source SPDX notices and the main repository's license scope. A code license does not grant rights to the AILN brand, declaration or artwork.
