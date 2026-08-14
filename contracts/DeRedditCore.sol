// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./DeRedditTypes.sol";

contract DeRedditCore {

    // MAX_FLAG_WEIGHT documents the ceiling that _calculateFlagImpact's weight ladder returns;
    // the ladder hardcodes 1-5 rather than referencing this constant, so update both if it ever changes.
    uint8  private constant MAX_FLAG_WEIGHT    = 5;
    uint8  private constant MAX_COMMENT_DEPTH  = 3;
    uint8  private constant MAX_POLL_OPTIONS   = 100;

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

    struct Forum {
        uint64 minKarmaToFlag;
        bool initialized;       // zero-init default (false) is what makes ForumNotFound work for never-created forums
    }

    struct UserProfile {
        uint64   karma;
        bytes32 username;
    }

    struct Post {
        address  author;
        PostType postType;
        uint32   visibleAfter;
        uint32   upvotes;
        uint32   downvotes;
        uint32   flagTally;
        uint8    pollOptionCount;  // 0 means a Poll post hasn't completed configurePoll yet (see PollNotConfigured)
        uint32   pollDeadline;
        bytes32  forumKey;
    }

    struct Comment {
        address author;
        uint8   tier;  // nesting depth, 1 (top-level) through MAX_COMMENT_DEPTH (3)
        uint32  upvotes;
        uint32  downvotes;
        uint32  flagTally;
        uint256 parentId;
        uint256 postId;
    }

    /// @notice Total posts ever created; also the source of the next auto-incremented post ID.
    uint256 public postCount;
    /// @notice Total comments ever created; also the source of the next auto-incremented comment ID.
    uint256 public commentCount;

    /// @notice Tracks which username hashes are already taken, enforcing global uniqueness across wallets.
    mapping(bytes32  => bool)        public usernameExists;
    /// @notice Each wallet's identity: chosen username and accumulated karma.
    mapping(address  => UserProfile) public users;
    /// @dev forumKey => stored forum data; read via getForumData, which reverts for never-created forums.
    mapping(bytes32  => Forum)       private _forums;
    /// @dev postId => stored post data; read via getPostData/getPostMeta, which enforce TimeCapsule locking.
    mapping(uint256  => Post)        private _posts;
    /// @dev commentId => stored comment data; read via getCommentData.
    mapping(uint256  => Comment)     private _comments;

    /// @notice forumKey => member wallet => is currently a member of that forum.
    mapping(bytes32 => mapping(address => bool)) public forumMembership;
    /// @notice postId => voter => that voter's current vote state (Magic Marker model: 1, -1, -2 swallowed, or 0); see _calculateVoteDelta.
    mapping(uint256 => mapping(address => int8)) public postVoteState;
    /// @notice commentId => voter => that voter's current vote state (Magic Marker model: 1, -1, -2 swallowed, or 0); see _calculateVoteDelta.
    mapping(uint256 => mapping(address => int8)) public commentVoteState;
    /// @notice postId => flagger wallet => whether that wallet has already flagged the post.
    mapping(uint256 => mapping(address => bool)) public postFlagState;
    /// @notice commentId => flagger wallet => whether that wallet has already flagged the comment.
    mapping(uint256 => mapping(address => bool)) public commentFlagState;

    /// @notice postId => poll option index => accumulated vote count for that option.
    mapping(uint256 => mapping(uint8 => uint32)) public pollOptionVotes;
    /// @notice postId => voter => the option index that voter last chose, so a repeat vote can move their prior tally.
    mapping(uint256 => mapping(address => uint8)) public userPollChoice;

    /// @notice Wallet address of the backend indexer's oracle signer; the only address allowed to anchor Merkle roots.
    address public immutable governanceOracle;
    /// @notice Block number => Merkle root of the off-chain database state anchored on-chain by the oracle for that block.
    mapping(uint256 => bytes32) public verifiedDatabaseRoots;

    /// @notice Emitted when a wallet registers a username.
    event UserRegistered(address indexed wallet, bytes32 indexed username, bytes32 profileCID);
    /// @notice Emitted when a wallet updates its profile IPFS pointer.
    event ProfileCIDUpdated(address indexed wallet, bytes32 profileCID);

    /// @notice Emitted when a new forum is created.
    event ForumCreated(bytes32 indexed forumKey, address indexed creator, uint64 minKarmaToFlag, bytes32 forumCID);
    /// @notice Emitted when a wallet joins a forum.
    event MemberJoined(bytes32 indexed forumKey, address indexed member);
    /// @notice Emitted when a wallet leaves a forum.
    event MemberLeft(bytes32 indexed forumKey, address indexed member);
    /// @notice Emitted when a post is created.
    /// @dev Poll/Crowdfund posts still need a follow-up configurePoll/launchCrowdfund call before they're complete.
    event PostCreated(
        uint256  indexed postId,
        address  indexed author,
        bytes32  indexed forumKey,
        PostType postType,
        uint32   visibleAfter,
        bytes32   ipfsCID
    );
    /// @notice Emitted when a Poll post completes its step-2 configuration.
    event PollConfigured(uint256 indexed postId, uint8 optionCount, uint32 deadline);
    /// @notice Emitted when a comment or reply is created.
    event CommentCreated(
        uint256 indexed commentId,
        uint256 indexed postId,
        uint256 indexed parentId,
        address  author,
        uint8    tier,
        bytes32   ipfsCID
    );
    /// @notice Emitted on a post vote.
    /// @dev voteDirection is -2 (swallowed downvote), -1, 0, or 1 - see _calculateVoteDelta.
    event PostVoted(uint256 indexed postId, address indexed voter, int8 voteDirection, uint64 authorKarma);
    /// @notice Emitted on a comment vote.
    /// @dev voteDirection is -2 (swallowed downvote), -1, 0, or 1 - see _calculateVoteDelta.
    event CommentVoted(uint256 indexed commentId, address indexed voter, int8 voteDirection, uint64 authorKarma);
    /// @notice Emitted when a post is flagged; totalFlags is a karma-weighted tally, not a raw flag count.
    event PostFlagged(uint256 indexed postId, address indexed flagger, uint32 totalFlags);
    /// @notice Emitted when a comment is flagged; totalFlags is a karma-weighted tally, not a raw flag count.
    event CommentFlagged(uint256 indexed postId, uint256 indexed commentId, address indexed flagger, uint32 totalFlags);
    /// @notice Emitted when ETH is sent to a post's author, or via tipDirect (postId 0).
    event TipPostSent(address indexed sender, address indexed recipient, uint256 indexed postId, uint256 amount);
    /// @notice Emitted when ETH is sent to a comment's author.
    event TipCommentSent(address indexed sender, address indexed recipient, uint256 indexed commentId, uint256 amount);
    /// @notice Emitted when a poll vote is cast or changed.
    event PollVoteCast(uint256 indexed postId, address indexed voter, uint8 optionId);
    /// @notice Emitted when the oracle anchors a block's Merkle root.
    event DatabaseRootAnchored(uint256 indexed blockNumber, bytes32 indexed merkleRoot);

    /// @notice Deploys DeRedditCore with the given wallet as the sole oracle allowed to anchor Merkle roots.
    /// @param _oracle Backend indexer's oracle signer address; cannot be the zero address.
    constructor(address _oracle) {
        if (_oracle == address(0)) revert ZeroAddress();
        governanceOracle = _oracle;
        _status          = _NOT_ENTERED;
    }

    /// @dev Restricts a function to the backend indexer's oracle wallet (governanceOracle).
    modifier onlyOracle() {
        if (msg.sender != governanceOracle) revert Unauthorized();
        _;
    }

    /**
     * @notice Registers a username for the caller; one identity per wallet, usernames cannot be changed once set.
     * @param _username Non-empty, unique username hash.
     * @param _profileCID IPFS CID digest of the profile JSON blob.
     */
    function registerIdentity(bytes32 _username, bytes32 _profileCID) external {
        if (users[msg.sender].username != bytes32(0)) revert AlreadyRegistered();
        if (_username == bytes32(0))                  revert InvalidUsername();
        if (usernameExists[_username])                revert UsernameTaken();

        usernameExists[_username]      = true;
        users[msg.sender].username     = _username;

        emit UserRegistered(msg.sender, _username, _profileCID);
    }

    /// @notice Updates the caller's profile IPFS pointer; requires an already-registered identity.
    /// @param _profileCID IPFS CID digest of the new profile JSON blob.
    function updateProfileCID(bytes32 _profileCID) external {
        if (users[msg.sender].username == bytes32(0)) revert NotRegistered();

        emit ProfileCIDUpdated(msg.sender, _profileCID);
    }

    /**
     * @notice Creates a new forum and enrolls the caller as its first member.
     * @param _forumKey keccak256 hash of the forum handle; doubles as the forum's unique key.
     * @param _minKarmaToFlag Minimum karma a member needs before they can flag content in this forum.
     * @param ipfsCID IPFS CID digest of the forum metadata JSON blob.
     */
    function createForum(bytes32 _forumKey, uint64 _minKarmaToFlag, bytes32 ipfsCID) external {
        if (_forumKey == bytes32(0)) revert InvalidHandle();
        if (_forums[_forumKey].initialized) revert ForumAlreadyExists();

        _forums[_forumKey].initialized = true;
        _forums[_forumKey].minKarmaToFlag = _minKarmaToFlag;
        forumMembership[_forumKey][msg.sender] = true;

        emit ForumCreated(_forumKey, msg.sender, _minKarmaToFlag, ipfsCID);
        emit MemberJoined(_forumKey, msg.sender);
    }

    /// @notice Adds the caller as a member of an existing forum.
    /// @param _forumKey keccak256 hash of the forum handle to join.
    function joinForum(bytes32 _forumKey) external {
        if (!_forums[_forumKey].initialized)          revert ForumNotFound();
        if (forumMembership[_forumKey][msg.sender])   revert AlreadyMember();

        forumMembership[_forumKey][msg.sender] = true;

        emit MemberJoined(_forumKey, msg.sender);
    }

    /// @notice Removes the caller's membership from a forum.
    /// @param _forumKey keccak256 hash of the forum handle to leave.
    function leaveForum(bytes32 _forumKey) external {
        if (!_forums[_forumKey].initialized)          revert ForumNotFound();
        if (!forumMembership[_forumKey][msg.sender])  revert NotMember();

        forumMembership[_forumKey][msg.sender] = false;

        emit MemberLeft(_forumKey, msg.sender);
    }

    /// @notice Returns a forum's on-chain settings.
    /// @param _forumKey keccak256 hash of the forum handle.
    /// @return f The forum's stored data; reverts if the forum was never created.
    function getForumData(bytes32 _forumKey) external view returns (Forum memory f) {
        if (!_forums[_forumKey].initialized) revert ForumNotFound();
        f = _forums[_forumKey];
    }

    /**
     * @notice Creates a post in a forum the caller is a member of.
     * @dev For Poll/Crowdfund post types this is step 1 - the author must separately call
     *      configurePoll/launchCrowdfund afterward to complete the post.
     * @param _forumKey Forum the post belongs to; caller must already be a member.
     * @param _ipfsCID IPFS CID digest of the post content JSON blob.
     * @param _postType Standard, TimeCapsule, Poll, or Crowdfund.
     * @param _duration For TimeCapsule posts, seconds until content unlocks; must be 0 for other types.
     * @return postId The newly assigned post ID.
     */
    function createPost(
        bytes32  _forumKey,
        bytes32  _ipfsCID,
        PostType _postType,
        uint32   _duration
    ) external returns (uint256 postId) {
        if (!_forums[_forumKey].initialized)                    revert ForumNotFound();
        if (!forumMembership[_forumKey][msg.sender])            revert NotMember();
        if (_duration > 0 && _postType != PostType.TimeCapsule) revert InvalidTimeCapsule();

        unchecked { postId = ++postCount; }

        Post storage p = _posts[postId];
        p.author       = msg.sender;
        p.postType     = _postType;
        p.visibleAfter = uint32(block.timestamp) + _duration;
        p.forumKey     = _forumKey;

        emit PostCreated(postId, msg.sender, _forumKey, _postType, p.visibleAfter, _ipfsCID);
    }

    /**
     * @notice Step 2 for Poll posts: sets the option count and voting deadline. Callable once, by the post author only.
     * @param _postId ID of a post created with PostType.Poll.
     * @param _optionCount Number of selectable options, 1-100.
     * @param _duration Seconds from now until poll voting closes.
     */
    function configurePoll(uint256 _postId, uint8 _optionCount, uint32 _duration) external {
        Post storage p = _posts[_postId];
        if (p.author == address(0))                          revert PostNotFound();
        if (p.author != msg.sender)                          revert NotPostAuthor();
        if (p.postType != PostType.Poll)                     revert NotPoll();
        if (_optionCount == 0 || _optionCount > MAX_POLL_OPTIONS) revert PollOptionOutOfRange();
        if (p.pollOptionCount != 0)                          revert PollAlreadyConfigured();

        p.pollOptionCount = _optionCount;
        p.pollDeadline    = uint32(block.timestamp) + _duration;

        emit PollConfigured(_postId, _optionCount, p.pollDeadline);
    }

    /// @notice Returns a post's full on-chain data.
    /// @param _postId ID of the post to fetch.
    /// @return post The post's stored data; reverts if not found, or if it's a TimeCapsule still locked to a non-author.
    function getPostData(uint256 _postId) external view returns (Post memory post) {
        Post storage p = _posts[_postId];
        if (p.author == address(0)) revert PostNotFound();
        if (block.timestamp < p.visibleAfter &&
            msg.sender != p.author) revert TimeCapsuleLocked();
        post = p;
    }

    /// @notice Returns a post's author and type; used by DeRedditEscrow to authorize crowdfund actions.
    /// @param _postId ID of the post to fetch.
    /// @return author The post's author.
    /// @return postType The post's PostType.
    function getPostMeta(uint256 _postId) external view returns (address author, PostType postType) {
        Post storage p = _posts[_postId];
        if (p.author == address(0)) revert PostNotFound();
        if (block.timestamp < p.visibleAfter &&
            msg.sender != p.author) revert TimeCapsuleLocked();
        return (p.author, p.postType);
    }

    /**
     * @notice Creates a comment on a post, or a reply to another comment; reply nesting is capped at tier 3.
     * @param _postId Post the comment belongs to.
     * @param _parentId 0 for a top-level comment, otherwise the ID of the comment being replied to.
     * @param _ipfsCID IPFS CID digest of the comment content JSON blob.
     */
    function createComment(
        uint256 _postId,
        uint256 _parentId,
        bytes32 _ipfsCID
    ) external {
        Post storage topPost = _posts[_postId];
        if (topPost.author == address(0))                        revert PostNotFound();
        if (block.timestamp < topPost.visibleAfter)              revert TimeCapsuleLocked(); // visibleAfter only exceeds now for TimeCapsule posts (duration=0 otherwise)
        if (!forumMembership[topPost.forumKey][msg.sender])      revert NotMember();

        uint8 tier = 1;
        if (_parentId != 0) {
            Comment storage parent = _comments[_parentId];
            if (parent.author == address(0)) revert CommentNotFound();
            if (parent.tier >= MAX_COMMENT_DEPTH) revert DepthExceeded();
            if (parent.postId != _postId) revert CommentPostMismatch();
            unchecked { tier = parent.tier + 1; }
        }

        uint256 commentId;
        unchecked { commentId = ++commentCount; }

        Comment storage c = _comments[commentId];
        c.author   = msg.sender;
        c.tier     = tier;
        c.parentId = _parentId;
        c.postId   = _postId;

        emit CommentCreated(commentId, _postId, _parentId, msg.sender, tier, _ipfsCID);
    }

    /// @notice Returns a comment's full on-chain data.
    /// @param _commentId ID of the comment to fetch.
    /// @return comment The comment's stored data; reverts if not found.
    function getCommentData(uint256 _commentId) external view returns (Comment memory comment) {
        Comment storage c = _comments[_commentId];
        if (c.author == address(0)) revert CommentNotFound();
        return c;
    }

    // Single source of truth for vote-state transitions; mirror this exactly if vote handling
    // is ever touched elsewhere (the indexer also recomputes counts from vote rows rather than
    // trusting a running counter, so this must stay the only place the -2 "swallowed" rule lives).
    function _calculateVoteDelta(
        int8 _prev,
        int8 _direction,
        uint32 _currentUpvotes,
        uint32 _currentDownvotes,
        uint64 _currentKarma
    ) internal pure returns (
        uint32 newUpvotes, 
        uint32 newDownvotes, 
        uint64 newKarma, 
        int8 realDirection
    ) {
        newUpvotes = _currentUpvotes;
        newDownvotes = _currentDownvotes;
        newKarma = _currentKarma;

        unchecked {
            // Undo the previous vote
            if (_prev == 1) {
                if (newUpvotes > 0) --newUpvotes;
                if (newKarma > 0) --newKarma;
            } else if (_prev == -1) {
                if (newDownvotes > 0) --newDownvotes;
                ++newKarma;
            } else if (_prev == -2) {
                if (newDownvotes > 0) --newDownvotes;
                // Swallowed downvote: karma was never decremented for it, so don't restore it here either.
            }

            // Apply the new vote
            if (_direction == 1) {
                ++newUpvotes;
                ++newKarma;
                realDirection = 1;
            } else if (_direction == -1) {
                ++newDownvotes;
                if (newKarma > 0) {
                    --newKarma;
                    realDirection = -1; // effective downvote
                } else {
                    realDirection = -2; // karma floor is 0: downvote still counts but doesn't decrement
                }
            } else {
                realDirection = 0;
            }
        }
    }

    /**
     * @notice Casts, changes, or clears the caller's vote on a post.
     * @dev See _calculateVoteDelta for how karma and vote-state transitions (including the swallowed-downvote floor) are derived.
     * @param _postId Post being voted on; caller cannot vote on their own post.
     * @param _direction -1 (downvote), 0 (clear), or 1 (upvote).
     */
    function votePost(uint256 _postId, int8 _direction) external {
        if (_direction < -1 || _direction > 1) revert InvalidDirection();

        Post storage p = _posts[_postId];
        if (p.author == address(0))           revert PostNotFound();
        if (block.timestamp < p.visibleAfter) revert TimeCapsuleLocked();
        if (p.author == msg.sender)           revert CannotVoteOwnContent();

        address author = p.author;
        int8    prev   = postVoteState[_postId][msg.sender];

        // -1 and -2 are both "currently downvoted" from the caller's perspective, so re-submitting
        // a downvote while swallowed (-2) must also count as SameVote, not a fresh transition.
        bool isPrevDownvote = (prev == -1 || prev == -2);
        bool isNewDownvote = (_direction == -1);
        if (prev == _direction || (isPrevDownvote && isNewDownvote)) revert SameVote();    

        (
            uint32 updatedUpvotes, 
            uint32 updatedDownvotes, 
            uint64 updatedKarma, 
            int8 finalDirectionState
        ) = _calculateVoteDelta(prev, _direction, p.upvotes, p.downvotes, users[author].karma);

        p.upvotes = updatedUpvotes;
        p.downvotes = updatedDownvotes;
        users[author].karma = updatedKarma;

        postVoteState[_postId][msg.sender] = finalDirectionState;
        emit PostVoted(_postId, msg.sender, finalDirectionState, users[author].karma);
    }

    /**
     * @notice Casts, changes, or clears the caller's vote on a comment.
     * @dev See _calculateVoteDelta for how karma and vote-state transitions (including the swallowed-downvote floor) are derived.
     * @param _commentId Comment being voted on; caller cannot vote on their own comment.
     * @param _direction -1 (downvote), 0 (clear), or 1 (upvote).
     */
    function voteComment(uint256 _commentId, int8 _direction) external {
        if (_direction < -1 || _direction > 1) revert InvalidDirection();

        Comment storage c = _comments[_commentId];
        if (c.author == address(0)) revert CommentNotFound();
        if (c.author == msg.sender) revert CannotVoteOwnContent();

        address author = c.author;
        int8    prev   = commentVoteState[_commentId][msg.sender];
        // -1 and -2 are both "currently downvoted" from the caller's perspective, so re-submitting
        // a downvote while swallowed (-2) must also count as SameVote, not a fresh transition.
        bool isPrevDownvote = (prev == -1 || prev == -2);
        bool isNewDownvote = (_direction == -1);
        if (prev == _direction || (isPrevDownvote && isNewDownvote)) revert SameVote();    

        (
            uint32 updatedUpvotes, 
            uint32 updatedDownvotes, 
            uint64 updatedKarma, 
            int8 finalDirectionState
        ) = _calculateVoteDelta(prev, _direction, c.upvotes, c.downvotes, users[author].karma);

        c.upvotes = updatedUpvotes;
        c.downvotes = updatedDownvotes;
        users[author].karma = updatedKarma;

        commentVoteState[_commentId][msg.sender] = finalDirectionState;
        emit CommentVoted(_commentId, msg.sender, finalDirectionState, users[author].karma);
    }

    // Weight scales 1-5 with karma relative to minKarma; minKarma=0 is treated as base=1 so
    // forums with no flagging threshold still get an escalating ladder instead of dividing by zero.
    function _calculateFlagImpact(
        uint64 karma,
        uint64 minKarma
    ) internal pure returns (uint8 weight) {
        uint256 base = (minKarma == 0) ? 1 : minKarma;
        if (karma < base * 10) return 1;
        if (karma < base * 100) return 2;
        if (karma < base * 1000) return 3;
        if (karma < base * 10000) return 4;
        return 5;
    }

    /**
     * @notice Flags a post; requires forum membership and karma >= the forum's minKarmaToFlag.
     * @dev Flag weight scales with the flagger's karma relative to minKarmaToFlag; see _calculateFlagImpact.
     * @param _postId Post to flag.
     */
    function flagPost(uint256 _postId) external {
        Post storage p = _posts[_postId];
        if (p.author == address(0)) revert PostNotFound();
        if (block.timestamp < p.visibleAfter) revert TimeCapsuleLocked(); // visibleAfter only exceeds now for TimeCapsule posts
        if (!forumMembership[p.forumKey][msg.sender]) revert NotMember();
        if (postFlagState[_postId][msg.sender])      revert AlreadyFlagged();
        Forum storage f = _forums[p.forumKey];
        uint64  karma  = users[msg.sender].karma;
        if (karma < f.minKarmaToFlag) revert FlaggingNotActive(); // an unregistered wallet has karma=0 by default, so this alone gates it out

        uint32 weight = _calculateFlagImpact(karma, f.minKarmaToFlag);

        postFlagState[_postId][msg.sender] = true;
        unchecked { p.flagTally += weight; }

        emit PostFlagged(_postId, msg.sender, p.flagTally);
    }

    /**
     * @notice Flags a comment; requires forum membership and karma >= the forum's minKarmaToFlag.
     * @dev Flag weight scales with the flagger's karma relative to minKarmaToFlag; see _calculateFlagImpact.
     * @param _postId Post the comment belongs to.
     * @param _commentId Comment to flag.
     */
    function flagComment(uint256 _postId, uint256 _commentId) external {
        Post storage p = _posts[_postId];
        if (p.author == address(0)) revert PostNotFound();
        if (block.timestamp < p.visibleAfter) revert TimeCapsuleLocked(); // visibleAfter only exceeds now for TimeCapsule posts
        if (!forumMembership[p.forumKey][msg.sender]) revert NotMember();
        Forum storage f = _forums[p.forumKey];
        uint64  karma  = users[msg.sender].karma;
        if (karma < f.minKarmaToFlag) revert FlaggingNotActive(); // an unregistered wallet has karma=0 by default, so this alone gates it out
        Comment storage c = _comments[_commentId];
        if (c.author == address(0)) revert CommentNotFound();
        if (commentFlagState[_commentId][msg.sender])      revert AlreadyFlagged();

        uint32 weight = _calculateFlagImpact(karma, f.minKarmaToFlag);

        commentFlagState[_commentId][msg.sender] = true;
        unchecked { c.flagTally += weight; }

        emit CommentFlagged(_postId, _commentId, msg.sender, c.flagTally);
    }

    /// @notice Sends ETH directly to a post's author.
    /// @param _postId Post whose author receives the tip.
    function tipPostCreator(uint256 _postId) external payable nonReentrant {
        if (msg.value == 0) revert InvalidAmount();
        Post storage p = _posts[_postId];
        address author = p.author;
        if (author == address(0)) revert PostNotFound();

        if (block.timestamp < p.visibleAfter && msg.sender != author) 
            revert TimeCapsuleLocked();
        (bool ok, ) = payable(author).call{value: msg.value}("");
        if (!ok) revert TransferFailed();

        emit TipPostSent(msg.sender, author, _postId, msg.value);
    }

    /// @notice Sends ETH directly to a comment's author.
    /// @param _commentId Comment whose author receives the tip.
    function tipCommentCreator(uint256 _commentId) external payable nonReentrant {
        if (msg.value == 0) revert InvalidAmount();
        Comment storage c = _comments[_commentId];
        address author = c.author;
        if (author == address(0)) revert CommentNotFound();        
        (bool ok, ) = payable(author).call{value: msg.value}("");
        if (!ok) revert TransferFailed();

        emit TipCommentSent(msg.sender, author, _commentId, msg.value);
    }

    /// @notice Sends ETH directly to any address, independent of posts or comments.
    /// @param _recipient Wallet to receive the tip.
    function tipDirect(address _recipient) external payable nonReentrant {
        if (_recipient == address(0)) revert ZeroAddress();
        if (msg.value == 0)           revert InvalidAmount();

        (bool ok, ) = payable(_recipient).call{value: msg.value}("");
        if (!ok) revert TransferFailed();

        emit TipPostSent(msg.sender, _recipient, 0, msg.value);
    }

    /**
     * @notice Casts or changes the caller's vote on a configured poll.
     * @param _postId Post the poll belongs to.
     * @param _optionId Option index, 1-based (0 is reserved to mean "no vote cast yet"); max is the poll's configured option count.
     */
    function castPollVote(uint256 _postId, uint8 _optionId) external {
        Post storage p = _posts[_postId];
        if (p.author == address(0))                   revert PostNotFound();
        if (!forumMembership[p.forumKey][msg.sender]) revert NotMember();
        if (p.postType != PostType.Poll)              revert NotPoll();
        if (p.pollOptionCount == 0)                   revert PollNotConfigured();
        if (block.timestamp > p.pollDeadline)         revert PollExpired();
        if (_optionId > p.pollOptionCount || _optionId == 0) revert PollOptionOutOfRange();

        uint8 prev = userPollChoice[_postId][msg.sender];
        if (prev == _optionId) revert SameVotePoll();

        unchecked {
            if (prev != 0) {
                --pollOptionVotes[_postId][prev]; 
            }
            ++pollOptionVotes[_postId][_optionId]; 
        }

        userPollChoice[_postId][msg.sender] = _optionId;
        emit PollVoteCast(_postId, msg.sender, _optionId);
    }

    /// @notice Returns the current vote tally for each option of a configured poll.
    /// @param _postId Post the poll belongs to.
    /// @return tallies Vote counts indexed by option ID (index 0 is unused, see castPollVote).
    function getPollTallies(uint256 _postId) external view returns (uint32[] memory tallies) {
        Post storage p = _posts[_postId];
        if (p.author == address(0)) revert PostNotFound();
        if (p.postType != PostType.Poll) revert NotPoll();
        if (p.pollOptionCount == 0) revert PollNotConfigured();

        uint8 count = p.pollOptionCount;
        tallies = new uint32[](count);
        for (uint8 i; i < count; ) {
            tallies[i] = pollOptionVotes[_postId][i];
            unchecked { ++i; }
        }
    }

    /**
     * @notice Batch-reads author/type/vote-counts for multiple posts in one call, respecting TimeCapsule locking.
     * @param _ids Post IDs to fetch.
     * @return authors Per-post author, or the zero address while a TimeCapsule post is still locked to the caller.
     * @return types Per-post PostType.
     * @return upArr Per-post upvote count.
     * @return downArr Per-post downvote count.
     */
    function getPostsBatch(uint256[] calldata _ids) external view returns (
        address[]  memory authors,
        PostType[] memory types,
        uint32[]   memory upArr,
        uint32[]   memory downArr
    ) {
        uint256 len = _ids.length;
        authors  = new address[](len);
        types    = new PostType[](len);
        upArr    = new uint32[](len);
        downArr  = new uint32[](len);
        for (uint256 i; i < len; ) {
            Post storage p = _posts[_ids[i]];
            types[i]    = p.postType;
            bool locked = (p.postType == PostType.TimeCapsule) &&
                          (block.timestamp < p.visibleAfter)   &&
                          (msg.sender != p.author);
            if (!locked) {
                authors[i]  = p.author;
                upArr[i]    = p.upvotes;
                downArr[i]  = p.downvotes;
            }
            unchecked { ++i; }
        }
    }

    /// @notice Anchors the indexer's computed Merkle root for a given block; callable only by the governance oracle.
    /// @param _blockNumber Block number the root was computed for.
    /// @param _merkleRoot Root of the indexer's off-chain Merkle tree for that block.
    function anchorDatabaseRoot(uint256 _blockNumber, bytes32 _merkleRoot) external onlyOracle {
        verifiedDatabaseRoots[_blockNumber] = _merkleRoot;
        emit DatabaseRootAnchored(_blockNumber, _merkleRoot);
    }

    /// @notice Returns the anchored Merkle root for a given block, or zero if none was anchored.
    /// @param _blockNumber Block number to look up.
    function getDatabaseRoot(uint256 _blockNumber) external view returns (bytes32) {
        return verifiedDatabaseRoots[_blockNumber];
    }
}