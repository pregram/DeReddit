// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The four post types: Standard, TimeCapsule (content hidden until visibleAfter), Poll (needs a
/// configurePoll step-2 call), and Crowdfund (needs a launchCrowdfund step-2 call in DeRedditEscrow).
enum PostType { Standard, TimeCapsule, Poll, Crowdfund }

// ── Custom errors ─────────────────────────────────────────────────────────────

// Identity
/// @notice Caller's wallet already has a registered username.
error AlreadyRegistered();
/// @notice The requested username is already taken by another wallet.
error UsernameTaken();
/// @notice Username is the zero value.
error InvalidUsername();
/// @notice Caller's wallet has not registered a username yet.
error NotRegistered();

// Forum
/// @notice A forum already exists for the given forum key.
error ForumAlreadyExists();
/// @notice No forum exists for the given forum key.
error ForumNotFound();
/// @notice Forum key/handle is the zero value.
error InvalidHandle();
/// @notice Caller is already a member of the forum.
error AlreadyMember();
/// @notice Caller is not a member of the forum.
error NotMember();

// Post / Comment
/// @notice No post exists for the given post ID.
error PostNotFound();
/// @notice No comment exists for the given comment ID.
error CommentNotFound();
/// @notice A TimeCapsule post/comment is being accessed before visibleAfter by a non-author.
error TimeCapsuleLocked();
/// @notice Caller is not the post's author.
error NotPostAuthor();
/// @notice Reply would exceed the max comment nesting depth (tier 3).
error DepthExceeded();
/// @notice A nonzero duration was given for a post that isn't PostType.TimeCapsule.
error InvalidTimeCapsule();
/// @notice A comment's declared parent belongs to a different post.
error CommentPostMismatch();

// Voting
/// @notice Vote direction is outside the valid {-1, 0, 1} range.
error InvalidDirection();
/// @notice Caller re-cast the same effective vote they already had.
error SameVote();
/// @notice Caller attempted to vote on their own post or comment.
error CannotVoteOwnContent();

// Flagging
/// @notice Caller's karma is below the forum's minKarmaToFlag.
error FlaggingNotActive();
/// @notice Caller has already flagged this post/comment.
error AlreadyFlagged();

// Poll
/// @notice Post is not PostType.Poll.
error NotPoll();
/// @notice Poll has not completed step-2 configuration (configurePoll) yet.
error PollNotConfigured();
/// @notice Poll has already completed step-2 configuration.
error PollAlreadyConfigured();
/// @notice Poll option ID is 0 or exceeds the configured option count.
error PollOptionOutOfRange();
/// @notice Caller re-cast the same poll option they already chose.
error SameVotePoll();
/// @notice Poll voting deadline has passed.
error PollExpired();

// Crowdfund
/// @notice Post is not PostType.Crowdfund.
error NotCrowdfund();
/// @notice Crowdfund has already been launched for this post.
error CrowdfundAlreadyLaunched();
/// @notice Caller is not the crowdfund campaign's creator.
error NotCampaignCreator();
/// @notice Campaign deadline has not passed yet.
error CampaignStillActive();
/// @notice Campaign deadline has already passed.
error CampaignEnded();
/// @notice Campaign's funds raised did not reach its target goal.
error GoalNotReached();
/// @notice Campaign's funds raised already reached its target goal.
error GoalAlreadyReached();
/// @notice Payout has already been claimed for this campaign.
error AlreadyClaimed();
/// @notice Caller has no contribution to refund.
error NothingToRefund();
/// @notice Target goal is zero.
error InvalidGoal();
/// @notice Duration is zero.
error InvalidDuration();

// Financial / misc
/// @notice msg.value is zero where a positive amount is required.
error InvalidAmount();
/// @notice Low-level ETH transfer (call) failed.
error TransferFailed();
/// @notice Address argument is the zero address.
error ZeroAddress();
/// @notice Caller is not authorized to perform this action.
error Unauthorized();
/// @notice Reentrant call detected by the nonReentrant guard.
error Reentrancy();
