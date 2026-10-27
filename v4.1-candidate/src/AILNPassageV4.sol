// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * AILN Passage — 里世界通行凭证（NFT）v4.1
 *
 * v4 相对 v3 的唯一功能改动：**创世预留**。
 *   部署时直接把 1,050 枚（5%）铸给项目预留钱包，不收费、不要求 Agent ID、
 *   不占用公开配额。其余行为与 v3 保持一致。
 *
 * ★ v4.1 修复（2026-10-26）：原实现逐枚写 _owners，导致部署 Gas 27,460,984，
 *   超过 BSC 单笔交易上限 16,777,216（BEP-652 / EIP-7825，Status: Enabled），
 *   主网会在 txpool 阶段拒绝。现已改为「预留所有权按需推导」：
 *   id <= RESERVE_SUPPLY 且 _owners[id] == 0 时，ownerOf 返回 RESERVE_TO。
 *   部署时不再做逐枚 SSTORE，只发 Transfer 事件。语义与普通 ERC-721 完全一致：
 *   一旦某枚被转出，_owners[id] 被写入，推导自动失效。
 *
 * 总量        21,000 枚固定，不再增发
 *   预留      1,050（5%）—— 部署时一次性铸出，tokenId 1..1050
 *   公开      19,950（95%）—— tokenId 1051..21000
 *
 * 公开铸造   0.1 BNB（每地址前 3 枚），第 4–5 枚 0.2 BNB
 * 额度       初始 1 枚；邀请成功 +1；读完白皮书 +1；上限 5（沿用 v3）
 * 资格       必须持有币安 Agent ID（SPACE ID 发行，灵魂绑定）
 * 链         BSC
 * 版税       0%（不实现 EIP-2981，不做交易税；市场手续费不属于本合约）
 *
 * ★ 转让不设任何身份限制 —— Agent ID 只在「公开铸造」时检查一次。
 *   次级市场里普通钱包可以自由买卖。这是刻意的：本合约不做市场，
 *   也不应把某个市场的地址写进来。换市场不需要重新发币。
 *
 * ★ mint 依旧不接受 to 参数（沿用 v3 的核心设计）。
 *   只有发起交易并付款的人才能收到 NFT —— 没有第三方能替别人铸，
 *   也没有任何管理员能把已铸出的币转走。
 *
 * 铁律（逐条对应，缺一不可）：
 *   1. 无 owner —— 部署后不存在任何管理员地址
 *   2. 无提现函数 —— 铸造款在 mint 内直接转给收款方，合约不留余额
 *   3. 无暂停 / 改价 / 改总量 / 改额度 / 改预留量的函数
 *   4. 预留量是常量，且只能在构造函数里铸一次，之后无法增加
 *   5. 凭证由后端三把 ECDSA 钥匙任一签发，链上只验签
 *   6. 无可升级代理 —— 部署即最终形态
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
 * 完整 ERC-721 实现（含两种 safeTransferFrom 与接收回调校验），无外部依赖。
 */
