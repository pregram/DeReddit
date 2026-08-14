// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./DeRedditTypes.sol";

interface IDeRedditCore {
    /// @notice Returns a post's author and type, so Escrow can verify the caller owns a Crowdfund post before launching a campaign.
    function getPostMeta(uint256 postId) external view returns (address author, PostType postType);
}

contract DeRedditEscrow {

    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED     = 2;
    uint256 private _status;

    /// @dev Standard reentrancy guard; blocks re-entry into any function that carries this modifier.
    modifier nonReentrant() {
        if (_status == _ENTERED) revert Reentrancy();
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }

    // creator == address(0) doubles as "campaign not launched"; contribute/claimPayout/claimRefund all
    // check it as their PostNotFound guard since only launchCrowdfund ever populates this struct.
    // launchCrowdfund itself checks deadline != 0 to detect a prior launch (see CrowdfundAlreadyLaunched).
    struct Crowdfund {
        address creator;
        uint32  deadline;
        bool    claimed;
        uint256 targetGoal;
        uint256 fundsRaised;
    }

    /// @notice The DeRedditCore instance used to verify a post's author and type before launching a campaign.
    IDeRedditCore public immutable core;

    /// @notice postId => that post's crowdfund campaign state.
    mapping(uint256 => Crowdfund)                        public crowdfunds;
    /// @notice postId => backer wallet => amount that backer has contributed, used to compute refunds.
    mapping(uint256 => mapping(address => uint256))      public contributions;

    /// @notice Emitted when a crowdfund campaign is launched for a post.
    event CrowdfundLaunched(uint256 indexed postId, uint256 goal, uint32 deadline);
    /// @notice Emitted when a backer contributes to a crowdfund campaign.
    event CrowdfundContribution(uint256 indexed postId, address indexed backer, uint256 amount, uint256 total);
    /// @notice Emitted when a campaign creator claims the payout after reaching the goal.
    event CrowdfundPayout(uint256 indexed postId, address indexed creator, uint256 amount);
    /// @notice Emitted when a backer claims a refund from a campaign that missed its goal.
    event CrowdfundRefund(uint256 indexed postId, address indexed backer, uint256 amount);

    /// @notice Deploys DeRedditEscrow bound to a DeRedditCore instance for post author/type lookups.
    /// @param _core Address of the DeRedditCore contract.
    constructor(address _core) {
        if (_core == address(0)) revert ZeroAddress();
        core    = IDeRedditCore(_core);
        _status = _NOT_ENTERED;
    }

    /**
     * @notice Launches a crowdfund campaign for a Crowdfund post; step 2 following DeRedditCore.createPost, callable once by the post's author.
     * @param _postId ID of a post created with PostType.Crowdfund.
     * @param _targetGoal Funding target in wei; campaign succeeds if fundsRaised reaches this by the deadline.
     * @param _duration Seconds from now until the campaign deadline.
     */
    function launchCrowdfund(uint256 _postId, uint256 _targetGoal, uint32 _duration) external {
        if (_targetGoal == 0) revert InvalidGoal();
        if (_duration   == 0) revert InvalidDuration();

        (address postAuthor, PostType postType) = core.getPostMeta(_postId);
        if (postType != PostType.Crowdfund) revert NotCrowdfund();
        if (postAuthor != msg.sender)       revert Unauthorized();

        if (crowdfunds[_postId].deadline != 0) revert CrowdfundAlreadyLaunched();

        Crowdfund storage cf = crowdfunds[_postId];
        cf.creator    = msg.sender;
        cf.targetGoal = _targetGoal;
        cf.deadline   = uint32(block.timestamp) + _duration;

        emit CrowdfundLaunched(_postId, _targetGoal, cf.deadline);
    }

    /// @notice Contributes ETH to a launched crowdfund campaign before its deadline.
    /// @param _postId Post whose campaign is being funded.
    function contribute(uint256 _postId) external payable nonReentrant {
        if (msg.value == 0) revert InvalidAmount();

        Crowdfund storage cf = crowdfunds[_postId];
        if (cf.creator == address(0))       revert PostNotFound(); // not-yet-launched sentinel, see Crowdfund struct comment
        if (block.timestamp >= cf.deadline) revert CampaignEnded();

        unchecked {
            // Overflow not reachable: total contributions are bounded by ETH's finite supply, far below uint256 max.
            cf.fundsRaised                     += msg.value;
            contributions[_postId][msg.sender] += msg.value;
        }

        emit CrowdfundContribution(_postId, msg.sender, msg.value, cf.fundsRaised);
    }

    /// @notice Claims the raised funds after a campaign's deadline passes with its goal met; creator-only, one-time.
    /// @param _postId Post whose campaign payout is being claimed.
    function claimPayout(uint256 _postId) external nonReentrant {
        Crowdfund storage cf = crowdfunds[_postId];
        if (cf.creator == address(0))          revert PostNotFound();
        if (msg.sender != cf.creator)          revert NotCampaignCreator();
        if (block.timestamp < cf.deadline)     revert CampaignStillActive();
        if (cf.claimed)                        revert AlreadyClaimed();
        if (cf.fundsRaised < cf.targetGoal)    revert GoalNotReached();

        cf.claimed = true;
        uint256 payout = cf.fundsRaised;

        (bool ok, ) = payable(cf.creator).call{value: payout}("");
        if (!ok) revert TransferFailed();

        emit CrowdfundPayout(_postId, cf.creator, payout);
    }

    /// @notice Claims back a contribution after a campaign's deadline passes with its goal unmet.
    /// @param _postId Post whose campaign the caller contributed to.
    function claimRefund(uint256 _postId) external nonReentrant {
        Crowdfund storage cf = crowdfunds[_postId];
        if (cf.creator == address(0))        revert PostNotFound();
        if (block.timestamp < cf.deadline)   revert CampaignStillActive();
        if (cf.fundsRaised >= cf.targetGoal) revert GoalAlreadyReached();

        uint256 refund = contributions[_postId][msg.sender];
        if (refund == 0) revert NothingToRefund();

        contributions[_postId][msg.sender] = 0;

        (bool ok, ) = payable(msg.sender).call{value: refund}("");
        if (!ok) revert TransferFailed();

        emit CrowdfundRefund(_postId, msg.sender, refund);
    }

    /// @notice Returns a crowdfund campaign's on-chain state.
    /// @param _postId Post whose campaign to fetch.
    /// @return cf The campaign's stored data; zero-valued if no campaign was launched for this post.
    function getCampaign(uint256 _postId) external view returns (Crowdfund memory cf) {
        cf = crowdfunds[_postId];
    }
}