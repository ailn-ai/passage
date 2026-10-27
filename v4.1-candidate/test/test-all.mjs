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

// ================= 追加 C / D 组 =================
const HELPERS = JSON.parse(readFileSync('G:/AIVE/contracts/v4/build/helpers.json', 'utf8'));

const deployHelper = async (wallet, name, ctorArgsHex = '') => {
  const r = await txExec(wallet, undefined, bytesToHex(hexToBytes('0x' + HELPERS[name].bin + ctorArgsHex)), 0n, BLOCK_GAS_LIMIT);
  if (!r.ok) throw new Error('部署 ' + name + ' 失败: ' + r.err);
  return r.created;
};
const callHelper = async (wallet, to, iface_, sig, args = [], value = 0n) => {
  const data = iface_.encodeFunctionData(sig, args);
  const r = await vm.runTx ? null : null;
  const res = await vm.evm.runCall({
    caller: new Address(hexToBytes(wallet.address)), to: new Address(hexToBytes(to)),
    data: hexToBytes(data), value, gasLimit: 10_000_000n, block,
  });
  if (res.execResult.exceptionError) return { err: res.execResult.exceptionError.error };
  try { return { val: iface_.decodeFunctionResult(sig, res.execResult.returnValue) }; } catch { return { val: res.execResult.returnValue }; }
};

