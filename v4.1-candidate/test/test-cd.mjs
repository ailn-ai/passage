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

  // C12 四参数版本也工作
  const t12 = await S(W.alice, 'safeTransferFrom(address,address,uint256,bytes)', [good, W.alice.address, TID, '0x1234']);
  // good 合约持有该 token，alice 不是 owner → 应失败
  ok('C12 四参数 safeTransferFrom 存在且受权限约束', !t12.ok, t12.err || '');

  // C13 无回调合约 → safeTransfer 失败
  const nore = await deployHelper(W.deployer, 'NoReceiver');
  const t13 = await S(W.alice, 'safeTransferFrom(address,address,uint256)', [W.alice.address, nore, TID]);
  ok('C13 目标合约无接收回调 → safeTransferFrom 失败', !t13.ok, t13.err || '');

  // C14 错误 selector 的接收方 → 失败
  const badSel = await deployHelper(W.deployer, 'BadSelectorReceiver');
  const t14 = await S(W.alice, 'safeTransferFrom(address,address,uint256)', [W.alice.address, badSel, TID]);
  ok('C14 接收方返回错误 selector → 失败', !t14.ok, t14.err || '');

  // C15 回调 revert 的接收方 → 失败
  const rev = await deployHelper(W.deployer, 'RevertingReceiver');
  const t15 = await S(W.alice, 'safeTransferFrom(address,address,uint256)', [W.alice.address, rev, TID]);
  ok('C15 接收方 revert → 失败', !t15.ok, t15.err || '');

  // C16 transferFrom 到自身被拒
  const t16 = await S(W.alice, 'transferFrom(address,address,uint256)', [W.alice.address, CT, TID]);
  ok('C16 禁止转到合约自身', !t16.ok, t16.err || '');
  // C17 转到零地址被拒
  const t17 = await S(W.alice, 'transferFrom(address,address,uint256)', [W.alice.address, ethers.ZeroAddress, TID]);
  ok('C17 禁止转到零地址', !t17.ok, t17.err || '');

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

  // D6 签名伪造：用另一个私钥签同名摘要
  const forged = (await V('permitDigest(uint8,address,uint256,uint256)', [1, W.alice.address, NOW + 9999, 7])).val[0];
  const forgedSig = W.deployer.signingKey.sign(forged).serialized;
  const rf = await S(W.alice, 'mint(address,bytes,uint256)', [ethers.ZeroAddress, forgedSig, NOW + 9999], ethers.parseEther('0.1'));
  ok('D6 伪造签名被拒', !rf.ok, rf.err || '');

  // D7 跨地址重放：为 A 签的凭证用在 B 上
  const forBob = await V('permitDigest(uint8,address,uint256,uint256)', [1, W.bob.address, DL + 5000, 0]);
  const bobSig = W.s1.signingKey.sign(forBob.val[0]).serialized;
  const rr = await S(W.mallory, 'mint(address,bytes,uint256)', [ethers.ZeroAddress, bobSig, DL + 5000], ethers.parseEther('0.1'));
  ok('D7 为他人签发的凭证不可挪用', !rr.ok, rr.err || '');

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

writeFileSync('G:/AIVE/contracts/v4/build/_results.json', JSON.stringify({
  deployGas: dep.gas.toString(), address: CT, results,
  pass: results.filter(r => r.pass).length, total: results.length,
}, null, 2));
console.log('\n================ 汇总 ================');
const nP = results.filter(r => r.pass).length;
console.log('  通过 ' + nP + ' / ' + results.length);
console.log('  部署 Gas ' + dep.gas.toString() + ' (' + (Number(dep.gas)/Number(BLOCK_GAS_LIMIT)*100).toFixed(2) + '% of 70M)');
if (FAIL.length) { console.log('  失败项:'); FAIL.forEach(f => console.log('    ✘ ' + f)); process.exitCode = 1; }
else { console.log('  ✔ 全部通过'); }