contract AILNPassageV4 {
    /* ---------- 常量（全部不可改） ---------- */

    string public constant name = "AILN Passage";
    string public constant symbol = "AILNP";

    /// 总上限。预留 + 公开 = 21,000
    uint256 public constant MAX_SUPPLY = 21_000;

    /// 项目创世预留量（5%）。部署时一次性铸出，之后无法增加。
    uint256 public constant RESERVE_SUPPLY = 1_050;

    /// 公开可铸造量（95%）
    uint256 public constant PUBLIC_SUPPLY = 19_950;

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

    /// 创世预留的接收地址。部署后不可更改，且与 FUNDS_TO 必须是不同地址。
    address public immutable RESERVE_TO;

    /// 签发凭证的三个地址，任意一个签的都有效。
    address public immutable SIGNER_1;
    address public immutable SIGNER_2;
    address public immutable SIGNER_3;

    /* ---------- 状态 ---------- */

    /// 已存在的 NFT 总数 = RESERVE_SUPPLY + publicMinted
    uint256 public totalMinted;

    /// 通过公开铸造产生的数量。部署时为 0。
    /// ★ 官网若要显示「已售出 / 已参与人数」，请看 publicMinted，不要看 totalMinted。
    uint256 public publicMinted;

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

    /// 只由公开铸造触发。预留铸造不发此事件 —— 否则链下统计会把它算成「有人付费购买」。
    event Minted(address indexed to, uint256 indexed tokenId, address indexed referrer, uint256 amountPaid);

    /// 创世预留专用事件，整个部署期间只发一次。
    event ReserveMinted(address indexed to, uint256 fromTokenId, uint256 count);

    event TrialConfirmed(address indexed who);
    event ReadingConfirmed(address indexed who);

    /* ---------- 构造 ---------- */

    /**
     * @param fundsTo 铸造款接收地址（必须是能实际控制的独立地址）
     * @param reserveTo 创世预留接收地址（必须是负责人能实际控制和转出的独立地址，
     *                  不得使用 fundsTo，也不得使用交易所托管地址）
     * @param signer1..3 凭证签发地址，任意一个签的都有效
     */
    constructor(
        address payable fundsTo,
        address reserveTo,
        address signer1,
        address signer2,
        address signer3
    ) {
        require(fundsTo != address(0), "fundsTo required");
        require(reserveTo != address(0), "reserveTo required");
        require(reserveTo != fundsTo, "reserve must differ from fundsTo");
        require(reserveTo != address(this), "reserve cannot be self");
        require(signer1 != address(0) && signer2 != address(0) && signer3 != address(0), "signers required");
        require(signer1 != signer2 && signer2 != signer3 && signer1 != signer3, "signers must differ");
        require(signer1 != reserveTo && signer2 != reserveTo && signer3 != reserveTo, "reserve cannot be signer");

        FUNDS_TO = fundsTo;
        RESERVE_TO = reserveTo;
        SIGNER_1 = signer1;
        SIGNER_2 = signer2;
        SIGNER_3 = signer3;

        // ---- 创世预留：一次性铸出 1,050 枚，tokenId 1..1050 ----
        //
        // ★ 关键：这里【不】逐枚写 _owners[tokenId]。
        //   1,050 次冷 SSTORE 约 23.2M gas，会让部署交易超过 BSC 单笔上限
        //   （BEP-652: 16,777,216），在 txpool 阶段就被拒绝。
        //
        //   改为「按需推导」：ownerOf 对 id <= RESERVE_SUPPLY 且 _owners[id]==0
        //   的 token 返回 RESERVE_TO。某枚被转出后 _owners[id] 被写入，推导失效。
        //   因此链上状态与普通 ERC-721 完全等价，只是把 1,050 个槽位延迟到
        //   「真正被转出时」才写入。
        //
        //   Transfer 事件必须发 —— 索引器与市场靠它发现这些 token 的存在。
        //   事件只消耗 log gas（约 1,500/枚），不写存储。
        //   依旧不发 Minted（该事件带 amountPaid，会被统计成付费购买）。
        for (uint256 tokenId = 1; tokenId <= RESERVE_SUPPLY; ++tokenId) {
            emit Transfer(address(0), reserveTo, tokenId);
        }
        // 余额一次写入，等价于持有 1,050 枚
        _balances[reserveTo] = RESERVE_SUPPLY;
        totalMinted = RESERVE_SUPPLY;

        emit ReserveMinted(reserveTo, 1, RESERVE_SUPPLY);
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

    /// 公开侧还可铸造的数量。官网应使用此值，而不是 MAX_SUPPLY - totalMinted。
    function publicRemaining() public view returns (uint256) {
        return PUBLIC_SUPPLY - publicMinted;
    }

    /// 兼容 v3 的语义：仍返回「还能再铸多少」。因预留已在部署时铸出，
    /// 此值恒等于 publicRemaining()。
    function remaining() external view returns (uint256) {
        return MAX_SUPPLY - totalMinted;
    }

    /// ERC-721 标准要求的供应量查询。注意：部署后即为 1,050（含预留）。
    function totalSupply() external view returns (uint256) {
        return totalMinted;
    }

    /// 创世预留的接收地址（便于链下核对，无需读 immutable 变量名）
    function reserveOwner() external view returns (address) {
        return RESERVE_TO;
    }

    function contractURI() external pure returns (string memory) {
        return CONTRACT_URI;
    }

    /* ---------- 凭证验签 ---------- */

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

    /* ---------- 公开铸造 ---------- */

    /**
     * 公开铸造一枚。签名与 v3 完全一致，后端无需改动。
     *
     * referrer     可选邀请人（address(0) 表示无）。只会记给已确认试用的邀请人。
     * trialPermit  后端签发的「已试用」凭证；已确认过的地址传空 bytes（0x）与 0。
     * deadline     该凭证的过期时间（秒）。
     *
     * ★ 没有 to 参数 —— 这是刻意的。
     * ★ Agent ID 只在这里检查一次。转让函数不检查身份。
     */
    function mint(address referrer, bytes calldata trialPermit, uint256 deadline) external payable {
        require(publicMinted < PUBLIC_SUPPLY, "sold out");

        if (!trialed[msg.sender]) {
            _consumePermit(1, trialPermit, deadline);
            trialed[msg.sender] = true;
            emit TrialConfirmed(msg.sender);
        }

        require(msg.value == priceOf(msg.sender), "wrong price");
        require(mintedBy[msg.sender] < quotaOf(msg.sender), "quota exhausted");
        require(IERC721Balance(AGENT_ID).balanceOf(msg.sender) > 0, "agent id required");

        publicMinted += 1;
        uint256 tokenId = RESERVE_SUPPLY + publicMinted;
        totalMinted = tokenId;
        mintedBy[msg.sender] += 1;

        address credited = address(0);
        if (referrer != address(0) && referrer != msg.sender && !hasBeenReferred[msg.sender]) {
            if (trialed[referrer]) {
                hasBeenReferred[msg.sender] = true;
                referralCount[referrer] += 1;
                credited = referrer;
            }
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

    /**
     * 返回 token 的持有人。
     *
     * 预留 token（1..RESERVE_SUPPLY）在未被转出前不占用 _owners 存储槽，
     * 此处按 tokenId 区间推导为 RESERVE_TO。一旦某枚被转出，_owners[id] 被
     * 写入，推导自动失效，行为与普通 ERC-721 完全一致。
     *
     * tokenId 0 与超过 RESERVE_SUPPLY 的未铸造 id 一律 revert。
     */
    function ownerOf(uint256 tokenId) public view returns (address) {
        address o = _owners[tokenId];
        if (o != address(0)) return o;
        if (tokenId != 0 && tokenId <= RESERVE_SUPPLY) return RESERVE_TO;
        revert("nonexistent token");
    }

    function getApproved(uint256 tokenId) public view returns (address) {
        ownerOf(tokenId); // 不存在则此处 revert
        return _approved[tokenId];
    }

    function isApprovedForAll(address owner, address operator) public view returns (bool) {
        return _operatorApprovals[owner][operator];
    }

    function tokenURI(uint256 tokenId) public view returns (string memory) {
        ownerOf(tokenId); // 不存在则此处 revert
        return string(abi.encodePacked(BASE_URI, _toString(tokenId)));
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        // ERC-165 / ERC-721 / Metadata。
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

    /**
     * ★ 转让不检查 Agent ID、不检查配额、不依赖任何外部合约。
     *   普通钱包可以自由买卖、可以授权市场合约托管。
     */
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
        if (to.code.length == 0) return true;
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
    // 没有 setPrice / setSupply / setMaxQuota / setBaseURI / setReserve
    // 没有额外预留铸造入口 —— 预留只能在构造函数里铸一次
    // 没有 setTrial / setReading
    // 没有 upgrade / implementation 槽
    // 没有 mint 的 to 参数
    // 没有 EIP-2981 / 交易税 / 版税
    // 没有写死任何市场地址
    //
    // 铸造款在 mint() 内即时转出，合约理论上余额恒为 0。
    //
    // v4.1：预留 token 的所有权是「推导」的，不是「存储」的。
    //   _owners[id] == 0 && id <= RESERVE_SUPPLY  → 归 RESERVE_TO
    //   任何写操作（transferFrom）都会把 _owners[id] 落地，之后走普通路径。
}