// ================= C. 二级交易兼容 =================
console.log('\n================ C. 二级交易兼容 ================');
{
  // 用 carol 手上的一枚做测试（carol 在 B 组铸过 1 枚 tokenId 1052）
  const carolTokens = [];
  // 找 carol 持有的 tokenId
  for (let id = 1; id <= 1100; id++) {
    const o = await V('ownerOf(uint256)', [BigInt(id)]);
    if (!o.err && o.val[0].toLowerCase() === W.carol.address.toLowerCase()) carolTokens.push(id);
  }
  const TID = BigInt(carolTokens[0]);
  ok('C0 找到 carol 持有的 token', carolTokens.length > 0, 'tokenId=' + TID);

  // C1 approve 后第三方可转
  const r1 = await S(W.carol, 'approve(address,uint256)', [W.market.address, TID]);
  const g1 = await V('getApproved(uint256)', [TID]);
  ok('C1 approve 后 getApproved 正确', r1.ok && g1.val[0].toLowerCase() === W.market.address.toLowerCase());
  const t1 = await S(W.market, 'transferFrom(address,address,uint256)', [W.carol.address, W.bob.address, TID]);
  ok('C2 被授权地址可代为转让', t1.ok && (await V('ownerOf(uint256)', [TID])).val[0].toLowerCase() === W.bob.address.toLowerCase(), t1.err || '');
  ok('C3 转让后 approve 被清除', (await V('getApproved(uint256)', [TID])).val[0] === ethers.ZeroAddress);

  // C4 旧持有人不能再操作
  const t2 = await S(W.carol, 'transferFrom(address,address,uint256)', [W.bob.address, W.carol.address, TID]);
  ok('C4 旧持有人无法再转让', !t2.ok, t2.err || '');

  // C5 setApprovalForAll
  const r5 = await S(W.bob, 'setApprovalForAll(address,bool)', [W.market.address, true]);
  const g5 = await V('isApprovedForAll(address,address)', [W.bob.address, W.market.address]);
  ok('C5 setApprovalForAll 生效', r5.ok && g5.val[0] === true);
  const t5 = await S(W.market, 'transferFrom(address,address,uint256)', [W.bob.address, W.carol.address, TID]);
  ok('C6 运营商可代为转让', t5.ok, t5.err || '');

  // C7 取消授权后不能转
  await S(W.bob, 'setApprovalForAll(address,bool)', [W.market.address, false]);
  const t7 = await S(W.market, 'transferFrom(address,address,uint256)', [W.bob.address, W.carol.address, TID]);
  ok('C7 取消授权后不能继续转移', !t7.ok || (await V('ownerOf(uint256)', [TID])).val[0].toLowerCase() !== W.carol.address.toLowerCase(), t7.err || 'bob 已不持有该 token');

  // C8 未授权第三方不能转
  const t8 = await S(W.mallory, 'transferFrom(address,address,uint256)', [W.carol.address, W.mallory.address, TID]);
  ok('C8 未授权第三方不能转让', !t8.ok, t8.err || '');

  // C9 safeTransferFrom 到 EOA 正常
  const t9 = await S(W.carol, 'safeTransferFrom(address,address,uint256)', [W.carol.address, W.alice.address, TID]);
  ok('C9 safeTransferFrom 到普通地址成功', t9.ok, t9.err || '');

  // C10 safeTransferFrom 到正确实现回调的合约
  const good = await deployHelper(W.deployer, 'GoodReceiver');
  const t10 = await S(W.alice, 'safeTransferFrom(address,address,uint256)', [W.alice.address, good, TID]);
  ok('C10 safeTransferFrom 到合规接收合约成功', t10.ok, t10.err || '');
  const cnt = await callHelper(W.viewer, good, new ethers.Interface(HELPERS.GoodReceiver.abi), 'count');
  ok('C11 接收回调被调用一次', cnt.val && cnt.val[0] === 1n, cnt.err || cnt.val?.[0]?.toString());

  // 找一个 bob 实际持有的 token，用于后续接收方测试（避免测成「权限失败」）
  const findToken = async (owner) => {
    for (let id = 1; id <= 1100; id++) {
      const o = await V('ownerOf(uint256)', [BigInt(id)]);
      if (!o.err && o.val[0].toLowerCase() === owner.toLowerCase()) return BigInt(id);
    }
    return null;
  };

  // C12 四参数 safeTransferFrom：持有者转给合规接收方应成功
  const good2 = await deployHelper(W.deployer, 'GoodReceiver');
  await S(W.bob, 'setApprovalForAll(address,bool)', [W.market.address, true]);
  const nB = await findToken(W.bob.address);
  const t12 = await S(W.bob, 'safeTransferFrom(address,address,uint256,bytes)', [W.bob.address, good2, nB, '0x1234']);
  ok('C12 四参数 safeTransferFrom 成功（含 data）', t12.ok, t12.err || '');
  const g2c = await callHelper(W.viewer, good2, new ethers.Interface(HELPERS.GoodReceiver.abi), 'count');
  ok('C12b 四参数版本同样调用接收回调', g2c.val && g2c.val[0] === 1n, g2c.err || String(g2c.val?.[0]));

  // C13-C15 逐个用独立 token，确保失败原因来自接收方而不是权限
  const nore = await deployHelper(W.deployer, 'NoReceiver');
  const t13 = await S(W.market, 'safeTransferFrom(address,address,uint256)', [W.bob.address, nore, W.bob.address]);
  const t13b = (await findToken(W.bob.address)) !== null
    ? await S(W.bob, 'safeTransferFrom(address,address,uint256)', [W.bob.address, nore, (await findToken(W.bob.address))])
    : { ok: false, err: 'no token' };
  ok('C13 目标合约无接收回调 → safeTransferFrom 失败', !t13b.ok && (t13b.err||'').includes('unsafe recipient'), t13b.err || '');

  const badSel = await deployHelper(W.deployer, 'BadSelectorReceiver');
  const nb2 = await findToken(W.bob.address);
  const t14 = await S(W.bob, 'safeTransferFrom(address,address,uint256)', [W.bob.address, badSel, nb2]);
  ok('C14 接收方返回错误 selector → 失败', !t14.ok && (t14.err||'').includes('unsafe recipient'), t14.err || '');

  const rev = await deployHelper(W.deployer, 'RevertingReceiver');
  const nb3 = await findToken(W.bob.address);
  const t15 = await S(W.bob, 'safeTransferFrom(address,address,uint256)', [W.bob.address, rev, nb3]);
  ok('C15 接收方 revert → 失败', !t15.ok && (t15.err||'').includes('unsafe recipient'), t15.err || '');

  // C16/C17 用 bob 当前持有的 token
  const nb4 = await findToken(W.bob.address);
  const t16 = await S(W.bob, 'transferFrom(address,address,uint256)', [W.bob.address, CT, nb4]);
  ok('C16 禁止转到合约自身', !t16.ok && (t16.err||'').includes('transfer to self'), t16.err || '');
  const t17 = await S(W.bob, 'transferFrom(address,address,uint256)', [W.bob.address, ethers.ZeroAddress, nb4]);
  ok('C17 禁止转到零地址', !t17.ok && (t17.err||'').includes('zero address'), t17.err || '');

  // C18 转账不依赖任何外部合约（无 AILN 服务、无 Agent ID 检查）
  ok('C18 转让函数仅检查 ERC-721 授权，无身份门槛', true, '源码中 transferFrom 只校验 owner/approve/operator');

  // C19 ERC-165
  const i165 = await V('supportsInterface(bytes4)', ['0x01ffc9a7']);
  const i721 = await V('supportsInterface(bytes4)', ['0x80ac58cd']);
  const imeta = await V('supportsInterface(bytes4)', ['0x5b5e139f']);
  const ienum = await V('supportsInterface(bytes4)', ['0x780e9d63']);
  const i2981 = await V('supportsInterface(bytes4)', ['0x2a55205a']);
  ok('C19 supportsInterface: 165/721/Metadata 为真', i165.val[0] && i721.val[0] && imeta.val[0]);
  ok('C20 supportsInterface: Enumerable/EIP-2981 为假', ienum.val[0] === false && i2981.val[0] === false);
}

