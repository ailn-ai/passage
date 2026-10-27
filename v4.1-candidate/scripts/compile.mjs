// 编译 AILNPassageV4.sol
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire('G:/AIVE/ppt/_cfdeploy/solc/package.json');
const solc = require('solc');

const SRC = 'G:/AIVE/contracts/v4/AILNPassageV4.sol';
const OUT = 'G:/AIVE/contracts/v4/build';
mkdirSync(OUT, { recursive: true });

const source = readFileSync(SRC, 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'AILNPassageV4.sol': { content: source } },
  settings: {
    evmVersion: 'shanghai',
    optimizer: { enabled: true, runs: 200 },
    outputSelection: {
      '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata', 'evm.methodIdentifiers'] },
    },
  },
};

console.log('编译器版本:', solc.version());
const out = JSON.parse(solc.compile(JSON.stringify(input)));

const errors = (out.errors || []).filter(e => e.severity === 'error');
const warnings = (out.errors || []).filter(e => e.severity === 'warning');

console.log('');
console.log('=== 编译诊断 ===');
console.log('  错误:', errors.length);
console.log('  警告:', warnings.length);
for (const w of warnings) console.log('  [warn] ' + w.formattedMessage.split('\n')[0]);
if (errors.length) {
  for (const e of errors) console.log('  [ERROR] ' + e.formattedMessage);
  process.exit(1);
}

const c = out.contracts['AILNPassageV4.sol']['AILNPassageV4'];
writeFileSync(OUT + '/AILNPassageV4.abi.json', JSON.stringify(c.abi, null, 2));
writeFileSync(OUT + '/AILNPassageV4.bin', c.evm.bytecode.object);
writeFileSync(OUT + '/AILNPassageV4.deployed.bin', c.evm.deployedBytecode.object);
writeFileSync(OUT + '/AILNPassageV4.methods.json', JSON.stringify(c.evm.methodIdentifiers, null, 2));

const runtimeBytes = c.evm.deployedBytecode.object.length / 2;
const creationBytes = c.evm.bytecode.object.length / 2;

console.log('');
console.log('=== 产物 ===');
console.log('  creation 字节码   ' + creationBytes + ' 字节');
console.log('  runtime  字节码   ' + runtimeBytes + ' 字节');
console.log('  ABI 函数数        ' + c.abi.filter(x => x.type === 'function').length);
console.log('  ABI 事件数        ' + c.abi.filter(x => x.type === 'event').length);
console.log('  代码存储 Gas      ' + (runtimeBytes * 200) + ' (200 gas/byte)');

// 关键接口清单
console.log('');
console.log('=== 选择器 ===');
const want = [
  'mint(address,bytes,uint256)', 'confirmTrial(bytes,uint256)', 'confirmReading(bytes,uint256)',
  'MAX_SUPPLY()', 'RESERVE_SUPPLY()', 'PUBLIC_SUPPLY()', 'totalMinted()', 'publicMinted()',
  'publicRemaining()', 'remaining()', 'totalSupply()', 'reserveOwner()',
  'ownerOf(uint256)', 'balanceOf(address)', 'tokenURI(uint256)',
  'approve(address,uint256)', 'setApprovalForAll(address,bool)', 'getApproved(uint256)',
  'isApprovedForAll(address,address)', 'transferFrom(address,address,uint256)',
  'safeTransferFrom(address,address,uint256)', 'safeTransferFrom(address,address,uint256,bytes)',
  'supportsInterface(bytes4)', 'priceOf(address)', 'quotaOf(address)',
];
for (const w of want) {
  const s = c.evm.methodIdentifiers[w];
  console.log('  ' + (s ? s : '✘ 缺失!!').padEnd(10) + ' ' + w);
}
