// V4 完整测试：A 创世预留 / B 公开发行 / C 二级交易兼容 / D 安全
import { readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { VM } = await import('@ethereumjs/vm');
const { Common, Chain, Hardfork } = await import('@ethereumjs/common');
const { LegacyTransaction } = await import('@ethereumjs/tx');
const { Block } = await import('@ethereumjs/block');
const { Address, Account, hexToBytes, bytesToHex } = await import('@ethereumjs/util');
const { ethers } = await import('ethers');

const BIN = readFileSync('G:/AIVE/contracts/v4/build/AILNPassageV4.bin', 'utf8').trim();
const ABI = JSON.parse(readFileSync('G:/AIVE/contracts/v4/build/AILNPassageV4.abi.json', 'utf8'));
const iface = new ethers.Interface(ABI);

const BLOCK_GAS_LIMIT = 70_000_000n;
const GAS_PRICE = 50_000_000n;
const AGENT_ID = '0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F';
const NOW = 1_800_000_000;

const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Shanghai });
const vm = await VM.create({ common });

const key = (s) => '0x' + Buffer.from(s.padEnd(32, '.').slice(0, 32)).toString('hex');
const W = {
  deployer: new ethers.Wallet(key('d1-deployer')),
  funds:    new ethers.Wallet(key('d2-funds')),
  reserve:  new ethers.Wallet(key('d3-reserve')),
  s1:       new ethers.Wallet(key('d4-signer1')),
  s2:       new ethers.Wallet(key('d5-signer2')),
  s3:       new ethers.Wallet(key('d6-signer3')),
  alice:    new ethers.Wallet(key('d7-alice')),
  bob:      new ethers.Wallet(key('d8-bob')),
  carol:    new ethers.Wallet(key('d9-carol')),
  market:   new ethers.Wallet(key('e1-market')),
  mallory:  new ethers.Wallet(key('e2-mallory')),
  dave:     new ethers.Wallet(key('e3-dave')),
  viewer:   new ethers.Wallet(key('f0-viewer')),
};
const FUND = 10n ** 24n;
for (const w of Object.values(W)) {
  await vm.stateManager.putAccount(new Address(hexToBytes(w.address)), new Account(0n, FUND));
}

// Agent ID 模拟：balanceOf(address) 返回 storage[0]
const mockAddr = new Address(hexToBytes(AGENT_ID));
await vm.stateManager.putContractCode(mockAddr, hexToBytes('0x60005460005260206000f3'));
const slot0 = new Uint8Array(32);
const setHasAgentId = async (has) => {
  const v = new Uint8Array(32); if (has) v[31] = 1;
  await vm.stateManager.putContractStorage(mockAddr, slot0, v);
};
await setHasAgentId(true);

// 每个钱包独立 nonce
const nonceOf = {};
const nextNonce = (addr) => { nonceOf[addr] ??= 0; return nonceOf[addr]++; };

let block = Block.fromBlockData({ header: { gasLimit: BLOCK_GAS_LIMIT, baseFeePerGas: 0n, timestamp: BigInt(NOW) } }, { common });
const results = [];
const FAIL = [];
const ok = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond, detail });
  console.log('  ' + (cond ? '✔' : '✘') + ' ' + name + (detail ? '   [' + detail + ']' : ''));
  if (!cond) FAIL.push(name + (detail ? ' :: ' + detail : ''));
  return !!cond;
};