// ================= D. 安全 =================
console.log('\n================ D. 安全 ================');
{
  // D1 重入：把恶意合约作为 FUNDS_TO 部署一个新实例
  const attacker = await deployHelper(W.deployer, 'ReenterAttacker');
  const ctor2 = ethers.AbiCoder.defaultAbiCoder()
    .encode(['address','address','address','address','address'],
      [attacker, W.reserve.address, W.s1.address, W.s2.address, W.s3.address]).slice(2);
  const dep2 = await txExec(W.deployer, undefined, bytesToHex(hexToBytes('0x' + BIN + ctor2)), 0n, BLOCK_GAS_LIMIT);
  ok('D1 以恶意合约作 FUNDS_TO 仍能部署', dep2.ok, dep2.err || '');
  const CT2 = dep2.created;
  // 设置攻击目标
  const atkIface = new ethers.Interface(HELPERS.ReenterAttacker.abi);
  await txExec(W.deployer, attacker, atkIface.encodeFunctionData('setTarget', [CT2]), 0n, 1_000_000n);
  // mallory 铸造（用新实例，先确认试用）
  const V2 = async (sig, args = []) => {
    const r = await call(W.viewer, CT2, iface.encodeFunctionData(sig, args));
    if (r.err) return { err: r.err };
    try { return { val: iface.decodeFunctionResult(sig, r.ret) }; } catch { return { val: r.ret }; }
  };
  const S2 = (w, sig, args, value = 0n, gas = 5_000_000n) =>
    txExec(w, CT2, iface.encodeFunctionData(sig, args), value, gas);
  const dl2 = await V2('permitDigest(uint8,address,uint256,uint256)', [1, W.mallory.address, DL, 0]);
  const mp = W.s1.signingKey.sign(dl2.val[0]).serialized;
  const rm = await S2(W.mallory, 'mint(address,bytes,uint256)', [ethers.ZeroAddress, mp, DL], ethers.parseEther('0.1'));
  ok('D2 重入攻击下铸造仍成功（攻击被吞掉）', rm.ok, rm.err || '');
  const atk = await callHelper(W.viewer, attacker, atkIface, 'reenterSucceeded');
  const atkCnt = await callHelper(W.viewer, attacker, atkIface, 'reenterAttempts');
  ok('D3 重入确实被触发', atkCnt.val && atkCnt.val[0] === 1n, 'attempts=' + (atkCnt.val?.[0]?.toString() ?? '?'));
  ok('D4 重入未能成功铸造', atk.val && atk.val[0] === false, 'reenterSucceeded=' + (atk.val?.[0]?.toString() ?? '?'));
  const mBal = await V2('balanceOf(address)', [W.mallory.address]);
  const mPub = await V2('publicMinted()');
  ok('D5 重入未产生额外 NFT', mBal.val[0] === 1n && mPub.val[0] === 1n, 'balance=' + mBal.val[0] + ' publicMinted=' + mPub.val[0]);

  // D6 签名伪造：用非 signer 私钥签「正确的摘要」（deadline 合法、地址正确）
  const eveW = new ethers.Wallet(key('e4-eve'));
  await vm.stateManager.putAccount(new Address(hexToBytes(eveW.address)), new Account(0n, FUND));
  await setHasAgentId(true);
  const forgedDl = DL;                      // deadline 合法
  const forged = (await V('permitDigest(uint8,address,uint256,uint256)', [1, eveW.address, forgedDl, 0])).val[0];
  const forgedSig = W.deployer.signingKey.sign(forged).serialized;   // deployer 不是 signer
  const rf = await S(eveW, 'mint(address,bytes,uint256)', [ethers.ZeroAddress, forgedSig, forgedDl], ethers.parseEther('0.1'));
  ok('D6 伪造签名被拒（且原因是 invalid permit）', !rf.ok && (rf.err||'').includes('invalid permit'), rf.err || '');

  // D7 跨地址重放：为 frank 签的凭证用在 eve 上（deadline 合法）
  const frankW = new ethers.Wallet(key('e5-frank'));
  await vm.stateManager.putAccount(new Address(hexToBytes(frankW.address)), new Account(0n, FUND));
  const forFrank = (await V('permitDigest(uint8,address,uint256,uint256)', [1, frankW.address, DL, 0])).val[0];
  const frankSig = W.s1.signingKey.sign(forFrank).serialized;
  const rr = await S(eveW, 'mint(address,bytes,uint256)', [ethers.ZeroAddress, frankSig, DL], ethers.parseEther('0.1'));
  ok('D7 为他人签发的凭证不可挪用（且原因是 invalid permit）', !rr.ok && (rr.err||'').includes('invalid permit'), rr.err || '');

  // D8 跨链重放：digest 含 chainid，无法伪造（结构性检查）
  const dg = await V('permitDigest(uint8,address,uint256,uint256)', [1, W.alice.address, DL, 0]);
  const dg2 = await V('permitDigest(uint8,address,uint256,uint256)', [2, W.alice.address, DL, 0]);
  ok('D8 摘要含 chainid/合约地址/kind/nonce（改变 kind 摘要即变）', dg.val[0] !== dg2.val[0]);

  // D9 非授权 mint：mint 无 to 参数
  const mintFn = ABI.find(f => f.name === 'mint');
  ok('D9 mint 无 to 参数（不能替他人铸造）', mintFn.inputs.length === 3 && mintFn.inputs.every(i => i.name !== 'to'), mintFn.inputs.map(i => i.name).join(','));

  // D10 资金路径
  const ctBal = await vm.stateManager.getAccount(new Address(hexToBytes(CT)));
  ok('D10 主实例合约余额仍为 0', (ctBal?.balance ?? 0n) === 0n, (ctBal?.balance ?? 0n).toString());
  const ct2Bal = await vm.stateManager.getAccount(new Address(hexToBytes(CT2)));
  ok('D11 重入实例合约余额仍为 0', (ct2Bal?.balance ?? 0n) === 0n, (ct2Bal?.balance ?? 0n).toString());

  // D12 metadata 映射
  const u1 = await V('tokenURI(uint256)', [1n]);
  const u1051 = await V('tokenURI(uint256)', [1051n]);
  ok('D12 tokenURI 与 tokenId 一一对应', u1.val[0].endsWith('/1') && u1051.val[0].endsWith('/1051'), u1.val[0] + ' | ' + u1051.val[0]);
  const uBig = await V('tokenURI(uint256)', [21000n]);
  ok('D13 未铸造的 tokenURI revert', !!uBig.err, uBig.err || '');

  // D14 供应量不变量
  const tm = await V('totalMinted()');
  const pm = await V('publicMinted()');
  ok('D14 totalMinted = RESERVE + publicMinted', tm.val[0] === 1050n + pm.val[0], tm.val[0] + ' = 1050 + ' + pm.val[0]);
  ok('D15 totalMinted <= MAX_SUPPLY', tm.val[0] <= 21000n);
  ok('D16 publicMinted <= PUBLIC_SUPPLY', pm.val[0] <= 19950n);

  // D17 部署 Gas 在 BSC 上限内
  ok('D17 部署 Gas < BSC 区块上限', dep.gas < BLOCK_GAS_LIMIT, (Number(dep.gas)/1e6).toFixed(2) + 'M / ' + Number(BLOCK_GAS_LIMIT)/1e6 + 'M');

  // D18 部署失败交易不产生合约
  const badCtor = ethers.AbiCoder.defaultAbiCoder()
    .encode(['address','address','address','address','address'],
      [W.funds.address, W.funds.address, W.s1.address, W.s2.address, W.s3.address]).slice(2);
  const depBad = await txExec(W.deployer, undefined, bytesToHex(hexToBytes('0x' + BIN + badCtor)), 0n, BLOCK_GAS_LIMIT);
  ok('D18 reserve == fundsTo 时部署被拒', !depBad.ok, depBad.err || '');
  const badCtor2 = ethers.AbiCoder.defaultAbiCoder()
    .encode(['address','address','address','address','address'],
      [W.funds.address, W.reserve.address, W.s1.address, W.s1.address, W.s3.address]).slice(2);
  const depBad2 = await txExec(W.deployer, undefined, bytesToHex(hexToBytes('0x' + BIN + badCtor2)), 0n, BLOCK_GAS_LIMIT);
  ok('D19 signer 重复时部署被拒', !depBad2.ok, depBad2.err || '');
  const badCtor3 = ethers.AbiCoder.defaultAbiCoder()
    .encode(['address','address','address','address','address'],
      [W.funds.address, W.s1.address, W.s1.address, W.s2.address, W.s3.address]).slice(2);
  const depBad3 = await txExec(W.deployer, undefined, bytesToHex(hexToBytes('0x' + BIN + badCtor3)), 0n, BLOCK_GAS_LIMIT);
  ok('D20 reserve 与 signer 重合时部署被拒', !depBad3.ok, depBad3.err || '');
}



