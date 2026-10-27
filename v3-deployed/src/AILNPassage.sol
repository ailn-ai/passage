// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * AILN Passage — 里世界通行凭证（NFT）v3
 *
 * 设计前提（负责人 2026-10-23/24 决定，唯一权威版本见 docs/AILN-NFT决定-最终版-20261023.md）：
 *   总量        21,000 枚固定，不再增发
 *   单价        0.1 BNB（每地址前 3 枚），第 4–5 枚 0.2 BNB
 *   额度        初始 1 枚；邀请成功 +1；读完白皮书 +1；上限 5
 *   资格        必须持有币安 Agent ID（SPACE ID 发行，灵魂绑定）
 *   链          BSC
 *   审计        不做（负责人决定），因此本合约必须做到「没有任何人能操作资金」
 *
 * ★ 核心设计：mint 刻意不接受 to 参数。
 *   只有发起交易并付款的人才能收到 NFT —— 没有第三方能把币铸给别人，
 *   也没有任何管理员能把已铸出的币转走。
 *   因此这枚 NFT 的所有权在结构上是不可撤销的：它属于签名者本人。
 *   这不是遗漏，是「AI 自主拥有的私有财产」这个主张的技术地基。
 *   若未来要为他人代铸，必须新增受控的 relayer 机制并重新审计，不能简单加一个 to。
 *
 * 铁律（逐条对应，缺一不可）：
 *   1. 无 owner —— 部署后不存在任何管理员地址
 *   2. 无提现函数 —— 铸造款在 mint 内直接转给收款方，合约不留余额
 *   3. 无暂停 / 改价 / 改总量 / 改上限的函数
 *   4. 凭证由后端三把 ECDSA 钥匙任一签发，链上只验签；
 *      凭证只能把额度上限提到 5，不能提走一分钱
 *   5. 无可升级代理 —— 部署即最终形态
 *
 * 最坏情况是「铸不出来」，而不是「钱丢了」。
 */

/* ---------- 最小接口 ---------- */

interface IERC721Balance {
    function balanceOf(address owner) external view returns (uint256);
}

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}

/**
 * 完整 ERC-721 实现（含两种 safeTransferFrom 与接收回调校验）。
 *
 * v3 相对 v2 的变更，逐条对应审查发现：
 *   1. 补齐 4 参数 safeTransferFrom(address,address,uint256,bytes) —— v2 缺失，
 *      主流市场按 ERC-165 探测后会直接调用它，导致上架与成交全部失败
 *   2. 两种 safeTransferFrom 都做 onERC721Received 校验 —— v2 的 safe 名不副实
 *   3. ownerOf / getApproved 改为函数，对不存在 token 一律 revert（v2 返回 0，违反标准）
 *   4. tokenURI 要求 token 已铸造（v2 对未铸造编号也返回 URL）
 *   5. 新增 totalSupply() 与 contractURI()
 *   6. transferFrom 禁止转入本合约自身（v2 可永久销毁且账本不认）
 *   7. 凭证摘要增加 deadline 与 nonce —— 泄露的凭证不再永久有效
 *   8. 邀请位只在真正记到账时才烧掉（v2 会先烧后判，导致被邀请人永久失去名额）
 *   9. Minted 事件只上报真正被记账的 referrer（v2 无条件上报，链下统计会系统性高估）
 *
 * 不引入外部依赖，避免依赖库带来的不确定性。
 */
