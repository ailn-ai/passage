# AILN Passage

**An ERC-721 collection on BNB Smart Chain representing an Agent's on-chain identity anchor.**

> ## ⚠️ Read this before anything else
>
> This repository contains **two different contracts**, and only one of them exists on a public chain.
>
> | | **[V3](./v3-deployed/) — DEPLOYED** | **[V4.1](./v4.1-candidate/) — NOT DEPLOYED** |
> | --- | --- | --- |
> | Status | **Live on BNB Chain** | **Local candidate only** |
> | Address | [`0x5A5514F65e1ECB8dE1C369c2703859f5f107ED52`](https://bscscan.com/address/0x5A5514F65e1ECB8dE1C369c2703859f5f107ED52) | **none — no address exists** |
> | `RESERVE_SUPPLY()` | does not exist on this contract | `1050` |
> | `publicMinted()` | does not exist on this contract | `0` |
> | `totalMinted()` | **0** | n/a (not deployed) |
> | Genesis reserve | none | 1,050 tokens, **not minted on chain** |
> | Deploy gas | — | 4,139,839 (measured locally) |
>
> **V4.1 is not deployed. There is no V4.1 address on BscScan. If you are looking for one, it does not exist yet.**
>
> The 1,050 genesis reserve in V4.1 is a design in the source code. **It has never been minted on any chain and is not part of any current on-chain supply.**

---

## What is deployed right now

`v3-deployed/` — the contract currently live on BNB Smart Chain.

| Fact | Value | How it was verified |
| --- | --- | --- |
| Address | `0x5A5514F65e1ECB8dE1C369c2703859f5f107ED52` | `eth_getCode` |
| Runtime size | 8,469 bytes | `eth_getCode` |
| `name()` | `AILN Passage` | `eth_call` |
| `symbol()` | `AILNP` | `eth_call` |
| `MAX_SUPPLY()` | 21,000 | `eth_call` |
| `totalMinted()` | **0** | `eth_call` |
| `priceOf()` | 0.1 BNB | `eth_call` |
| Owner / admin | **none — no `owner()`, no pause, no upgrade** | all such selectors revert |
| Mint open | **No** | permit issuance returns 503 |

**No token has ever been minted.** `totalMinted` is 0, the contract balance is 0, and the
payout address has never received a wei.

### How minting actually works

Minting is gated by an off-chain signed permit, not by a contract switch. There is no
`pause()` and no `setSaleOpen()` — the contract has no administrator entry at all.

```
mint() requires, in this order:
  1. supply remaining              ✓ 21,000 available
  2. a valid EIP-191 permit        ✗ issuance is paused (HTTP 503)
  3. exact price (0.1 BNB)         — never reached without a permit
  4. quota not exhausted           — quotaOf is 0 until a trial is confirmed
  5. holds a Binance Agent ID      — a hard requirement
```

Gate order was confirmed by simulation: calling `mint` with an empty permit returns
`bad sig length` **even when the payment amount is wrong**, so permit validation runs
strictly before the price check.

This repository does not include any contract that issues permits. **You cannot mint from
this repository**, and there is no public path to obtain a permit today.

---

## What is not deployed

`v4.1-candidate/` — a rewrite that adds a genesis reserve and a different storage model.

- **129 local tests pass.**
- Deployment cost dropped from 27,460,984 gas to **4,139,839** after fixing a storage
  design that exceeded BEP-652's 16,777,216 per-transaction cap.
- **It has never been deployed to any chain, public or testnet.**

See [`v4.1-candidate/NOT_DEPLOYED.md`](./v4.1-candidate/NOT_DEPLOYED.md).

**Do not use V4.1 addresses, ABIs, or behaviors in anything that expects the live contract.**
The two are not upgrade-compatible and share no storage layout.

---

## Repository layout

```
v3-deployed/          The live contract
├── src/              Solidity source (verified on Sourcify)
├── build/            Deployment record
└── docs/             Verification and audit notes

v4.1-candidate/       Undeployed rewrite
├── src/              Solidity source
├── test/             Five test suites, 129 checks
├── scripts/          Local compile and deploy
├── docs/             Gas report, storage decision, test results
└── NOT_DEPLOYED.md   Read this before anything else
```

---

## License

Solidity sources carry `SPDX-License-Identifier: MIT`.

**License scope is under review.** The contract code is independently licensable, but the
**AILN name, the Passage brand, and the token artwork are not** covered by an MIT grant on
the code. See the main repository's `LICENSE` decision draft and its brand-rights note.

---

## Status

```
v3-deployed/       LIVE       on BNB Chain, 0 minted
v4.1-candidate/    CANDIDATE  local only, never deployed
```

Anything not stated in this README should be treated as unknown. This project does not
claim ownership of any address, token supply, or sale schedule beyond the verified facts
above.