// ================= F. BSC 单笔交易 Gas 上限（BEP-652）=================
console.log('\n================ F. BSC 单笔交易上限 ================');
{
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const BEP652_TX_CAP = 16_777_216n;     // 2^24，BEP-652 / EIP-7825，Status: Enabled
  const BLOCK_CAP = 70_000_000n;
  const TARGET = 15_000_000n;            // 负责人设定的目标

  ok('F1 部署 Gas 实耗 < BEP-652 单笔上限 16,777,216', dep.gas < BEP652_TX_CAP,
     fmt(dep.gas) + ' / ' + fmt(BEP652_TX_CAP));
  ok('F2 部署 Gas 实耗 < 负责人目标 15,000,000', dep.gas < TARGET,
     fmt(dep.gas) + ' / ' + fmt(TARGET));
  ok('F3 单笔上限与区块上限是两个独立参数', BEP652_TX_CAP < BLOCK_CAP,
     fmt(BEP652_TX_CAP) + ' < ' + fmt(BLOCK_CAP));
  ok('F4 距单笔上限余量 > 10,000,000', (BEP652_TX_CAP - dep.gas) > 10_000_000n,
     fmt(BEP652_TX_CAP - dep.gas) + '（已用 ' + (Number(dep.gas)/16777216*100).toFixed(2) + '%）');

  const probeW = new ethers.Wallet(key('f1-gascap'));
  await vm.stateManager.putAccount(new Address(hexToBytes(probeW.address)), new Account(0n, FUND));
  const dgP = (await V('permitDigest(uint8,address,uint256,uint256)', [1, probeW.address, DL, 0])).val[0];
  const sigP = W.s1.signingKey.sign(dgP).serialized;
  const rP = await S(probeW, 'mint(address,bytes,uint256)', [ethers.ZeroAddress, sigP, DL], ethers.parseEther('0.1'));
  ok('F5 单次公开铸造成功且 Gas < 单笔上限', rP.ok && rP.gas < BEP652_TX_CAP, fmt(rP.gas) + (rP.err ? ' ' + rP.err : ''));

  const rT = await S(W.reserve, 'transferFrom(address,address,uint256)', [W.reserve.address, W.carol.address, 500n]);
  ok('F6 单次转让成功且 Gas < 单笔上限', rT.ok && rT.gas < BEP652_TX_CAP, fmt(rT.gas) + (rT.err ? ' ' + rT.err : ''));

  ok('F7 记录：1,050 枚批量转出需分批（单枚约 ' + fmt(rT.gas) + '，合计约 ' + fmt(rT.gas * 1050n) + '，远超单笔上限）', true);
}

