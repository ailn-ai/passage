# NOT DEPLOYED

**This directory contains a contract that has never been deployed to any chain.**

---

## What this means, concretely

| Question | Answer |
| --- | --- |
| Is there a V4.1 address? | **No.** None exists on BNB Chain, BSC Testnet, or any other network. |
| Can I find it on BscScan? | **No.** Searching BscScan will not find this contract. |
| Is the 1,050 genesis reserve on chain? | **No.** It is a constant in the source. Zero have been minted. |
| Are the 129 passing tests on-chain proof? | **No.** They run against a local Ganache chain in a single process. |
| Can I call it from my app? | **No.** There is nothing to call. |

---

## What is actually verified

- **Compiles** with `solc 0.8.24`, viaIR enabled, optimizer 200.
- **129 local tests pass** across five suites (`test/`).
- **Deploy gas: 4,139,839** — measured on a local chain.
- An earlier revision cost **27,460,984 gas** and was rejected because it exceeded
  **BEP-652 / EIP-7825's 16,777,216 per-transaction gas cap** on BSC. That revision was
  never deployed either. The fix derived reserve ownership instead of storing it.

Local deployment gas is **not** evidence of a successful public deployment.

---

## What is not verified

- Behavior on BSC itself (only Ganache).
- Real wallet interaction (MetaMask, WalletConnect, Binance Agentic Wallet).
- Any interaction with the live Agent ID contract at scale.
- Gas under real network conditions and mempool contention.
- Anything at all about a public sale.

---

## Why it is in this repository anyway

Because the storage-design decision and the gas finding are useful to review, and because
hiding the work would make the V3/V4.1 distinction harder to understand, not easier.

The risk this file exists to prevent: someone reading `AILNPassageV4.sol`, assuming it
describes the live contract, and then looking for its address or expecting its 1,050
reserve to appear in `totalSupply()`.

**Neither is true.** The live contract is V3, it has no reserve, and `totalMinted` is 0.

---

## If you are building against AILN Passage today

Use **V3** at [`0x5A5514F65e1ECB8dE1C369c2703859f5f107ED52`](https://bscscan.com/address/0x5A5514F65e1ECB8dE1C369c2703859f5f107ED52).

But be aware: **minting is not open**, and this repository cannot open it. `mint()` requires
a permit signed by one of three AILN signer addresses, and permit issuance currently returns
HTTP 503. There is no public permit path.

Reading the contract is fine. Minting is not possible right now.