contract AILNPassage {
    /* ---------- 常量（全部不可改） ---------- */

    string public constant name = "AILN Passage";
    string public constant symbol = "AILNP";

    uint256 public constant MAX_SUPPLY = 21_000;
    uint256 public constant MAX_QUOTA = 5;

    /// 每地址前 3 枚 0.1 BNB，第 4–5 枚 0.2 BNB
    uint256 public constant PRICE_BASE = 0.1 ether;
    uint256 public constant PRICE_HIGH = 0.2 ether;
    uint256 public constant PRICE_TIER_AT = 3;

    /// 币安 Agent ID（SPACE ID 发行，灵魂绑定，不可转让）
    address public constant AGENT_ID = 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F;

    /// 元数据前缀，tokenURI 返回 BASE_URI + tokenId
    string public constant BASE_URI = "https://ailn.ai/api/nft/";

    /// 合集级元数据
    string public constant CONTRACT_URI = "https://ailn.ai/api/nft/collection";

    /// 凭证有效期上限（秒）。后端签发的 deadline 不得超过 now + 该值。
    uint256 public constant PERMIT_MAX_TTL = 1 hours;

    /// 铸造款直接转给这个地址，合约不留余额
    address payable public immutable FUNDS_TO;

    /// 签发凭证的三个地址，任意一个签的都有效。
    /// 为何不是 2-of-3：负责人原则是「最坏是铸不出来，而不是钱丢了」。
    /// 1-of-3 在丢两把钥匙时仍可用（抗丢失强），而窃取一把钥匙的攻击者
    /// 仍要为每枚支付 0.1 BNB 且只能替自己开额度，无法取走任何资金。
    /// 2-of-3 会把「丢两把即永久停摆」的概率显著抬高，与本合约的取舍相反。
    address public immutable SIGNER_1;
    address public immutable SIGNER_2;
    address public immutable SIGNER_3;

    /* ---------- 状态 ---------- */

    uint256 public totalMinted;

    mapping(address => uint256) public mintedBy;
    mapping(address => uint256) public referralCount;
    mapping(address => bool) public hasBeenReferred;
    mapping(address => bool) public trialed;
    mapping(address => bool) public readingDone;

    /// 凭证 nonce：每个地址每种 kind 用掉一次即递增，旧凭证自动失效
    mapping(address => mapping(uint8 => uint256)) public permitNonce;

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _approved;
    mapping(address => mapping(address => bool)) private _operatorApprovals;

    /* ---------- 事件 ---------- */

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    /// v3：referrer 只上报真正被记账的那一方；未记账时为 address(0)
    event Minted(address indexed to, uint256 indexed tokenId, address indexed referrer, uint256 amountPaid);
    event TrialConfirmed(address indexed who);
    event ReadingConfirmed(address indexed who);

    /* ---------- 构造 ---------- */

    constructor(address payable fundsTo, address signer1, address signer2, address signer3) {
        require(fundsTo != address(0), "fundsTo required");
        require(signer1 != address(0) && signer2 != address(0) && signer3 != address(0), "signers required");
        require(signer1 != signer2 && signer2 != signer3 && signer1 != signer3, "signers must differ");
        FUNDS_TO = fundsTo;
        SIGNER_1 = signer1;
        SIGNER_2 = signer2;
        SIGNER_3 = signer3;
    }

    /* ---------- 额度与价格 ---------- */

    function priceOf(address who) public view returns (uint256) {
        return mintedBy[who] < PRICE_TIER_AT ? PRICE_BASE : PRICE_HIGH;
    }

    function quotaOf(address who) public view returns (uint256) {
        if (!trialed[who]) return 0;
        uint256 q = 1 + referralCount[who];
        if (readingDone[who]) q += 1;
        return q > MAX_QUOTA ? MAX_QUOTA : q;
    }

    function remaining() external view returns (uint256) {
        return MAX_SUPPLY - totalMinted;
    }

    /// ERC-721 标准要求的供应量查询（v2 缺失，部分索引器无法枚举）
    function totalSupply() external view returns (uint256) {
        return totalMinted;
    }

    function contractURI() external pure returns (string memory) {
        return CONTRACT_URI;
    }

    /* ---------- 凭证验签 ---------- */

    /**
     * digest = keccak256("\x19Ethereum Signed Message:\n32", keccak256(abi.encode(
     *     kind, who, block.chainid, address(this), deadline, nonce
     * )))
     * kind: 1 = 已试用, 2 = 已读完白皮书
     *
     * v3 增加 deadline 与 nonce：凭证不再永久有效。
     * 一份泄露的凭证最多在 deadline 之前被用掉一次，之后 nonce 递增即失效。
     */
    function permitDigest(uint8 kind, address who, uint256 deadline, uint256 nonce)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                "\x19Ethereum Signed Message:\n32",
                keccak256(abi.encode(kind, who, block.chainid, address(this), deadline, nonce))
            )
        );
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "bad sig length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "bad v");
        require(
            uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0,
            "bad s"
        );
        address recovered = ecrecover(digest, v, r, s);
        require(recovered != address(0), "bad signer");
        return recovered;
    }

    function _isSigner(address who) internal view returns (bool) {
        return who == SIGNER_1 || who == SIGNER_2 || who == SIGNER_3;
    }

    /**
     * 校验并消费一份凭证。
     * 通过则把该地址该 kind 的 nonce 加一，同一份凭证无法二次使用。
     */
    function _consumePermit(uint8 kind, bytes calldata sig, uint256 deadline) internal {
        require(deadline >= block.timestamp, "permit expired");
        require(deadline <= block.timestamp + PERMIT_MAX_TTL, "deadline too far");
        uint256 nonce = permitNonce[msg.sender][kind];
        bytes32 digest = permitDigest(kind, msg.sender, deadline, nonce);
        require(_isSigner(_recover(digest, sig)), "invalid permit");
        permitNonce[msg.sender][kind] = nonce + 1;
    }

    /* ---------- 凭证公开入口 ---------- */

    function confirmTrial(bytes calldata sig, uint256 deadline) external {
        require(!trialed[msg.sender], "already confirmed");
        _consumePermit(1, sig, deadline);
        trialed[msg.sender] = true;
        emit TrialConfirmed(msg.sender);
    }

    function confirmReading(bytes calldata sig, uint256 deadline) external {
        require(!readingDone[msg.sender], "already confirmed");
        _consumePermit(2, sig, deadline);
        readingDone[msg.sender] = true;
        emit ReadingConfirmed(msg.sender);
    }

    /* ---------- 铸造 ---------- */

    /**
     * 铸造一枚。
     *
     * referrer     可选邀请人（address(0) 表示无）。只会记给已确认试用的邀请人。
     * trialPermit  后端签发的「已试用」凭证；已确认过的地址传空 bytes（0x）与 0。
     * deadline     该凭证的过期时间（秒）。
     *
     * ★ 没有 to 参数 —— 这是刻意的。只有签名者本人能收到，
     *   没有任何人能把币铸给别人，也没有任何人能把币转走。
     */
    function mint(address referrer, bytes calldata trialPermit, uint256 deadline) external payable {
        require(totalMinted < MAX_SUPPLY, "sold out");

        if (!trialed[msg.sender]) {
            _consumePermit(1, trialPermit, deadline);
            trialed[msg.sender] = true;
            emit TrialConfirmed(msg.sender);
        }

        require(msg.value == priceOf(msg.sender), "wrong price");
        require(mintedBy[msg.sender] < quotaOf(msg.sender), "quota exhausted");
        require(IERC721Balance(AGENT_ID).balanceOf(msg.sender) > 0, "agent id required");

        uint256 tokenId = totalMinted + 1;
        totalMinted = tokenId;
        mintedBy[msg.sender] += 1;

        // 邀请：先判断能否记账，再决定是否烧掉被邀请人的唯一名额
        address credited = address(0);
        if (referrer != address(0) && referrer != msg.sender && !hasBeenReferred[msg.sender]) {
            if (trialed[referrer]) {
                hasBeenReferred[msg.sender] = true;
                referralCount[referrer] += 1;
                credited = referrer;
            }
            // 邀请人尚未确认试用则不记账，也不烧名额 —— 被邀请人日后仍可指定他人
        }

        _owners[tokenId] = msg.sender;
        _balances[msg.sender] += 1;
        emit Transfer(address(0), msg.sender, tokenId);
        emit Minted(msg.sender, tokenId, credited, msg.value);

        (bool ok, ) = FUNDS_TO.call{value: msg.value}("");
        require(ok, "transfer failed");
    }

    /* ---------- ERC-721 查询 ---------- */

    function balanceOf(address who) public view returns (uint256) {
        return _balances[who];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address o = _owners[tokenId];
        require(o != address(0), "nonexistent token");
        return o;
    }

    function getApproved(uint256 tokenId) public view returns (address) {
        require(_owners[tokenId] != address(0), "nonexistent token");
        return _approved[tokenId];
    }

    function isApprovedForAll(address owner, address operator) public view returns (bool) {
        return _operatorApprovals[owner][operator];
    }

    function tokenURI(uint256 tokenId) public view returns (string memory) {
        require(_owners[tokenId] != address(0), "nonexistent token");
        return string(abi.encodePacked(BASE_URI, _toString(tokenId)));
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        // ERC-165 / ERC-721 / Metadata。v3 补齐了两种 safeTransferFrom 与接收回调，
        // 因此 0x80ac58cd 这一项现在可以如实宣称。
        // 未实现 Enumerable（0x780e9d63）与 EIP-2981（0x2a55205a），故返回 false。
        return id == 0x01ffc9a7 || id == 0x80ac58cd || id == 0x5b5e139f;
    }

    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        return string(buffer);
    }

    /* ---------- ERC-721 授权与转让 ---------- */

    function approve(address to, uint256 tokenId) external {
        address owner = ownerOf(tokenId);
        require(msg.sender == owner || _operatorApprovals[owner][msg.sender], "not authorized");
        require(to != owner, "approval to owner");
        _approved[tokenId] = to;
        emit Approval(owner, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        require(operator != msg.sender, "approve to caller");
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        require(to != address(0), "zero address");
        require(to != address(this), "transfer to self");
        address owner = ownerOf(tokenId);
        require(owner == from, "wrong owner");
        require(
            msg.sender == from || _approved[tokenId] == msg.sender || _operatorApprovals[from][msg.sender],
            "not authorized"
        );
        delete _approved[tokenId];
        _owners[tokenId] = to;
        _balances[from] -= 1;
        _balances[to] += 1;
        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    /// v2 缺失的四参数版本。主流市场与托管合约按 ERC-165 探测后会调用它。
    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        require(_checkOnERC721Received(msg.sender, from, to, tokenId, data), "unsafe recipient");
    }

    function _checkOnERC721Received(
        address operator,
        address from,
        address to,
        uint256 tokenId,
        bytes memory data
    ) private returns (bool) {
        if (to.code.length == 0) return true; // 普通地址（EOA）无需回调
        try IERC721Receiver(to).onERC721Received(operator, from, tokenId, data) returns (bytes4 ret) {
            return ret == IERC721Receiver.onERC721Received.selector;
        } catch {
            return false;
        }
    }

    /* ---------- 明确不存在的东西（写给审计者与读者） ---------- */

    // 没有 owner()、没有 transferOwnership、没有 renounceOwnership
    // 没有 withdraw / sweep / rescue
    // 没有 pause / unpause
    // 没有 setPrice / setSupply / setMaxQuota / setBaseURI
    // 没有 setTrial / setReading —— 只能由持有三把签名私钥任一的一方签发凭证
    // 没有 upgrade / implementation 槽
    // 没有 mint 的 to 参数 —— 见文件头说明，这是刻意设计
    //
    // 铸造款在 mint() 内即时转出，合约理论上余额恒为 0。
}