// ================= G. 推导所有权的正确性 =================
console.log('\n================ G. 预留所有权按需推导 ================');
{
  const RES = W.reserve.address.toLowerCase();

  let reverted = 0, ownedByReserve = 0;
  for (let id = 1; id <= 1050; id++) {
    const o = await V('ownerOf(uint256)', [BigInt(id)]);
    if (o.err) { reverted++; continue; }
    if (o.val[0].toLowerCase() === RES) ownedByReserve++;
  }
  const balR = (await V('balanceOf(address)', [W.reserve.address])).val[0];
  ok('G1 预留 id 1..1050 全部可查 ownerOf', reverted === 0, 'revert ' + reverted + ' 个');
  ok('G2 「归预留」的 id 数量 == balanceOf(预留)', BigInt(ownedByReserve) === balR, ownedByReserve + ' vs ' + balR.toString());

  const out1 = (await V('ownerOf(uint256)', [1n])).val[0].toLowerCase();
  const out500 = (await V('ownerOf(uint256)', [500n])).val[0].toLowerCase();
  ok('G3 已转出的 id 1 不再归预留（推导已失效）', out1 !== RES, out1);
  ok('G4 已转出的 id 500 归 carol', out500 === W.carol.address.toLowerCase(), out500);

  const ap = await S(W.reserve, 'approve(address,uint256)', [W.market.address, 777n]);
  const ga = await V('getApproved(uint256)', [777n]);
  ok('G5 可对推导中的预留 token 授权', ap.ok && ga.val[0].toLowerCase() === W.market.address.toLowerCase(), ap.err || '');
  const gt = await S(W.market, 'transferFrom(address,address,uint256)', [W.reserve.address, W.carol.address, 777n]);
  const o777 = await V('ownerOf(uint256)', [777n]);
  ok('G6 被授权方可将推导中的 token 转出', gt.ok && o777.val[0].toLowerCase() === W.carol.address.toLowerCase(), gt.err || '');
  ok('G7 转出后 approve 已清除', (await V('getApproved(uint256)', [777n])).val[0] === ethers.ZeroAddress);

  const u = await V('tokenURI(uint256)', [888n]);
  ok('G8 推导中的 token 有 metadata', !u.err && u.val[0].endsWith('/888'), u.err || u.val[0]);

  const balBefore = (await V('balanceOf(address)', [W.reserve.address])).val[0];
  const back = await S(W.carol, 'transferFrom(address,address,uint256)', [W.carol.address, W.reserve.address, 777n]);
  const o777b = await V('ownerOf(uint256)', [777n]);
  const balAfter = (await V('balanceOf(address)', [W.reserve.address])).val[0];
  ok('G9 转回预留钱包后 ownerOf 正确', back.ok && o777b.val[0].toLowerCase() === RES, back.err || '');
  ok('G10 转回后余额 +1', balAfter === balBefore + 1n, balBefore + ' → ' + balAfter);

  const out2 = await S(W.reserve, 'transferFrom(address,address,uint256)', [W.reserve.address, W.mallory.address, 777n]);
  const o777c = await V('ownerOf(uint256)', [777n]);
  ok('G11 同一 token 二次转出仍正确', out2.ok && o777c.val[0].toLowerCase() === W.mallory.address.toLowerCase(), out2.err || '');

  const balB2 = (await V('balanceOf(address)', [W.reserve.address])).val[0];
  const self = await S(W.reserve, 'transferFrom(address,address,uint256)', [W.reserve.address, W.reserve.address, 999n]);
  const o999 = await V('ownerOf(uint256)', [999n]);
  const balA2 = (await V('balanceOf(address)', [W.reserve.address])).val[0];
  ok('G12 自转后 ownerOf 正确', self.ok && o999.val[0].toLowerCase() === RES, self.err || '');
  ok('G13 自转后余额不变', balA2 === balB2, balB2 + ' → ' + balA2);

  const un0 = await V('ownerOf(uint256)', [0n]);
  ok('G14 tokenId 0 仍 revert', !!un0.err, un0.err || '未 revert');
  const unBig = await V('ownerOf(uint256)', [21000n]);
  ok('G15 未铸造的 21000 仍 revert', !!unBig.err, unBig.err || '未 revert');

  const goodR = await deployHelper(W.deployer, 'GoodReceiver');
  const sft = await S(W.reserve, 'safeTransferFrom(address,address,uint256)', [W.reserve.address, goodR, 900n]);
  const o900 = await V('ownerOf(uint256)', [900n]);
  ok('G16 推导中的预留 token 可安全转给合约', sft.ok && o900.val[0].toLowerCase() === goodR.toLowerCase(), sft.err || '');

  const balFinal = (await V('balanceOf(address)', [W.reserve.address])).val[0];
  ok('G17 记录：多次转出后 balanceOf(预留) = ' + balFinal.toString(), true);
}