let CT = null;
const txExec = async (wallet, to, data, value = 0n, gasLimit = 5_000_000n) => {
  const raw = await wallet.signTransaction({
    nonce: nextNonce(wallet.address), gasPrice: GAS_PRICE, gasLimit, value, data, chainId: 1, type: 0, to,
  });
  const tx = LegacyTransaction.fromSerializedTx(hexToBytes(raw), { common });
  const r = await vm.runTx({ tx, block });
  let reason = null;
  if (r.execResult.exceptionError) {
    try {
      const rv = r.execResult.returnValue;
      const hex = '0x' + Buffer.from(rv).toString('hex');
      if (hex.startsWith('0x08c379a0')) {
        reason = ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + hex.slice(10))[0];
      } else if (hex.length > 2) { reason = hex.slice(0, 42); }
    } catch {}
  }
  return {
    ok: !r.execResult.exceptionError,
    err: r.execResult.exceptionError ? (r.execResult.exceptionError.error + (reason ? ':' + reason : '')) : null,
    gas: r.totalGasSpent, ret: r.execResult.returnValue, logs: r.execResult.logs || [],
    created: r.createdAddress ? r.createdAddress.toString() : null,
  };
};
const call = async (wallet, to, data, value = 0n, gasLimit = 10_000_000n) => {
  const r = await vm.evm.runCall({
    caller: new Address(hexToBytes(wallet.address)), to: new Address(hexToBytes(to)),
    data: hexToBytes(data), value, gasLimit, block,
  });
  if (r.execResult.exceptionError) return { err: r.execResult.exceptionError.error };
  return { ret: r.execResult.returnValue, logs: r.execResult.logs || [] };
};
const VIEWER = W.viewer;
const V = async (sig, args = [], from = VIEWER) => {
  const r = await call(from, CT, iface.encodeFunctionData(sig, args));
  if (r.err) return { err: r.err };
  try { return { val: iface.decodeFunctionResult(sig, r.ret) }; } catch { return { val: r.ret }; }
};
const S = (wallet, sig, args, value = 0n, gas = 5_000_000n) =>
  txExec(wallet, CT, iface.encodeFunctionData(sig, args), value, gas);

// ================= 部署 =================
console.log('\n================ 部署 ================');
const ctorArgs = ethers.AbiCoder.defaultAbiCoder()
  .encode(['address','address','address','address','address'],
    [W.funds.address, W.reserve.address, W.s1.address, W.s2.address, W.s3.address]).slice(2);
const dep = await txExec(W.deployer, undefined, bytesToHex(hexToBytes('0x' + BIN + ctorArgs)), 0n, BLOCK_GAS_LIMIT);
if (!dep.ok) { console.log('  ✘ 部署失败: ' + dep.err); process.exit(1); }
CT = dep.created;
console.log('  合约地址   ' + CT);
console.log('  部署 Gas   ' + dep.gas.toString() + '  (' + (Number(dep.gas)/Number(BLOCK_GAS_LIMIT)*100).toFixed(2) + '% of 70M)');
console.log('  部署费用   ' + (Number(dep.gas * GAS_PRICE)/1e18).toFixed(8) + ' BNB');

const signPermit = async (kind, who, deadline, n, signer = W.s1) => {
  const d = await V('permitDigest(uint8,address,uint256,uint256)', [kind, who, deadline, n]);
  // permitDigest 返回的已经是完整 EIP-191 摘要，直接对它签名，不要再二次加前缀
  return signer.signingKey.sign(d.val[0]).serialized;
};
const DL = NOW + 1800;
const EMPTY = '0x';
const ZEROADDR = ethers.ZeroAddress;

