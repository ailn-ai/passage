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