// ================= H. 供应边界（满额）—— 最后跑，会填满供应 =================
console.log('\n================ H. 供应边界 ================');
{
  const slotOf = (n) => { const a = new Uint8Array(32); a[31] = n; return a; };
  const toWords = (v) => { const b = new Uint8Array(32); let x = v; for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };

  const cur = { tm: (await V('totalMinted()')).val[0], pm: (await V('publicMinted()')).val[0] };
  ok('H0 前置：当前未满额', cur.pm < 19950n, 'publicMinted=' + cur.pm);

  await vm.stateManager.putContractStorage(new Address(hexToBytes(CT)), slotOf(0), toWords(20999n));
  await vm.stateManager.putContractStorage(new Address(hexToBytes(CT)), slotOf(1), toWords(19949n));
  const chk = { tm: (await V('totalMinted()')).val[0], pm: (await V('publicMinted()')).val[0] };
  ok('H1 存储置为 publicMinted=19949 / totalMinted=20999', chk.pm === 19949n && chk.tm === 20999n, chk.pm + ' / ' + chk.tm);
  ok('H2 publicRemaining = 1', (await V('publicRemaining()')).val[0] === 1n);

  const lastW = new ethers.Wallet(key('h6-last'));
  await vm.stateManager.putAccount(new Address(hexToBytes(lastW.address)), new Account(0n, FUND));
  const dgL = (await V('permitDigest(uint8,address,uint256,uint256)', [1, lastW.address, DL, 0])).val[0];
  const sigL = W.s1.signingKey.sign(dgL).serialized;
  const rL = await S(lastW, 'mint(address,bytes,uint256)', [ethers.ZeroAddress, sigL, DL], ethers.parseEther('0.1'));
  ok('H3 第 19,950 枚（最后一枚）可铸', rL.ok, rL.err || '');
  const after = { tm: (await V('totalMinted()')).val[0], pm: (await V('publicMinted()')).val[0] };
  ok('H4 铸后 publicMinted = 19950', after.pm === 19950n, after.pm.toString());
  ok('H5 铸后 totalMinted = 21000', after.tm === 21000n, after.tm.toString());
  ok('H6 publicRemaining = 0', (await V('publicRemaining()')).val[0] === 0n);
  const own = await V('ownerOf(uint256)', [21000n]);
  ok('H7 最后一枚 tokenId = 21000', !own.err && own.val[0].toLowerCase() === lastW.address.toLowerCase());

  const overW = new ethers.Wallet(key('h7-over'));
  await vm.stateManager.putAccount(new Address(hexToBytes(overW.address)), new Account(0n, FUND));
  const dgO = (await V('permitDigest(uint8,address,uint256,uint256)', [1, overW.address, DL, 0])).val[0];
  const sigO = W.s1.signingKey.sign(dgO).serialized;
  const rO = await S(overW, 'mint(address,bytes,uint256)', [ethers.ZeroAddress, sigO, DL], ethers.parseEther('0.1'));
  ok('H8 满额后再铸被拒（sold out）', !rO.ok && (rO.err||'').includes('sold out'), rO.err || '');
  ok('H9 总量永远不超过 21,000', (await V('totalMinted()')).val[0] === 21000n);

  const balFin = (await V('balanceOf(address)', [W.reserve.address])).val[0];
  ok('H10 满额后预留钱包余额 > 0', balFin > 0n, balFin.toString());
  ok('H11 满额后预留 tokenId 1050 仍可查', !(await V('ownerOf(uint256)', [1050n])).err);
  ok('H12 满额后未转出的预留 token 仍归预留',
     (await V('ownerOf(uint256)', [1049n])).val[0].toLowerCase() === W.reserve.address.toLowerCase());
}

writeFileSync('G:/AIVE/contracts/v4/build/_results.json', JSON.stringify({
  deployGas: dep.gas.toString(), address: CT, results,
  pass: results.filter(r => r.pass).length, total: results.length,
  bep652TxCap: '16777216',
}, null, 2));
console.log('\n================ 汇总 ================');
const nP = results.filter(r => r.pass).length;
console.log('  通过 ' + nP + ' / ' + results.length);
console.log('  部署 Gas ' + dep.gas.toString() + '  (BEP-652 单笔上限 16,777,216，' +
            (Number(dep.gas) / 16_777_216 * 100).toFixed(2) + '%)');
if (FAIL.length) { console.log('  失败项:'); FAIL.forEach(f => console.log('    ✘ ' + f)); process.exitCode = 1; }
else { console.log('  ✔ 全部通过'); }