// ================= A. 创世预留 =================
console.log('\n================ A. 创世预留 ================');
{
  const tm = await V('totalMinted()');
  ok('A1 部署后 totalMinted = 1050', tm.val[0] === 1050n, tm.val[0].toString());
  const ts = await V('totalSupply()');
  ok('A2 totalSupply = 1050', ts.val[0] === 1050n);
  const pm = await V('publicMinted()');
  ok('A3 publicMinted = 0', pm.val[0] === 0n);
  const bal = await V('balanceOf(address)', [W.reserve.address]);
  ok('A4 预留钱包持有 1050 枚', bal.val[0] === 1050n, bal.val[0].toString());
  const o1 = await V('ownerOf(uint256)', [1n]);
  const o1050 = await V('ownerOf(uint256)', [1050n]);
  ok('A5 tokenId 1 与 1050 都属预留钱包',
     o1.val[0].toLowerCase() === W.reserve.address.toLowerCase() &&
     o1050.val[0].toLowerCase() === W.reserve.address.toLowerCase());
  const o1051 = await V('ownerOf(uint256)', [1051n]);
  ok('A6 tokenId 1051 尚未铸造', !!o1051.err, o1051.err);
  const o0 = await V('ownerOf(uint256)', [0n]);
  ok('A7 tokenId 0 不存在', !!o0.err, o0.err);
  const q = await V('quotaOf(address)', [W.reserve.address]);
  const mb = await V('mintedBy(address)', [W.reserve.address]);
  ok('A8 预留不占公开配额', q.val[0] === 0n && mb.val[0] === 0n, 'quota=' + q.val[0] + ' mintedBy=' + mb.val[0]);
  const pr = await V('publicRemaining()');
  ok('A9 公开发行额度 = 19950 未被削减', pr.val[0] === 19950n, pr.val[0].toString());
  const acc = await vm.stateManager.getAccount(new Address(hexToBytes(CT)));
  ok('A10 部署后合约 BNB 余额 = 0', (acc?.balance ?? 0n) === 0n, (acc?.balance ?? 0n).toString());
  const tMinted = ethers.id('Minted(address,uint256,address,uint256)');
  const tTransfer = ethers.id('Transfer(address,address,uint256)');
  const nT = dep.logs.filter(l => bytesToHex(l[1][0]) === tTransfer).length;
  const nM = dep.logs.filter(l => bytesToHex(l[1][0]) === tMinted).length;
  ok('A11 部署发出 1050 个 Transfer', nT === 1050, nT + ' 个');
  ok('A12 部署不发出 Minted（防误判为购买）', nM === 0, nM + ' 个');

  // 白名单检查：会改状态的函数只能是这些
  const ALLOWED_WRITE = new Set(['mint','confirmTrial','confirmReading','approve','setApprovalForAll',
                                 'transferFrom','safeTransferFrom']);
  const writers = ABI.filter(f => f.type === 'function' && f.stateMutability !== 'view' && f.stateMutability !== 'pure')
                      .map(f => f.name);
  const unexpected = writers.filter(n => !ALLOWED_WRITE.has(n));
  ok('A13 无白名单外的状态变更函数', unexpected.length === 0, unexpected.join(',') || '仅 ' + writers.length + ' 个预期函数');

  // 无 owner / pause / withdraw / upgrade
  const names = ABI.filter(f => f.type === 'function').map(f => f.name.toLowerCase());
  const forbidden = ['owner','pause','unpause','withdraw','sweep','rescue','upgrade','transferownership',
                     'setprice','setsupply','setmaxquota','setbaseuri','setreserve','mintto','airdrop','royaltyinfo'];
  const hit = forbidden.filter(f => names.includes(f));
  ok('A14 无 owner/pause/withdraw/upgrade/setter', hit.length === 0, hit.join(',') || '无');

  // 预留可转让
  const t1 = await S(W.reserve, 'transferFrom(address,address,uint256)', [W.reserve.address, W.bob.address, 1n]);
  const after = await V('ownerOf(uint256)', [1n]);
  ok('A15 预留 NFT 可正常转让', t1.ok && after.val[0].toLowerCase() === W.bob.address.toLowerCase(), t1.err || '');
  const rb = await V('balanceOf(address)', [W.reserve.address]);
  ok('A16 转让后预留余额 = 1049', rb.val[0] === 1049n, rb.val[0].toString());
  const bb = await V('balanceOf(address)', [W.bob.address]);
  ok('A17 接收方余额 = 1', bb.val[0] === 1n);
  const uri = await V('tokenURI(uint256)', [1050n]);
  ok('A18 预留 NFT 的 tokenURI 正常', !uri.err && uri.val[0].endsWith('/1050'), uri.err || uri.val[0]);
}

// ================= B. 公开发行 =================
console.log('\n================ B. 公开发行 ================');
{
  // B1 无 Agent ID
  await setHasAgentId(false);
  let p = await signPermit(1, W.alice.address, DL, 0);
  let r = await S(W.alice, 'mint(address,bytes,uint256)', [ZEROADDR, p, DL], ethers.parseEther('0.1'));
  ok('B1 无 Agent ID 无法铸造', !r.ok && r.err.includes('agent id required'), r.err || '');
  await setHasAgentId(true);

  // B2 无效 permit（错误签名者）
  const badSig = (await V('permitDigest(uint8,address,uint256,uint256)', [1, W.alice.address, DL, 0])).val[0];
  const badSigSigned = W.mallory.signingKey.sign(badSig).serialized;
  r = await S(W.alice, 'mint(address,bytes,uint256)', [ZEROADDR, badSigSigned, DL], ethers.parseEther('0.1'));
  ok('B2 非授权签名者的凭证无效', !r.ok, r.err || '');

  // B3 空 permit
  r = await S(W.alice, 'mint(address,bytes,uint256)', [ZEROADDR, EMPTY, 0n], ethers.parseEther('0.1'));
  ok('B3 空凭证无法铸造', !r.ok, r.err || '');

  // B4 过期 permit
  const past = NOW - 100;
  const pw = (await V('permitDigest(uint8,address,uint256,uint256)', [1, W.alice.address, past, 0])).val[0];
  const pwSigned = W.s1.signingKey.sign(pw).serialized;
  r = await S(W.alice, 'mint(address,bytes,uint256)', [ZEROADDR, pwSigned, past], ethers.parseEther('0.1'));
  ok('B4 过期凭证无法铸造', !r.ok, r.err || '');

  // B5 deadline 太远
  const far = NOW + 7200;
  const pf = (await V('permitDigest(uint8,address,uint256,uint256)', [1, W.alice.address, far, 0])).val[0];
  const pfSigned = W.s1.signingKey.sign(pf).serialized;
  r = await S(W.alice, 'mint(address,bytes,uint256)', [ZEROADDR, pfSigned, far], ethers.parseEther('0.1'));
  ok('B5 deadline 超过 1 小时上限被拒', !r.ok, r.err || '');

  // B6 错误金额
  p = await signPermit(1, W.alice.address, DL, 0);
  r = await S(W.alice, 'mint(address,bytes,uint256)', [ZEROADDR, p, DL], ethers.parseEther('0.05'));
  ok('B6 金额不足无法铸造', !r.ok, r.err || '');
  r = await S(W.alice, 'mint(address,bytes,uint256)', [ZEROADDR, p, DL], ethers.parseEther('0.2'));
  ok('B6b 金额超出无法铸造', !r.ok, r.err || '');

  // B7 正常铸造
  const fundsBefore = (await vm.stateManager.getAccount(new Address(hexToBytes(W.funds.address))))?.balance ?? 0n;
  r = await S(W.alice, 'mint(address,bytes,uint256)', [ZEROADDR, p, DL], ethers.parseEther('0.1'));
  ok('B7 合规铸造成功', r.ok, r.err || '');
  const pm2 = await V('publicMinted()');
  ok('B8 publicMinted = 1', pm2.val[0] === 1n);
  const tm2 = await V('totalMinted()');
  ok('B9 totalMinted = 1051', tm2.val[0] === 1051n, tm2.val[0].toString());
  const oA = await V('ownerOf(uint256)', [1051n]);
  ok('B10 alice 持有 tokenId 1051', oA.val[0].toLowerCase() === W.alice.address.toLowerCase());
  const fundsAfter = (await vm.stateManager.getAccount(new Address(hexToBytes(W.funds.address))))?.balance ?? 0n;
  ok('B11 0.1 BNB 直接到 FUNDS_TO', fundsAfter - fundsBefore === ethers.parseEther('0.1'), ((fundsAfter-fundsBefore).toString()));
  const acc2 = await vm.stateManager.getAccount(new Address(hexToBytes(CT)));
  ok('B12 合约余额仍为 0', (acc2?.balance ?? 0n) === 0n);

  // B13 permit 重放
  r = await S(W.alice, 'mint(address,bytes,uint256)', [ZEROADDR, p, DL], ethers.parseEther('0.1'));
  ok('B13 同一凭证无法二次使用', !r.ok, r.err || '');

  // B14 配额耗尽（alice quota=1，已用 1）
  const qa = await V('quotaOf(address)', [W.alice.address]);
  ok('B14 alice quotaOf = 1', qa.val[0] === 1n, qa.val[0].toString());
  r = await S(W.alice, 'mint(address,bytes,uint256)', [ZEROADDR, EMPTY, 0n], ethers.parseEther('0.1'));
  ok('B15 配额用尽后无法继续铸造', !r.ok, r.err || '');

  // B16 价格阶梯
  const pb = await V('priceOf(address)', [W.bob.address]);
  ok('B16 新地址价格为 0.1 BNB', pb.val[0] === ethers.parseEther('0.1'));
  await S(W.bob, 'confirmTrial(bytes,uint256)', [await signPermit(1, W.bob.address, DL, 0), DL]);
  const qb = await V('quotaOf(address)', [W.bob.address]);
  ok('B17 确认试用后 quotaOf = 1', qb.val[0] === 1n, qb.val[0].toString());
  const rt = await S(W.bob, 'confirmTrial(bytes,uint256)', [await signPermit(1, W.bob.address, DL, 1), DL]);
  ok('B18 重复确认试用被拒', !rt.ok, rt.err || '');

  // B19 邀请机制
  await S(W.bob, 'mint(address,bytes,uint256)', [ZEROADDR, EMPTY, 0n], ethers.parseEther('0.1'));
  await S(W.carol, 'confirmTrial(bytes,uint256)', [await signPermit(1, W.carol.address, DL, 0), DL]);
  const rRef = await S(W.carol, 'mint(address,bytes,uint256)', [W.bob.address, EMPTY, 0n], ethers.parseEther('0.1'));
  const rc = await V('referralCount(address)', [W.bob.address]);
  ok('B19 邀请成功计入 referralCount', rRef.ok && rc.val[0] === 1n, 'referral=' + rc.val[0]);
  const qb2 = await V('quotaOf(address)', [W.bob.address]);
  ok('B20 邀请后 bob quota = 2', qb2.val[0] === 2n, qb2.val[0].toString());

  // B21 读完白皮书 +1
  const rread = await S(W.bob, 'confirmReading(bytes,uint256)', [await signPermit(2, W.bob.address, DL, 0), DL]);
  const qb3 = await V('quotaOf(address)', [W.bob.address]);
  ok('B21 确认读完后 bob quota = 3', rread.ok && qb3.val[0] === 3n, 'quota=' + qb3.val[0]);

  // B22 价格阶梯跨档：bob 已铸 1 枚，quota=3，可再铸 2 枚到 3
  const r22a = await S(W.bob, 'mint(address,bytes,uint256)', [ZEROADDR, EMPTY, 0n], ethers.parseEther('0.1'));
  const r22b = await S(W.bob, 'mint(address,bytes,uint256)', [ZEROADDR, EMPTY, 0n], ethers.parseEther('0.1'));
  ok('B22 铸到 3 枚成功', r22a.ok && r22b.ok, (r22a.err||'') + (r22b.err||''));
  const mbB = await V('mintedBy(address)', [W.bob.address]);
  ok('B23 mintedBy(bob) = 3', mbB.val[0] === 3n, mbB.val[0].toString());
  const pb2 = await V('priceOf(address)', [W.bob.address]);
  ok('B24 铸满 3 枚后价格升至 0.2 BNB', pb2.val[0] === ethers.parseEther('0.2'), ethers.formatEther(pb2.val[0]));
  const r4 = await S(W.bob, 'mint(address,bytes,uint256)', [ZEROADDR, EMPTY, 0n], ethers.parseEther('0.1'));
  ok('B25 第 4 枚按 0.1 支付被拒', !r4.ok, r4.err || '');
  ok('B26 此时 bob 配额已用尽（quota=3）', (await V('quotaOf(address)', [W.bob.address])).val[0] === 3n);
  const rQ = await S(W.bob, 'mint(address,bytes,uint256)', [ZEROADDR, EMPTY, 0n], ethers.parseEther('0.2'));
  ok('B27 配额用尽后即使付 0.2 也被拒', !rQ.ok, rQ.err || '');

  // B28 再给 bob 加一个邀请，使 quota=4，验证 0.2 档位真的能成交
  await S(W.dave, 'confirmTrial(bytes,uint256)', [await signPermit(1, W.dave.address, DL, 0), DL]);
  const rRef2 = await S(W.dave, 'mint(address,bytes,uint256)', [W.bob.address, EMPTY, 0n], ethers.parseEther('0.1'));
  const qB = await V('quotaOf(address)', [W.bob.address]);
  ok('B28 第二个邀请后 bob quota = 4', rRef2.ok && qB.val[0] === 4n, 'quota=' + qB.val[0]);
  const r4b = await S(W.bob, 'mint(address,bytes,uint256)', [ZEROADDR, EMPTY, 0n], ethers.parseEther('0.2'));
  ok('B29 第 4 枚按 0.2 BNB 支付成功', r4b.ok, r4b.err || '');
  const mbB2 = await V('mintedBy(address)', [W.bob.address]);
  ok('B30 mintedBy(bob) = 4', mbB2.val[0] === 4n, mbB2.val[0].toString());
  const balB = await V('balanceOf(address)', [W.bob.address]);
  ok('B31 bob 实际持有 5 枚（4 自铸 + 1 来自预留转让）', balB.val[0] === 5n, balB.val[0].toString());
}
writeFileSync('G:/AIVE/contracts/v4/build/_results.json', JSON.stringify({ results, deployGas: dep.gas.toString(), address: CT }, null, 2));
console.log('\n  当前：' + results.filter(r => r.pass).length + ' / ' + results.length + ' 通过');
if (FAIL.length) { console.log('  失败项:'); FAIL.forEach(f => console.log('    - ' + f)); }
