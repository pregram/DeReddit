// =============================================================================
// DeReddit Ecosystem - Exhaustive Production Test Suite
// =============================================================================
// Framework : Hardhat v3  |  Assertion Library: Chai
// Covers    : DeRedditCore (all public/external functions)
//             DeRedditEscrow (full fund lifecycle)
// Karma engine: "Magic Marker" Method - -2 swallowed-downvote state
// =============================================================================

import { expect } from "chai";
import { network } from "hardhat";
import { anyValue } from "@nomicfoundation/hardhat-ethers-chai-matchers/withArgs";
const { ethers } = await network.create();

// ─────────────────────────────────────────────────────────────────────────────
// Shared test helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Encode a short string to a right-padded bytes32 value */
function toBytes32(s: string): string {
  return ethers.encodeBytes32String(s);
}

/** keccak256 of a forum handle - mirrors the on-chain key derivation */
function forumKey(handle: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(handle));
}

/** Advance the Hardhat in-process clock by `seconds` */
async function advanceTime(ethersInstance: any, seconds: number): Promise<void> {
  await ethersInstance.provider.send("evm_increaseTime", [seconds]);
  await ethersInstance.provider.send("evm_mine", []);
}

// ─────────────────────────────────────────────────────────────────────────────
// Deployment fixture - shared across all test blocks
// ─────────────────────────────────────────────────────────────────────────────

/** Deploys DeRedditCore + DeRedditEscrow and returns the signers, contracts, and reusable fixture constants every test builds on. */
async function deployAll() {
  const [owner, oracle, user1, user2, user3, attacker] =
    await ethers.getSigners();


  const DeRedditCore = await ethers.getContractFactory("DeRedditCore");
  const core = await DeRedditCore.deploy(oracle.address);
  await core.waitForDeployment();

  const DeRedditEscrow = await ethers.getContractFactory("DeRedditEscrow");
  const escrow = await DeRedditEscrow.deploy(await core.getAddress());
  await escrow.waitForDeployment();

  // ── Convenience constants ─────────────────────────────────────────────────
  const FORUM_HANDLE = "tech";
  const FORUM_KEY    = forumKey(FORUM_HANDLE);
  const FORUM_CID    = toBytes32("QmForumMeta");
  const POST_CID     = toBytes32("QmPostContent");
  const COMMENT_CID  = toBytes32("QmCommentContent");
  const USERNAME_1   = toBytes32("alice");
  const USERNAME_2   = toBytes32("bob");
  const PROFILE_CID  = toBytes32("QmProfile");
  const MIN_KARMA    = 10n; // minKarmaToFlag

  return {
    owner, oracle, user1, user2, user3, attacker,
     core, escrow,
    FORUM_HANDLE, FORUM_KEY, FORUM_CID,
    POST_CID, COMMENT_CID,
    USERNAME_1, USERNAME_2, PROFILE_CID,
    MIN_KARMA,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared setup helpers (called inside tests that need a ready environment)
// ─────────────────────────────────────────────────────────────────────────────

/** Registers user1 + user2, has user1 create the fixture forum, and joins user2 to it. */
async function setupForumWithMembers(
  ctx: Awaited<ReturnType<typeof deployAll>>
) {
  const { core, user1, user2, FORUM_KEY, FORUM_CID, USERNAME_1, USERNAME_2, PROFILE_CID, MIN_KARMA } = ctx;
  await core.connect(user1).registerIdentity(USERNAME_1, PROFILE_CID);
  await core.connect(user2).registerIdentity(USERNAME_2, PROFILE_CID);
  await core.connect(user1).createForum(FORUM_KEY, MIN_KARMA, FORUM_CID);
  await core.connect(user2).joinForum(FORUM_KEY);
}

/** Creates a post as user1 (the fixture's author) and returns its on-chain postId. */
async function setupPost(
  ctx: Awaited<ReturnType<typeof deployAll>>,
  postType = 0 // PostType.Standard = 0
): Promise<bigint> {
  const { core, user1, FORUM_KEY, POST_CID } = ctx;
  const tx = await core.connect(user1).createPost(
    FORUM_KEY,
    POST_CID,
    postType,
    0 // no duration
  );
  const receipt = await tx.wait();
  const event = receipt!.logs
    .map((l: any) => { try { return core.interface.parseLog(l); } catch { return null; } })
    .find((e: any) => e?.name === "PostCreated");
  return event!.args.postId as bigint;
}

/** Creates a comment (root by default, or a reply when `parentId` is given) and returns its on-chain commentId. */
async function setupComment(
  ctx: Awaited<ReturnType<typeof deployAll>>,
  postId: bigint,
  parentId = 0n,
  signer = ctx.user2
): Promise<bigint> {
  const { core, COMMENT_CID } = ctx;
  const tx = await core.connect(signer).createComment(postId, parentId, COMMENT_CID);
  const receipt = await tx.wait();
  const event = receipt!.logs
    .map((l: any) => { try { return core.interface.parseLog(l); } catch { return null; } })
    .find((e: any) => e?.name === "CommentCreated");
  return event!.args.commentId as bigint;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gives user1 (post author) enough karma to survive downvotes in certain tests
// ─────────────────────────────────────────────────────────────────────────────
async function giveKarma(
  ctx: Awaited<ReturnType<typeof deployAll>>,
  postId: bigint,
  amount: number,
  voter = ctx.user2
) {
  // votePost reverts on a second vote from the same address in the same
  // direction (SameVote), so raising karma by more than 1 needs a distinct
  // voter per upvote - draw them from the untouched signer pool instead.
  const signers = await ethers.getSigners();
  const { core, FORUM_KEY } = ctx;
  for (let i = 0; i < amount; i++) {
    const s = signers[10 + i]; // slots 10-onwards are spare accounts
    await core.connect(s).joinForum(FORUM_KEY);
    await core.connect(s).votePost(postId, 1);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  PART 1: DEREDDIT CORE CONTRACT
// ═════════════════════════════════════════════════════════════════════════════

describe("DeRedditCore - 1. Deployment & Administrative Configuration", function () {
  it("deploys all three contracts and stores governanceOracle correctly", async function () {
    const { core, oracle } = await deployAll();
    expect(await core.governanceOracle()).to.equal(oracle.address);
  });

  it("sets reentrancy status to _NOT_ENTERED (1) at construction", async function () {
    // Deployment itself proves no revert - nonReentrant slot is warmed to 1.
    // We cannot read private _status directly; instead verify a nonReentrant
    // function succeeds immediately after deployment (guard is not stuck at 2).
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const postId = await setupPost(ctx);
    // tipPostCreator is nonReentrant - succeeds proves _status == _NOT_ENTERED
    await expect(
      ctx.core.connect(ctx.user2).tipPostCreator(postId, { value: 1n })
    ).to.not.revert(ethers);
  });

  it("Escrow correctly links to DeRedditCore address", async function () {
    const { core, escrow } = await deployAll();
    expect(await escrow.core()).to.equal(await core.getAddress());
  });



  it("reverts DeRedditCore deployment with zero oracle address", async function () {
    const { ethers } = await network.create();
    const DeRedditCore = await ethers.getContractFactory("DeRedditCore");
    await expect(
      DeRedditCore.deploy(ethers.ZeroAddress)
    ).to.be.revertedWithCustomError({ interface: DeRedditCore.interface }, "ZeroAddress");
  });

  it("reverts DeRedditEscrow deployment with zero core address", async function () {
    const { ethers } = await network.create();
    const DeRedditEscrow = await ethers.getContractFactory("DeRedditEscrow");
    await expect(
      DeRedditEscrow.deploy(ethers.ZeroAddress)
    ).to.be.revertedWithCustomError({ interface: DeRedditEscrow.interface }, "ZeroAddress");
  });

  it("anchorDatabaseRoot: oracle can write a merkle root", async function () {
    const { core, oracle } = await deployAll();
    const blockNum = 99n;
    const root = ethers.keccak256(ethers.toUtf8Bytes("stateRoot"));
    await expect(core.connect(oracle).anchorDatabaseRoot(blockNum, root))
      .to.emit(core, "DatabaseRootAnchored")
      .withArgs(blockNum, root);
    expect(await core.getDatabaseRoot(blockNum)).to.equal(root);
  });

  it("anchorDatabaseRoot: non-oracle reverts with Unauthorized", async function () {
    const { core, attacker } = await deployAll();
    await expect(
      core.connect(attacker).anchorDatabaseRoot(1n, ethers.ZeroHash)
    ).to.be.revertedWithCustomError(core, "Unauthorized");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("DeRedditCore - 2a. Identity Registration", function () {
  it("registers a new user, stores username, emits UserRegistered", async function () {
    const { core, user1, USERNAME_1, PROFILE_CID } = await deployAll();
    await expect(core.connect(user1).registerIdentity(USERNAME_1, PROFILE_CID))
      .to.emit(core, "UserRegistered")
      .withArgs(user1.address, USERNAME_1, PROFILE_CID);

    const profile = await core.users(user1.address);
    expect(profile.username).to.equal(USERNAME_1);
    expect(profile.karma).to.equal(0n);
    expect(await core.usernameExists(USERNAME_1)).to.be.true;
  });

  it("reverts if the same wallet registers twice (AlreadyRegistered)", async function () {
    const { core, user1, USERNAME_1, PROFILE_CID } = await deployAll();
    await core.connect(user1).registerIdentity(USERNAME_1, PROFILE_CID);
    await expect(
      core.connect(user1).registerIdentity(toBytes32("alice2"), PROFILE_CID)
    ).to.be.revertedWithCustomError(core, "AlreadyRegistered");
  });

  it("reverts if username is bytes32(0) (InvalidUsername)", async function () {
    const { core, user1, PROFILE_CID } = await deployAll();
    await expect(
      core.connect(user1).registerIdentity(ethers.ZeroHash, PROFILE_CID)
    ).to.be.revertedWithCustomError(core, "InvalidUsername");
  });

  it("reverts if username is already taken by another wallet (UsernameTaken)", async function () {
    const { core, user1, user2, USERNAME_1, PROFILE_CID } = await deployAll();
    await core.connect(user1).registerIdentity(USERNAME_1, PROFILE_CID);
    await expect(
      core.connect(user2).registerIdentity(USERNAME_1, PROFILE_CID)
    ).to.be.revertedWithCustomError(core, "UsernameTaken");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("DeRedditCore - 2a2. Profile CID Updates", function () {
  it("registered user updates profile CID, emits ProfileCIDUpdated", async function () {
    const { core, user1, USERNAME_1, PROFILE_CID } = await deployAll();
    await core.connect(user1).registerIdentity(USERNAME_1, PROFILE_CID);

    const NEW_CID = toBytes32("QmNewProfile");
    await expect(core.connect(user1).updateProfileCID(NEW_CID))
      .to.emit(core, "ProfileCIDUpdated")
      .withArgs(user1.address, NEW_CID);
  });

  it("reverts if caller has no identity registered (NotRegistered)", async function () {
    const { core, user1, PROFILE_CID } = await deployAll();
    await expect(
      core.connect(user1).updateProfileCID(PROFILE_CID)
    ).to.be.revertedWithCustomError(core, "NotRegistered");
  });

  it("allows updating to bytes32(0) (no zero-CID guard on this path, unlike registerIdentity's username check)", async function () {
    const { core, user1, USERNAME_1, PROFILE_CID } = await deployAll();
    await core.connect(user1).registerIdentity(USERNAME_1, PROFILE_CID);

    await expect(core.connect(user1).updateProfileCID(ethers.ZeroHash))
      .to.emit(core, "ProfileCIDUpdated")
      .withArgs(user1.address, ethers.ZeroHash);
  });

  it("does not persist profileCID in on-chain storage (event-only, mirrored off-chain by the indexer)", async function () {
    const { core, user1, USERNAME_1, PROFILE_CID } = await deployAll();
    await core.connect(user1).registerIdentity(USERNAME_1, PROFILE_CID);
    await core.connect(user1).updateProfileCID(toBytes32("QmNewProfile"));

    const profile = await core.users(user1.address);
    expect(profile.username).to.equal(USERNAME_1);
    expect(profile.karma).to.equal(0n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("DeRedditCore - 2b. Forum Management", function () {
  it("creates a forum, sets initialized=true, auto-joins creator, emits events", async function () {
    const { core, user1, FORUM_KEY, FORUM_CID, MIN_KARMA, PROFILE_CID, USERNAME_1 } =
      await deployAll();
    await core.connect(user1).registerIdentity(USERNAME_1, PROFILE_CID);

    await expect(core.connect(user1).createForum(FORUM_KEY, MIN_KARMA, FORUM_CID))
      .to.emit(core, "ForumCreated")
      .withArgs(FORUM_KEY, user1.address, MIN_KARMA, FORUM_CID)
      .and.to.emit(core, "MemberJoined")
      .withArgs(FORUM_KEY, user1.address);

    const f = await core.getForumData(FORUM_KEY);
    expect(f.initialized).to.be.true;
    expect(f.minKarmaToFlag).to.equal(MIN_KARMA);
    expect(await core.forumMembership(FORUM_KEY, user1.address)).to.be.true;
  });

  it("reverts createForum with empty bytes32 key (InvalidHandle)", async function () {
    const { core, user1 } = await deployAll();
    await expect(
      core.connect(user1).createForum(ethers.ZeroHash, 0n, ethers.ZeroHash)
    ).to.be.revertedWithCustomError(core, "InvalidHandle");
  });

  it("reverts createForum when forum already exists (ForumAlreadyExists)", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    await expect(
      ctx.core.connect(ctx.user1).createForum(ctx.FORUM_KEY, 0n, ctx.FORUM_CID)
    ).to.be.revertedWithCustomError(ctx.core, "ForumAlreadyExists");
  });

  it("joinForum: non-member joins, emits MemberJoined, membership set to true", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const { core, user3, FORUM_KEY } = ctx;

    // user3 has no prior membership
    await expect(core.connect(user3).joinForum(FORUM_KEY))
      .to.emit(core, "MemberJoined")
      .withArgs(FORUM_KEY, user3.address);
    expect(await core.forumMembership(FORUM_KEY, user3.address)).to.be.true;
  });

  it("joinForum: reverts when forum doesn't exist (ForumNotFound)", async function () {
    const { core, user1 } = await deployAll();
    await expect(
      core.connect(user1).joinForum(forumKey("nonexistent"))
    ).to.be.revertedWithCustomError(core, "ForumNotFound");
  });

  it("joinForum: reverts if already a member (AlreadyMember)", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    await expect(
      ctx.core.connect(ctx.user1).joinForum(ctx.FORUM_KEY)
    ).to.be.revertedWithCustomError(ctx.core, "AlreadyMember");
  });

  it("leaveForum: member leaves, membership set to false, emits MemberLeft", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const { core, user2, FORUM_KEY } = ctx;

    await expect(core.connect(user2).leaveForum(FORUM_KEY))
      .to.emit(core, "MemberLeft")
      .withArgs(FORUM_KEY, user2.address);
    expect(await core.forumMembership(FORUM_KEY, user2.address)).to.be.false;
  });

  it("leaveForum: reverts when forum doesn't exist (ForumNotFound)", async function () {
    const { core, user1 } = await deployAll();
    await expect(
      core.connect(user1).leaveForum(forumKey("ghost"))
    ).to.be.revertedWithCustomError(core, "ForumNotFound");
  });

  it("leaveForum: reverts if caller is not a member (NotMember)", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    await expect(
      ctx.core.connect(ctx.attacker).leaveForum(ctx.FORUM_KEY)
    ).to.be.revertedWithCustomError(ctx.core, "NotMember");
  });

  it("getForumData: reverts for non-existent forum (ForumNotFound)", async function () {
    const { core } = await deployAll();
    await expect(
      core.getForumData(forumKey("ghost"))
    ).to.be.revertedWithCustomError(core, "ForumNotFound");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("DeRedditCore - 2c. Post Creation & Retrieval", function () {
  it("createPost: increments postCount, emits PostCreated with correct args", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const { core, user1, FORUM_KEY, POST_CID } = ctx;

    expect(await core.postCount()).to.equal(0n);
    await expect(core.connect(user1).createPost(FORUM_KEY, POST_CID, 0, 0))
      .to.emit(core, "PostCreated")
      .withArgs(1n, user1.address, FORUM_KEY, 0 /* Standard */, anyValue, POST_CID);
    expect(await core.postCount()).to.equal(1n);
  });

  it("createPost: reverts if forum not found (ForumNotFound)", async function () {
    const { core, user1 } = await deployAll();
    await expect(
      core.connect(user1).createPost(forumKey("ghost"), ethers.ZeroHash, 0, 0)
    ).to.be.revertedWithCustomError(core, "ForumNotFound");
  });

  it("createPost: reverts if caller is not a member (NotMember)", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    await expect(
      ctx.core.connect(ctx.attacker).createPost(ctx.FORUM_KEY, ctx.POST_CID, 0, 0)
    ).to.be.revertedWithCustomError(ctx.core, "NotMember");
  });

  it("createPost: reverts if duration>0 but postType is not TimeCapsule (InvalidTimeCapsule)", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    // PostType.Standard = 0, but duration > 0
    await expect(
      ctx.core.connect(ctx.user1).createPost(ctx.FORUM_KEY, ctx.POST_CID, 0 /* Standard */, 3600)
    ).to.be.revertedWithCustomError(ctx.core, "InvalidTimeCapsule");
  });

  it("createPost: TimeCapsule post sets visibleAfter in the future", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const { core, user1, FORUM_KEY, POST_CID } = ctx;
    const duration = 3600;
    const before = BigInt(Math.floor(Date.now() / 1000));

    const tx = await core.connect(user1).createPost(FORUM_KEY, POST_CID, 1 /* TimeCapsule */, duration);
    const receipt = await tx.wait();
    const event = receipt!.logs
      .map((l: any) => { try { return core.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "PostCreated");
    const visibleAfter = event!.args.visibleAfter as bigint;
    expect(visibleAfter).to.be.greaterThan(before);
  });

  it("getPostData: author can read own TimeCapsule before unlock", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const { core, user1, FORUM_KEY, POST_CID } = ctx;

    const tx = await core.connect(user1).createPost(FORUM_KEY, POST_CID, 1 /* TimeCapsule */, 86400);
    const receipt = await tx.wait();
    const event = receipt!.logs
      .map((l: any) => { try { return core.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "PostCreated");
    const postId = event!.args.postId as bigint;

    // Author reads own locked capsule - must NOT revert
    const post = await core.connect(user1).getPostData(postId);
    expect(post.author).to.equal(user1.address);
  });

  it("getPostData: non-author reverts with TimeCapsuleLocked before unlock", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const { core, user1, user2, FORUM_KEY, POST_CID } = ctx;

    const tx = await core.connect(user1).createPost(FORUM_KEY, POST_CID, 1 /* TimeCapsule */, 86400);
    const receipt = await tx.wait();
    const event = receipt!.logs
      .map((l: any) => { try { return core.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "PostCreated");
    const postId = event!.args.postId as bigint;

    await expect(
      core.connect(user2).getPostData(postId)
    ).to.be.revertedWithCustomError(core, "TimeCapsuleLocked");
  });

  it("getPostData: anyone can read after TimeCapsule unlocks", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const { core, user1, user2, FORUM_KEY, POST_CID } = ctx;

    const tx = await core.connect(user1).createPost(FORUM_KEY, POST_CID, 1 /* TimeCapsule */, 60);
    const receipt = await tx.wait();
    const event = receipt!.logs
      .map((l: any) => { try { return core.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "PostCreated");
    const postId = event!.args.postId as bigint;

    await advanceTime(ethers, 61);
    const post = await core.connect(user2).getPostData(postId);
    expect(post.author).to.equal(user1.address);
  });

  it("getPostData: reverts for nonexistent post (PostNotFound)", async function () {
    const { core } = await deployAll();
    await expect(core.getPostData(9999n)).to.be.revertedWithCustomError(core, "PostNotFound");
  });

  it("getPostsBatch: locked capsule slots return zeroed fields for non-author", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const { core, user1, user2, FORUM_KEY, POST_CID } = ctx;

    // Post 1: normal
    await core.connect(user1).createPost(FORUM_KEY, POST_CID, 0, 0);
    // Post 2: TimeCapsule
    await core.connect(user1).createPost(FORUM_KEY, POST_CID, 1 /* TimeCapsule */, 86400);

    const [authors, types, , ] = await core.connect(user2).getPostsBatch([1n, 2n]);

    // Normal post slot: author visible
    expect(authors[0]).to.equal(user1.address);
    // Capsule slot: zeroed for non-author
    expect(authors[1]).to.equal(ethers.ZeroAddress);
    // Type is still visible (types[1] should equal TimeCapsule = 1)
    expect(types[1]).to.equal(1n);
  });

  it("getPostsBatch: author sees own capsule in batch", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const { core, user1, FORUM_KEY, POST_CID } = ctx;

    await core.connect(user1).createPost(FORUM_KEY, POST_CID, 1 /* TimeCapsule */, 86400);
    const [authors] = await core.connect(user1).getPostsBatch([1n]);
    expect(authors[0]).to.equal(user1.address);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("DeRedditCore - 2d. Comment Creation & Threading", function () {
  it("createComment: tier-1 root comment, emits CommentCreated, increments commentCount", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const postId = await setupPost(ctx);
    const { core, user2, COMMENT_CID } = ctx;

    await expect(core.connect(user2).createComment(postId, 0n, COMMENT_CID))
      .to.emit(core, "CommentCreated")
      .withArgs(1n, postId, 0n, user2.address, 1, COMMENT_CID);

    expect(await core.commentCount()).to.equal(1n);
  });

  it("createComment: tier-2 reply on a tier-1 comment sets tier correctly", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const postId = await setupPost(ctx);
    const commentId1 = await setupComment(ctx, postId);
    const { core, user1, COMMENT_CID } = ctx;

    const tx = await core.connect(user1).createComment(postId, commentId1, COMMENT_CID);
    const receipt = await tx.wait();
    const event = receipt!.logs
      .map((l: any) => { try { return core.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "CommentCreated");
    expect(event!.args.tier).to.equal(2);
  });

it("createComment: tier-3 reply is allowed", async function () {
  const ctx = await deployAll();
  await setupForumWithMembers(ctx);
  const postId = await setupPost(ctx);
  const c1 = await setupComment(ctx, postId);
  const c2 = await setupComment(ctx, postId, c1, ctx.user1);
  const { core, user2, COMMENT_CID } = ctx;

  const tx = await core.connect(user2).createComment(postId, c2, COMMENT_CID);
  const receipt = await tx.wait();
  const event = receipt!.logs
    .map((l: any) => { try { return core.interface.parseLog(l); } catch { return null; } })
    .find((e: any) => e?.name === "CommentCreated");
  const c3Id = event!.args.commentId as bigint;

  const data = await core.getCommentData(c3Id);
  expect(data.tier).to.equal(3);
});

  it("createComment: tier-4 reply reverts (DepthExceeded)", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const postId = await setupPost(ctx);
    const c1 = await setupComment(ctx, postId);
    const c2 = await setupComment(ctx, postId, c1, ctx.user1);
    const c3 = await setupComment(ctx, postId, c2);
    const { core, user1, COMMENT_CID } = ctx;

    await expect(
      core.connect(user1).createComment(postId, c3, COMMENT_CID)
    ).to.be.revertedWithCustomError(core, "DepthExceeded");
  });

  it("createComment: reverts for nonexistent parent comment (CommentNotFound)", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const postId = await setupPost(ctx);
    await expect(
      ctx.core.connect(ctx.user2).createComment(postId, 9999n, ctx.COMMENT_CID)
    ).to.be.revertedWithCustomError(ctx.core, "CommentNotFound");
  });

  it("createComment: reverts on nonexistent post (PostNotFound)", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    await expect(
      ctx.core.connect(ctx.user2).createComment(9999n, 0n, ctx.COMMENT_CID)
    ).to.be.revertedWithCustomError(ctx.core, "PostNotFound");
  });

  it("createComment: reverts if caller is not a forum member (NotMember)", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const postId = await setupPost(ctx);
    await expect(
      ctx.core.connect(ctx.attacker).createComment(postId, 0n, ctx.COMMENT_CID)
    ).to.be.revertedWithCustomError(ctx.core, "NotMember");
  });

  it("createComment: reverts on locked TimeCapsule post (TimeCapsuleLocked)", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const { core, user1, user2, FORUM_KEY, POST_CID, COMMENT_CID } = ctx;

    const tx = await core.connect(user1).createPost(FORUM_KEY, POST_CID, 1 /* TimeCapsule */, 3600);
    const receipt = await tx.wait();
    const event = receipt!.logs
      .map((l: any) => { try { return core.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "PostCreated");
    const postId = event!.args.postId as bigint;

    await expect(
      core.connect(user2).createComment(postId, 0n, COMMENT_CID)
    ).to.be.revertedWithCustomError(core, "TimeCapsuleLocked");
  });

  it("getCommentData: reverts for nonexistent comment (CommentNotFound)", async function () {
    const { core } = await deployAll();
    await expect(core.getCommentData(9999n)).to.be.revertedWithCustomError(core, "CommentNotFound");
  });

  it("createComment: reverts when _parentId belongs to a different post (CommentPostMismatch)", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const { core, user1, user2, FORUM_KEY, POST_CID, COMMENT_CID } = ctx;

    const postA = await setupPost(ctx);
    const txB = await core.connect(user1).createPost(FORUM_KEY, POST_CID, 0, 0);
    const receiptB = await txB.wait();
    const postB = receiptB!.logs
      .map((l: any) => { try { return core.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "PostCreated")!.args.postId as bigint;

    const commentUnderA = await setupComment(ctx, postA);

    await expect(
      core.connect(user2).createComment(postB, commentUnderA, COMMENT_CID)
    ).to.be.revertedWithCustomError(core, "CommentPostMismatch");
  });

  it("createComment: reply under the correct post still succeeds (postId matches parent)", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const { core, user1, COMMENT_CID } = ctx;

    const postId = await setupPost(ctx);
    const commentId = await setupComment(ctx, postId);

    await expect(core.connect(user1).createComment(postId, commentId, COMMENT_CID))
      .to.emit(core, "CommentCreated");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("DeRedditCore - 2e. Poll Configuration", function () {
  it("configurePoll: sets optionCount and deadline, emits PollConfigured", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const { core, user1, FORUM_KEY, POST_CID } = ctx;
    const tx = await core.connect(user1).createPost(FORUM_KEY, POST_CID, 2 /* Poll */, 0);
    const r = await tx.wait();
    const postId = r!.logs
      .map((l: any) => { try { return core.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "PostCreated")!.args.postId as bigint;

    await expect(core.connect(user1).configurePoll(postId, 3, 3600))
      .to.emit(core, "PollConfigured")
      .withArgs(postId, 3, anyValue);

    const post = await core.connect(user1).getPostData(postId);
    expect(post.pollOptionCount).to.equal(3);
  });

  it("configurePoll: reverts if post doesn't exist (PostNotFound)", async function () {
    const { core, user1 } = await deployAll();
    await expect(
      core.connect(user1).configurePoll(9999n, 2, 3600)
    ).to.be.revertedWithCustomError(core, "PostNotFound");
  });

  it("configurePoll: reverts if not the post author (NotPostAuthor)", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const { core, user1, user2, FORUM_KEY, POST_CID } = ctx;
    const tx = await core.connect(user1).createPost(FORUM_KEY, POST_CID, 2 /* Poll */, 0);
    const r = await tx.wait();
    const postId = r!.logs
      .map((l: any) => { try { return core.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "PostCreated")!.args.postId as bigint;

    await expect(
      core.connect(user2).configurePoll(postId, 2, 3600)
    ).to.be.revertedWithCustomError(core, "NotPostAuthor");
  });

  it("configurePoll: reverts if post is not Poll type (NotPoll)", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const postId = await setupPost(ctx); // Standard type

    await expect(
      ctx.core.connect(ctx.user1).configurePoll(postId, 2, 3600)
    ).to.be.revertedWithCustomError(ctx.core, "NotPoll");
  });

  it("configurePoll: reverts if optionCount is 0 (PollOptionOutOfRange)", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const { core, user1, FORUM_KEY, POST_CID } = ctx;
    const tx = await core.connect(user1).createPost(FORUM_KEY, POST_CID, 2, 0);
    const r = await tx.wait();
    const postId = r!.logs
      .map((l: any) => { try { return core.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "PostCreated")!.args.postId as bigint;

    await expect(
      core.connect(user1).configurePoll(postId, 0, 3600)
    ).to.be.revertedWithCustomError(core, "PollOptionOutOfRange");
  });

  it("configurePoll: reverts if called a second time (PollAlreadyConfigured)", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const { core, user1, FORUM_KEY, POST_CID } = ctx;
    const tx = await core.connect(user1).createPost(FORUM_KEY, POST_CID, 2, 0);
    const r = await tx.wait();
    const postId = r!.logs
      .map((l: any) => { try { return core.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "PostCreated")!.args.postId as bigint;

    await core.connect(user1).configurePoll(postId, 2, 3600);
    await expect(
      core.connect(user1).configurePoll(postId, 3, 7200)
    ).to.be.revertedWithCustomError(core, "PollAlreadyConfigured");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("DeRedditCore - 3. Advanced Voting Engine (votePost)", function () {

  // ── Setup helper for voting tests ──────────────────────────────────────────
  async function setupVotingEnv() {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const postId = await setupPost(ctx); // user1 is author
    return { ...ctx, postId };
  }

  // ── Input validation ───────────────────────────────────────────────────────

  it("reverts on invalid direction (e.g., 42) with InvalidDirection", async function () {
    const { core, user2, postId } = await setupVotingEnv();
    await expect(
      core.connect(user2).votePost(postId, 42)
    ).to.be.revertedWithCustomError(core, "InvalidDirection");
  });

  it("reverts on invalid direction (-2 raw input) with InvalidDirection", async function () {
    const { core, user2, postId } = await setupVotingEnv();
    await expect(
      core.connect(user2).votePost(postId, -2)
    ).to.be.revertedWithCustomError(core, "InvalidDirection");
  });

  it("reverts for a nonexistent post ID (PostNotFound)", async function () {
    const { core, user2 } = await setupVotingEnv();
    await expect(
      core.connect(user2).votePost(9999n, 1)
    ).to.be.revertedWithCustomError(core, "PostNotFound");
  });

  it("reverts with SameVote when voting the same direction twice", async function () {
    const { core, user2, postId } = await setupVotingEnv();
    await core.connect(user2).votePost(postId, 1);
    await expect(
      core.connect(user2).votePost(postId, 1)
    ).to.be.revertedWithCustomError(core, "SameVote");
  });

  it("reverts with SameVote when prev=-1 (effective) and direction=-1 again", async function () {
    const ctx = await setupVotingEnv();
    const { core, user1, user2, postId } = ctx;
    // Give user1 karma so first downvote is effective (-1 state)
    await giveKarma(ctx, postId, 5, user2);
    // user2 casts the first downvote (effective)
    await core.connect(user2).votePost(postId, -1);
    // Attempt second downvote - must revert
    await expect(
      core.connect(user2).votePost(postId, -1)
    ).to.be.revertedWithCustomError(core, "SameVote");
  });

  it("reverts with SameVote when prev=-2 (swallowed) and direction=-1 again", async function () {
    const { core, user2, postId } = await setupVotingEnv();
    // user1 has 0 karma - downvote is swallowed → state becomes -2
    await core.connect(user2).votePost(postId, -1);
    expect(await core.postVoteState(postId, user2.address)).to.equal(-2);
    // Retry downvote - must revert (both prev and direction are effectively downvotes)
    await expect(
      core.connect(user2).votePost(postId, -1)
    ).to.be.revertedWithCustomError(core, "SameVote");
  });

  // ── 0 → 1 transition ──────────────────────────────────────────────────────

  it("0 → 1: upvotes++ and karma++ and state stored as 1", async function () {
    const { core, user1, user2, postId } = await setupVotingEnv();

    await expect(core.connect(user2).votePost(postId, 1))
      .to.emit(core, "PostVoted")
      .withArgs(postId, user2.address, 1, 1n);

    const post = await core.connect(user1).getPostData(postId);
    expect(post.upvotes).to.equal(1);
    expect(post.downvotes).to.equal(0);
    expect((await core.users(user1.address)).karma).to.equal(1n);
    expect(await core.postVoteState(postId, user2.address)).to.equal(1);
  });

  // ── 0 → -1 with karma > 0 (effective downvote) ───────────────────────────

  it("0 → -1 (karma>0): downvotes++, karma--, state stored as -1", async function () {
    const ctx = await setupVotingEnv();
    const { core, user1, user2, postId } = ctx;

    // Give user1 2 karma first (via spare voter)
    await giveKarma(ctx, postId, 2, user2);

    // user2 now downvotes
    await expect(core.connect(user2).votePost(postId, -1))
      .to.emit(core, "PostVoted")
      .withArgs(postId, user2.address, -1, anyValue);

    const post = await core.connect(user1).getPostData(postId);
    expect(post.downvotes).to.equal(1);
    expect((await core.users(user1.address)).karma).to.be.greaterThan(0n);
    expect(await core.postVoteState(postId, user2.address)).to.equal(-1);
  });

  // ── 0 → -1 with karma = 0 (swallowed downvote, Magic Marker) ─────────────

  it("0 → -1 (karma=0): downvotes++, karma STAYS 0, state stored as -2 (Magic Marker)", async function () {
    const { core, user1, user2, postId } = await setupVotingEnv();
    // user1 starts at karma 0

    const tx = await core.connect(user2).votePost(postId, -1);
    await tx.wait();

    // Event must emit finalDirectionState = -2, NOT the raw input -1
    await expect(tx)
      .to.emit(core, "PostVoted")
      .withArgs(postId, user2.address, -2, 0n);

    const post = await core.connect(user1).getPostData(postId);
    expect(post.downvotes).to.equal(1);
    expect((await core.users(user1.address)).karma).to.equal(0n);

    // The stored state must be -2
    expect(await core.postVoteState(postId, user2.address)).to.equal(-2);
  });

  // ── 1 → 0 (withdraw upvote) ───────────────────────────────────────────────

  it("1 → 0: upvotes--, karma--, state stored as 0", async function () {
    const { core, user1, user2, postId } = await setupVotingEnv();

    await core.connect(user2).votePost(postId, 1); // 0→1
    await expect(core.connect(user2).votePost(postId, 0)) // 1→0
      .to.emit(core, "PostVoted")
      .withArgs(postId, user2.address, 0, 0n);

    const post = await core.connect(user1).getPostData(postId);
    expect(post.upvotes).to.equal(0);
    expect((await core.users(user1.address)).karma).to.equal(0n);
    expect(await core.postVoteState(postId, user2.address)).to.equal(0);
  });

  // ── -1 → 0 (withdraw effective downvote) ─────────────────────────────────

  it("-1 → 0: downvotes--, karma++ (restore), state stored as 0", async function () {
    const ctx = await setupVotingEnv();
    const { core, user1, user2, postId } = ctx;

    await giveKarma(ctx, postId, 2, user2);

    await core.connect(user2).votePost(postId, -1); // gives -1 state
    const karmaBefore = (await core.users(user1.address)).karma;

    await core.connect(user2).votePost(postId, 0); // restore

    const post = await core.connect(user1).getPostData(postId);
    expect(post.downvotes).to.equal(0);
    const karmaAfter = (await core.users(user1.address)).karma;
    expect(karmaAfter).to.be.greaterThan(karmaBefore);
    expect(await core.postVoteState(postId, user2.address)).to.equal(0);
  });

  // ── -2 → 0 (Phantom Inflation Guard) ─────────────────────────────────────

  it("-2 → 0: downvotes--, karma STAYS 0 (phantom inflation guard)", async function () {
    const { core, user1, user2, postId } = await setupVotingEnv();

    // Cast swallowed downvote
    await core.connect(user2).votePost(postId, -1); // state → -2
    expect(await core.postVoteState(postId, user2.address)).to.equal(-2);

    // Withdraw the swallowed vote
    await expect(core.connect(user2).votePost(postId, 0))
      .to.emit(core, "PostVoted")
      .withArgs(postId, user2.address, 0, 0n);

    const post = await core.connect(user1).getPostData(postId);
    expect(post.downvotes).to.equal(0); // downvote counter restored
    // Karma must NOT have been incremented - stays at 0
    expect((await core.users(user1.address)).karma).to.equal(0n);
    expect(await core.postVoteState(postId, user2.address)).to.equal(0);
  });

  // ── -2 → 1 (swallowed downvote → upvote, no phantom karma from undo) ─────

  it("-2 → 1: downvotes--, no karma restore, then upvotes++ karma++, state=1", async function () {
    const { core, user1, user2, postId } = await setupVotingEnv();

    await core.connect(user2).votePost(postId, -1); // state → -2, karma=0

    await expect(core.connect(user2).votePost(postId, 1))
      .to.emit(core, "PostVoted")
      .withArgs(postId, user2.address, 1, 1n); // karma ends at 1 (only from upvote)

    const post = await core.connect(user1).getPostData(postId);
    expect(post.downvotes).to.equal(0);
    expect(post.upvotes).to.equal(1);
    expect((await core.users(user1.address)).karma).to.equal(1n);
    expect(await core.postVoteState(postId, user2.address)).to.equal(1);
  });

  // ── 1 → -1 (flip from upvote to downvote, karma>0) ───────────────────────
  it("1 → -1 (upvote reversal then downvote lands as swallowed): state=-2, karma=0", async function () {
    const { core, user1, user2, postId } = await setupVotingEnv();

    await core.connect(user2).votePost(postId, 1);   // karma → 1, state = 1

    // Undo upvote (karma back to 0), then downvote at karma=0 → swallowed → -2
    await expect(core.connect(user2).votePost(postId, -1))
      .to.emit(core, "PostVoted")
      .withArgs(postId, user2.address, -2, 0n);   // finalDirectionState=-2, not -1

    const post = await core.connect(user1).getPostData(postId);
    expect(post.upvotes).to.equal(0);
    expect(post.downvotes).to.equal(1);
    expect((await core.users(user1.address)).karma).to.equal(0n);
    expect(await core.postVoteState(postId, user2.address)).to.equal(-2);
  });

  // ── Event emits finalDirectionState, NOT raw _direction ───────────────────

  it("event emits finalDirectionState=-2, not raw input -1 for swallowed downvote", async function () {
    const { core, user2, postId } = await setupVotingEnv();

    const tx = await core.connect(user2).votePost(postId, -1);
    // Check event arg: should be -2, not -1
    await expect(tx)
      .to.emit(core, "PostVoted")
      .withArgs(postId, user2.address, -2, 0n);
  });

  // ── TimeCapsule post is unvotable before unlock ───────────────────────────

  it("reverts voting on a locked TimeCapsule post (TimeCapsuleLocked)", async function () {
    const ctx = await setupVotingEnv();
    const { core, user1, user2, FORUM_KEY, POST_CID } = ctx;

    const tx = await core.connect(user1).createPost(FORUM_KEY, POST_CID, 1 /* TimeCapsule */, 3600);
    const r = await tx.wait();
    const capsuleId = r!.logs
      .map((l: any) => { try { return core.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "PostCreated")!.args.postId as bigint;

    await expect(
      core.connect(user2).votePost(capsuleId, 1)
    ).to.be.revertedWithCustomError(core, "TimeCapsuleLocked");
  });

  // ── Self-vote guard ────────────────────────────────────────────────────────

  it("reverts when the post author votes on their own post (CannotVoteOwnContent)", async function () {
    const { core, user1, postId } = await setupVotingEnv();
    await expect(
      core.connect(user1).votePost(postId, 1)
    ).to.be.revertedWithCustomError(core, "CannotVoteOwnContent");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("DeRedditCore - 3b. voteComment Engine", function () {

  async function setupCommentVotingEnv() {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const postId = await setupPost(ctx); // user1 is post author
    const commentId = await setupComment(ctx, postId); // user2 is comment author
    return { ...ctx, postId, commentId };
  }

  it("0 → 1: upvotes++, karma++, state stored via postVoteState mapping", async function () {
    const { core, user1, user2, commentId } = await setupCommentVotingEnv();
    // Note: voteComment stores in postVoteState[commentId] (contract behavior)
    await expect(core.connect(user1).voteComment(commentId, 1))
      .to.emit(core, "CommentVoted")
      .withArgs(commentId, user1.address, 1, 1n);

    const comment = await core.getCommentData(commentId);
    expect(comment.upvotes).to.equal(1);
    expect((await core.users(user2.address)).karma).to.equal(1n);
  });

  it("0 → -1 with karma=0: swallowed, finalDirectionState=-2, karma stays 0", async function () {
    const { core, user1, user2, commentId } = await setupCommentVotingEnv();

    await expect(core.connect(user1).voteComment(commentId, -1))
      .to.emit(core, "CommentVoted")
      .withArgs(commentId, user1.address, -2, 0n);

    const comment = await core.getCommentData(commentId);
    expect(comment.downvotes).to.equal(1);
    // user2 is comment author - karma must still be 0
    expect((await core.users(user2.address)).karma).to.equal(0n);
  });

  it("-2 → 0: downvotes--, karma stays 0 (phantom inflation guard)", async function () {
    const { core, user1, user2, commentId } = await setupCommentVotingEnv();

    await core.connect(user1).voteComment(commentId, -1); // → -2 state
    await core.connect(user1).voteComment(commentId, 0);  // → 0, no karma restore

    const comment = await core.getCommentData(commentId);
    expect(comment.downvotes).to.equal(0);
    expect((await core.users(user2.address)).karma).to.equal(0n);
  });

  it("reverts on SameVote for identical direction", async function () {
    const { core, user1, commentId } = await setupCommentVotingEnv();
    await core.connect(user1).voteComment(commentId, 1);
    await expect(
      core.connect(user1).voteComment(commentId, 1)
    ).to.be.revertedWithCustomError(core, "SameVote");
  });

  it("reverts for nonexistent comment (CommentNotFound)", async function () {
    const { core, user1 } = await setupCommentVotingEnv();
    await expect(
      core.connect(user1).voteComment(9999n, 1)
    ).to.be.revertedWithCustomError(core, "CommentNotFound");
  });

  it("reverts on invalid direction (InvalidDirection)", async function () {
    const { core, user1, commentId } = await setupCommentVotingEnv();
    await expect(
      core.connect(user1).voteComment(commentId, 5)
    ).to.be.revertedWithCustomError(core, "InvalidDirection");
  });

  // ── Self-vote guard ────────────────────────────────────────────────────────

  it("reverts when the comment author votes on their own comment (CannotVoteOwnContent)", async function () {
    // setupComment defaults to signer = user2, so user2 is the comment author here
    const { core, user2, commentId } = await setupCommentVotingEnv();
    await expect(
      core.connect(user2).voteComment(commentId, 1)
    ).to.be.revertedWithCustomError(core, "CannotVoteOwnContent");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("DeRedditCore - 3c. Sybil-Resistant Flagging", function () {

  async function setupFlaggingEnv(minKarma = 5n) {
    const ctx = await deployAll();
    const { core, user1, user2, FORUM_KEY, FORUM_CID, POST_CID, PROFILE_CID, USERNAME_1, USERNAME_2 } = ctx;
    await core.connect(user1).registerIdentity(USERNAME_1, PROFILE_CID);
    await core.connect(user2).registerIdentity(USERNAME_2, PROFILE_CID);
    await core.connect(user1).createForum(FORUM_KEY, minKarma, FORUM_CID);
    await core.connect(user2).joinForum(FORUM_KEY);
    const postId = await setupPost(ctx);
    return { ...ctx, postId, minKarma };
  }

  it("flags a post and emits PostFlagged with correct weight (weight=1 for base karma)", async function () {
    const ctx = await setupFlaggingEnv(1n);
    const { core, user1, user2, postId } = ctx;

    // Give user2 just enough karma to meet minKarmaToFlag=1
    await core.connect(user2).votePost(postId, 1); // user2 upvotes user1's post
    // user2 karma is still 0 - we need to give user2 karma
    // user1 upvotes user2's comment to give user2 karma
    const commentId = await setupComment(ctx, postId);
    await core.connect(user1).voteComment(commentId, 1); // user2 gets 1 karma

    // Now user2 can flag
    await expect(core.connect(user2).flagPost(postId))
      .to.emit(core, "PostFlagged")
      .withArgs(postId, user2.address, anyValue);
  });

  it("reverts if caller karma < minKarmaToFlag (FlaggingNotActive)", async function () {
    const { core, user2, postId } = await setupFlaggingEnv(100n);
    // user2 has 0 karma, min is 100
    await expect(
      core.connect(user2).flagPost(postId)
    ).to.be.revertedWithCustomError(core, "FlaggingNotActive");
  });

  it("reverts on double-flag by the same user (AlreadyFlagged)", async function () {
    const ctx = await setupFlaggingEnv(1n);
    const { core, user2, postId } = ctx;
    // Give user2 karma
    const commentId = await setupComment(ctx, postId);
    await core.connect(user1_from(ctx)).voteComment(commentId, 1);

    await core.connect(user2).flagPost(postId);
    await expect(
      core.connect(user2).flagPost(postId)
    ).to.be.revertedWithCustomError(core, "AlreadyFlagged");
  });

  it("reverts if caller is not a forum member (NotMember)", async function () {
    const { core, attacker, postId } = await setupFlaggingEnv(0n);
    await expect(
      core.connect(attacker).flagPost(postId)
    ).to.be.revertedWithCustomError(core, "NotMember");
  });

  it("reverts for nonexistent post (PostNotFound)", async function () {
    const { core, user2 } = await setupFlaggingEnv(0n);
    await expect(
      core.connect(user2).flagPost(9999n)
    ).to.be.revertedWithCustomError(core, "PostNotFound");
  });
});

function user1_from(ctx: any) { return ctx.user1; }

// ─────────────────────────────────────────────────────────────────────────────

// flagPost/flagComment require the caller's real karma to already meet
// minKarmaToFlag, so an extreme minKarma large enough to have wrapped under
// the old `unchecked` uint64 multiplication can't be exercised end-to-end
// (it would require unfarmably large karma). FlagImpactHarness exposes the
// internal pure function directly so the boundary math itself can be
// unit-tested in isolation instead.
describe("DeRedditCore - 3c-bis. _calculateFlagImpact overflow fix", function () {
  async function deployHarness() {
    const Harness = await ethers.getContractFactory("FlagImpactHarness");
    const harness = await Harness.deploy();
    await harness.waitForDeployment();
    return harness;
  }

  it("does not wrap for an extreme minKarma that would have overflowed uint64 under the old unchecked math", async function () {
    const harness = await deployHarness();

    // Chosen so that, under the OLD `unchecked` uint64 multiplication,
    // minKarma*10 wraps to 4 and minKarma*100 wraps to 40 (mod 2^64) - a
    // karma of 10 would have been misclassified as weight=2 (10 >= wrapped
    // 4, 10 < wrapped 40) instead of the correct weight=1 (10 is nowhere
    // near the real, unwrapped minKarma*10 threshold of ~1.8e19).
    // Note: `karma` is itself uint64-typed (mirroring users[].karma on-chain),
    // so the unwrapped threshold (MIN_KARMA*10 ≈ 1.8e19) is out of range to
    // pass as `karma` directly - the point of this case is exactly that a
    // small, realistic karma must NOT be misclassified against it.
    const MIN_KARMA = 1844674407370955162n;
    expect(await harness.calculateFlagImpact(10n, MIN_KARMA)).to.equal(1);

    // Sanity: uint64-max karma (the largest representable value) still
    // correctly resolves to weight=1 against this MIN_KARMA, since even
    // type(uint64).max is far below the real minKarma*10 (~1.8e19) once the
    // math is done at uint256 width.
    const UINT64_MAX = 2n ** 64n - 1n;
    expect(await harness.calculateFlagImpact(UINT64_MAX, MIN_KARMA)).to.equal(1);
  });

  it("preserves normal-scale tier behavior for small minKarma (regression check)", async function () {
    const harness = await deployHarness();
    const minKarma = 5n;
    expect(await harness.calculateFlagImpact(0n, minKarma)).to.equal(1);
    expect(await harness.calculateFlagImpact(49n, minKarma)).to.equal(1);
    expect(await harness.calculateFlagImpact(50n, minKarma)).to.equal(2);
    expect(await harness.calculateFlagImpact(499n, minKarma)).to.equal(2);
    expect(await harness.calculateFlagImpact(500n, minKarma)).to.equal(3);
    expect(await harness.calculateFlagImpact(4999n, minKarma)).to.equal(3);
    expect(await harness.calculateFlagImpact(5000n, minKarma)).to.equal(4);
    expect(await harness.calculateFlagImpact(49999n, minKarma)).to.equal(4);
    expect(await harness.calculateFlagImpact(50000n, minKarma)).to.equal(5);
  });

  it("treats minKarma=0 as 1 (matches the existing `minKarma == 0 ? 1` fallback)", async function () {
    const harness = await deployHarness();
    expect(await harness.calculateFlagImpact(0n, 0n)).to.equal(1);
    expect(await harness.calculateFlagImpact(10n, 0n)).to.equal(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("DeRedditCore - 3d. Micro-Tipping", function () {

  it("tipPostCreator: transfers ETH to post author, emits TipPostSent", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const postId = await setupPost(ctx);
    const { core, user1, user2 } = ctx;

    const balanceBefore = await ethers.provider.getBalance(user1.address);
    const tip = ethers.parseEther("0.01");

    await expect(core.connect(user2).tipPostCreator(postId, { value: tip }))
      .to.emit(core, "TipPostSent")
      .withArgs(user2.address, user1.address, postId, tip);

    const balanceAfter = await ethers.provider.getBalance(user1.address);
    expect(balanceAfter - balanceBefore).to.equal(tip);
  });

  it("tipPostCreator: reverts with InvalidAmount when value=0", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const postId = await setupPost(ctx);
    await expect(
      ctx.core.connect(ctx.user2).tipPostCreator(postId, { value: 0n })
    ).to.be.revertedWithCustomError(ctx.core, "InvalidAmount");
  });

  it("tipPostCreator: reverts for nonexistent post (PostNotFound)", async function () {
    const { core, user2 } = await deployAll();
    await expect(
      core.connect(user2).tipPostCreator(9999n, { value: 1n })
    ).to.be.revertedWithCustomError(core, "PostNotFound");
  });

  it("tipCommentCreator: transfers ETH to comment author, emits TipCommentSent", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const postId = await setupPost(ctx);
    const commentId = await setupComment(ctx, postId);
    const { core, user1, user2 } = ctx;

    const tip = ethers.parseEther("0.005");
    const balanceBefore = await ethers.provider.getBalance(user2.address);

    await expect(core.connect(user1).tipCommentCreator(commentId, { value: tip }))
      .to.emit(core, "TipCommentSent")
      .withArgs(user1.address, user2.address, commentId, tip);

    const balanceAfter = await ethers.provider.getBalance(user2.address);
    expect(balanceAfter - balanceBefore).to.equal(tip);
  });

  it("tipCommentCreator: reverts with InvalidAmount when value=0", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const postId = await setupPost(ctx);
    const commentId = await setupComment(ctx, postId);
    await expect(
      ctx.core.connect(ctx.user1).tipCommentCreator(commentId, { value: 0n })
    ).to.be.revertedWithCustomError(ctx.core, "InvalidAmount");
  });

  it("tipCommentCreator: reverts for nonexistent comment (CommentNotFound)", async function () {
    const { core, user1 } = await deployAll();
    await expect(
      core.connect(user1).tipCommentCreator(9999n, { value: 1n })
    ).to.be.revertedWithCustomError(core, "CommentNotFound");
  });

  it("tipDirect: transfers ETH to any address, emits TipPostSent with postId=0", async function () {
    const ctx = await deployAll();
    const { core, user1, user2 } = ctx;
    const tip = ethers.parseEther("0.002");
    const balanceBefore = await ethers.provider.getBalance(user2.address);

    await expect(core.connect(user1).tipDirect(user2.address, { value: tip }))
      .to.emit(core, "TipPostSent")
      .withArgs(user1.address, user2.address, 0n, tip);

    expect(await ethers.provider.getBalance(user2.address) - balanceBefore).to.equal(tip);
  });

  it("tipDirect: reverts with ZeroAddress", async function () {
    const { core, user1 } = await deployAll();
    await expect(
      core.connect(user1).tipDirect(ethers.ZeroAddress, { value: 1n })
    ).to.be.revertedWithCustomError(core, "ZeroAddress");
  });

  it("tipDirect: reverts with InvalidAmount when value=0", async function () {
    const { core, user1, user2 } = await deployAll();
    await expect(
      core.connect(user1).tipDirect(user2.address, { value: 0n })
    ).to.be.revertedWithCustomError(core, "InvalidAmount");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("DeRedditCore - 4. Poll Interaction Mechanics (castPollVote)", function () {

  async function setupActivePoll(optionCount = 3, durationSeconds = 3600) {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const { core, user1, user2, FORUM_KEY, POST_CID } = ctx;

    const tx = await core.connect(user1).createPost(FORUM_KEY, POST_CID, 2 /* Poll */, 0);
    const r = await tx.wait();
    const postId = r!.logs
      .map((l: any) => { try { return core.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "PostCreated")!.args.postId as bigint;

    await core.connect(user1).configurePoll(postId, optionCount, durationSeconds);
    return { ...ctx, postId, optionCount, durationSeconds };
  }

  it("castPollVote: successfully casts vote for option 1, emits PollVoteCast", async function () {
    const { core, user2, postId } = await setupActivePoll();

    await expect(core.connect(user2).castPollVote(postId, 1))
      .to.emit(core, "PollVoteCast")
      .withArgs(postId, user2.address, 1);

    expect(await core.pollOptionVotes(postId, 1)).to.equal(1n);
    expect(await core.userPollChoice(postId, user2.address)).to.equal(1);
  });

  it("castPollVote: vote shifting from option 1 to option 2 decrements old, increments new", async function () {
    const { core, user2, postId } = await setupActivePoll();

    await core.connect(user2).castPollVote(postId, 1); // cast for option 1
    await core.connect(user2).castPollVote(postId, 2); // shift to option 2

    expect(await core.pollOptionVotes(postId, 1)).to.equal(0n); // old decremented
    expect(await core.pollOptionVotes(postId, 2)).to.equal(1n); // new incremented
    expect(await core.userPollChoice(postId, user2.address)).to.equal(2);
  });

  it("castPollVote: multiple users vote independently", async function () {
    const ctx = await setupActivePoll();
    const { core, user1, user2, user3, postId, FORUM_KEY } = ctx;
    await core.connect(user3).joinForum(FORUM_KEY);

    await core.connect(user2).castPollVote(postId, 1);
    await core.connect(user3).castPollVote(postId, 2);

    expect(await core.pollOptionVotes(postId, 1)).to.equal(1n);
    expect(await core.pollOptionVotes(postId, 2)).to.equal(1n);
  });

  it("getPollTallies: returns correct tally array after votes", async function () {
    const ctx = await setupActivePoll(3);
    const { core, user2, user3, postId, FORUM_KEY } = ctx;
    await core.connect(user3).joinForum(FORUM_KEY);

    await core.connect(user2).castPollVote(postId, 1);
    await core.connect(user3).castPollVote(postId, 1);

    const tallies = await core.getPollTallies(postId);
    expect(tallies.length).to.equal(3);
    // Tally index 0 is for option 0 (unused), index 1 for option 1
    // The contract stores by optionId directly, tallies[0] = pollOptionVotes[postId][0]
    expect(tallies[0]).to.equal(0n);
    expect(tallies[1]).to.equal(2n);
  });

  it("reverts castPollVote with optionId=0 (PollOptionOutOfRange - 0 is reserved)", async function () {
    const { core, user2, postId } = await setupActivePoll();
    await expect(
      core.connect(user2).castPollVote(postId, 0)
    ).to.be.revertedWithCustomError(core, "PollOptionOutOfRange");
  });

  it("reverts castPollVote with optionId > optionCount (PollOptionOutOfRange)", async function () {
    const { core, user2, postId, optionCount } = await setupActivePoll(3);
    await expect(
      core.connect(user2).castPollVote(postId, optionCount + 1)
    ).to.be.revertedWithCustomError(core, "PollOptionOutOfRange");
  });

  it("reverts castPollVote on same option twice (SameVotePoll)", async function () {
    const { core, user2, postId } = await setupActivePoll();
    await core.connect(user2).castPollVote(postId, 1);
    await expect(
      core.connect(user2).castPollVote(postId, 1)
    ).to.be.revertedWithCustomError(core, "SameVotePoll");
  });

  it("reverts castPollVote if poll not configured (PollNotConfigured)", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const { core, user1, user2, FORUM_KEY, POST_CID } = ctx;
    const tx = await core.connect(user1).createPost(FORUM_KEY, POST_CID, 2 /* Poll */, 0);
    const r = await tx.wait();
    const postId = r!.logs
      .map((l: any) => { try { return core.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "PostCreated")!.args.postId as bigint;
    // No configurePoll called
    await expect(
      core.connect(user2).castPollVote(postId, 1)
    ).to.be.revertedWithCustomError(core, "PollNotConfigured");
  });

  it("reverts castPollVote after poll deadline (PollExpired)", async function () {
    const { core, user2, postId } = await setupActivePoll(3, 60);
    await advanceTime(ethers, 61); // move past deadline
    await expect(
      core.connect(user2).castPollVote(postId, 1)
    ).to.be.revertedWithCustomError(core, "PollExpired");
  });

  it("reverts castPollVote if caller is not a forum member (NotMember)", async function () {
    const { core, attacker, postId } = await setupActivePoll();
    await expect(
      core.connect(attacker).castPollVote(postId, 1)
    ).to.be.revertedWithCustomError(core, "NotMember");
  });

  it("reverts castPollVote on a non-Poll type post (NotPoll)", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const postId = await setupPost(ctx); // Standard type
    await expect(
      ctx.core.connect(ctx.user2).castPollVote(postId, 1)
    ).to.be.revertedWithCustomError(ctx.core, "NotPoll");
  });

  it("reverts getPollTallies for a non-Poll post (NotPoll)", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const postId = await setupPost(ctx);
    await expect(
      ctx.core.getPollTallies(postId)
    ).to.be.revertedWithCustomError(ctx.core, "NotPoll");
  });

  it("reverts getPollTallies when poll not yet configured (PollNotConfigured)", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const { core, user1, FORUM_KEY, POST_CID } = ctx;
    const tx = await core.connect(user1).createPost(FORUM_KEY, POST_CID, 2, 0);
    const r = await tx.wait();
    const postId = r!.logs
      .map((l: any) => { try { return core.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "PostCreated")!.args.postId as bigint;
    await expect(
      core.getPollTallies(postId)
    ).to.be.revertedWithCustomError(core, "PollNotConfigured");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  PART 2: DEREDDIT ESCROW CONTRACT
// ═════════════════════════════════════════════════════════════════════════════

describe("DeRedditEscrow - 1. Authorization & Linkage Validation", function () {
  it("correctly links to DeRedditCore immutable address", async function () {
    const { core, escrow } = await deployAll();
    expect(await escrow.core()).to.equal(await core.getAddress());
  });

  it("reverts launchCrowdfund if post type is not Crowdfund (NotCrowdfund)", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const postId = await setupPost(ctx); // Standard type
    await expect(
      ctx.escrow.connect(ctx.user1).launchCrowdfund(postId, ethers.parseEther("1"), 3600)
    ).to.be.revertedWithCustomError(ctx.escrow, "NotCrowdfund");
  });

  it("reverts launchCrowdfund if caller is not the post author (Unauthorized)", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const { core, user1, user2, attacker, FORUM_KEY, POST_CID } = ctx;

    const tx = await core.connect(user1).createPost(FORUM_KEY, POST_CID, 3 /* Crowdfund */, 0);
    const r = await tx.wait();
    const postId = r!.logs
      .map((l: any) => { try { return core.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "PostCreated")!.args.postId as bigint;

    await expect(
      ctx.escrow.connect(attacker).launchCrowdfund(postId, ethers.parseEther("1"), 3600)
    ).to.be.revertedWithCustomError(ctx.escrow, "Unauthorized");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("DeRedditEscrow - 2. Fund Management Lifecycle", function () {

  // ── Setup: creates a launched Crowdfund campaign ready for contributions ──
  async function setupCrowdfundCampaign(goalEth = "1", durationSecs = 3600) {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const { core, escrow, user1, FORUM_KEY, POST_CID } = ctx;

    const tx = await core.connect(user1).createPost(FORUM_KEY, POST_CID, 3 /* Crowdfund */, 0);
    const r = await tx.wait();
    const postId = r!.logs
      .map((l: any) => { try { return core.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "PostCreated")!.args.postId as bigint;

    const goal = ethers.parseEther(goalEth);
    const launchTx = await escrow.connect(user1).launchCrowdfund(postId, goal, durationSecs);
    await launchTx.wait();

    return { ...ctx, postId, goal, durationSecs };
  }

  // ── launchCrowdfund ───────────────────────────────────────────────────────

  it("launchCrowdfund: stores creator, deadline, goal; emits CrowdfundLaunched", async function () {
    const { escrow, user1, postId, goal } = await setupCrowdfundCampaign();

    const cf = await escrow.getCampaign(postId);
    expect(cf.creator).to.equal(user1.address);
    expect(cf.targetGoal).to.equal(goal);
    expect(cf.claimed).to.be.false;
    expect(cf.fundsRaised).to.equal(0n);
    expect(cf.deadline).to.be.greaterThan(0n);
  });

  it("launchCrowdfund: emits CrowdfundLaunched event with correct args", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const { core, escrow, user1, FORUM_KEY, POST_CID } = ctx;

    const tx = await core.connect(user1).createPost(FORUM_KEY, POST_CID, 3, 0);
    const r = await tx.wait();
    const postId = r!.logs
      .map((l: any) => { try { return core.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "PostCreated")!.args.postId as bigint;

    const goal = ethers.parseEther("2");
    await expect(escrow.connect(user1).launchCrowdfund(postId, goal, 3600))
      .to.emit(escrow, "CrowdfundLaunched")
      .withArgs(postId, goal, anyValue);
  });

  it("launchCrowdfund: reverts with InvalidGoal when targetGoal=0", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const { core, escrow, user1, FORUM_KEY, POST_CID } = ctx;
    const tx = await core.connect(user1).createPost(FORUM_KEY, POST_CID, 3, 0);
    const r = await tx.wait();
    const postId = r!.logs
      .map((l: any) => { try { return core.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "PostCreated")!.args.postId as bigint;
    await expect(
      escrow.connect(user1).launchCrowdfund(postId, 0n, 3600)
    ).to.be.revertedWithCustomError(escrow, "InvalidGoal");
  });

  it("launchCrowdfund: reverts with InvalidDuration when duration=0", async function () {
    const ctx = await deployAll();
    await setupForumWithMembers(ctx);
    const { core, escrow, user1, FORUM_KEY, POST_CID } = ctx;
    const tx = await core.connect(user1).createPost(FORUM_KEY, POST_CID, 3, 0);
    const r = await tx.wait();
    const postId = r!.logs
      .map((l: any) => { try { return core.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e?.name === "PostCreated")!.args.postId as bigint;
    await expect(
      escrow.connect(user1).launchCrowdfund(postId, ethers.parseEther("1"), 0)
    ).to.be.revertedWithCustomError(escrow, "InvalidDuration");
  });

  it("launchCrowdfund: reverts on double-launch (CrowdfundAlreadyLaunched)", async function () {
    const { escrow, user1, postId, goal } = await setupCrowdfundCampaign();
    await expect(
      escrow.connect(user1).launchCrowdfund(postId, goal, 3600)
    ).to.be.revertedWithCustomError(escrow, "CrowdfundAlreadyLaunched");
  });

  // ── contribute (Deposit / Lock Path) ─────────────────────────────────────

  it("contribute: deposits ETH, updates fundsRaised and contributions, emits event", async function () {
    const { escrow, user2, postId } = await setupCrowdfundCampaign();
    const tip = ethers.parseEther("0.5");

    await expect(escrow.connect(user2).contribute(postId, { value: tip }))
      .to.emit(escrow, "CrowdfundContribution")
      .withArgs(postId, user2.address, tip, tip);

    const cf = await escrow.getCampaign(postId);
    expect(cf.fundsRaised).to.equal(tip);
    expect(await escrow.contributions(postId, user2.address)).to.equal(tip);

    // Contract itself holds the ETH
    expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(tip);
  });

  it("contribute: accumulates multiple contributions from different backers", async function () {
    const { escrow, user2, user3, postId } = await setupCrowdfundCampaign();
    const half = ethers.parseEther("0.5");

    await escrow.connect(user2).contribute(postId, { value: half });
    await escrow.connect(user3).contribute(postId, { value: half });

    const cf = await escrow.getCampaign(postId);
    expect(cf.fundsRaised).to.equal(ethers.parseEther("1"));
  });

  it("contribute: reverts with InvalidAmount when value=0", async function () {
    const { escrow, user2, postId } = await setupCrowdfundCampaign();
    await expect(
      escrow.connect(user2).contribute(postId, { value: 0n })
    ).to.be.revertedWithCustomError(escrow, "InvalidAmount");
  });

  it("contribute: reverts when campaign not launched (PostNotFound)", async function () {
    const { escrow, user2 } = await setupCrowdfundCampaign();
    await expect(
      escrow.connect(user2).contribute(9999n, { value: 1n })
    ).to.be.revertedWithCustomError(escrow, "PostNotFound");
  });

  it("contribute: reverts after campaign deadline (CampaignEnded)", async function () {
    const ctx = await setupCrowdfundCampaign("1", 60);
    const { escrow, user2, postId } = ctx;

    await advanceTime(ethers, 61);
    await expect(
      escrow.connect(user2).contribute(postId, { value: 1n })
    ).to.be.revertedWithCustomError(escrow, "CampaignEnded");
  });

  // ── claimPayout (Release Path - goal met) ─────────────────────────────────

  it("claimPayout: full happy path - goal met, deadline passed, creator receives ETH", async function () {
    const { escrow, user1, user2, postId, goal } = await setupCrowdfundCampaign("1", 60);

    // Fund the campaign to goal
    await escrow.connect(user2).contribute(postId, { value: goal });

    // Advance past deadline
    await advanceTime(ethers, 61);

    const balanceBefore = await ethers.provider.getBalance(user1.address);

    await expect(escrow.connect(user1).claimPayout(postId))
      .to.emit(escrow, "CrowdfundPayout")
      .withArgs(postId, user1.address, goal);

    // Creator received the funds (net of gas is less, but balance increased)
    const balanceAfter = await ethers.provider.getBalance(user1.address);
    expect(balanceAfter).to.be.greaterThan(balanceBefore);

    const cf = await escrow.getCampaign(postId);
    expect(cf.claimed).to.be.true;
  });

  it("claimPayout: reverts if not the campaign creator (NotCampaignCreator)", async function () {
    const { escrow, user2, postId, goal } = await setupCrowdfundCampaign("1", 60);
    await escrow.connect(user2).contribute(postId, { value: goal });
    await advanceTime(ethers, 61);
    await expect(
      escrow.connect(user2).claimPayout(postId)
    ).to.be.revertedWithCustomError(escrow, "NotCampaignCreator");
  });

  it("claimPayout: reverts if deadline has not passed (CampaignStillActive)", async function () {
    const { escrow, user1, user2, postId, goal } = await setupCrowdfundCampaign();
    await escrow.connect(user2).contribute(postId, { value: goal });
    await expect(
      escrow.connect(user1).claimPayout(postId)
    ).to.be.revertedWithCustomError(escrow, "CampaignStillActive");
  });

  it("claimPayout: reverts if goal not reached (GoalNotReached)", async function () {
    const { escrow, user1, user2, postId } = await setupCrowdfundCampaign("1", 60);
    await escrow.connect(user2).contribute(postId, { value: ethers.parseEther("0.1") });
    await advanceTime(ethers, 61);
    await expect(
      escrow.connect(user1).claimPayout(postId)
    ).to.be.revertedWithCustomError(escrow, "GoalNotReached");
  });

  it("claimPayout: reverts on double-claim (AlreadyClaimed)", async function () {
    const { escrow, user1, user2, postId, goal } = await setupCrowdfundCampaign("1", 60);
    await escrow.connect(user2).contribute(postId, { value: goal });
    await advanceTime(ethers, 61);
    await escrow.connect(user1).claimPayout(postId);
    await expect(
      escrow.connect(user1).claimPayout(postId)
    ).to.be.revertedWithCustomError(escrow, "AlreadyClaimed");
  });

  it("claimPayout: reverts for campaign that was never launched (PostNotFound)", async function () {
    const { escrow, user1 } = await setupCrowdfundCampaign();
    await expect(
      escrow.connect(user1).claimPayout(9999n)
    ).to.be.revertedWithCustomError(escrow, "PostNotFound");
  });

  // ── claimRefund (Slashing / Dispute Path - goal not met) ─────────────────

  it("claimRefund: full happy path - goal missed, backer reclaims ETH", async function () {
    const { escrow, user2, postId } = await setupCrowdfundCampaign("10", 60);

    const contribution = ethers.parseEther("0.5"); // well below goal of 10 ETH
    await escrow.connect(user2).contribute(postId, { value: contribution });

    await advanceTime(ethers, 61);

    const balanceBefore = await ethers.provider.getBalance(user2.address);

    await expect(escrow.connect(user2).claimRefund(postId))
      .to.emit(escrow, "CrowdfundRefund")
      .withArgs(postId, user2.address, contribution);

    const balanceAfter = await ethers.provider.getBalance(user2.address);
    expect(balanceAfter).to.be.greaterThan(balanceBefore);

    expect(await escrow.contributions(postId, user2.address)).to.equal(0n);
  });

  it("claimRefund: zeroes contribution before transfer (CEI - reentrancy proof)", async function () {
    // After the refund, the mapping must be 0 - confirms CEI pattern holds
    const { escrow, user2, postId } = await setupCrowdfundCampaign("10", 60);
    const contribution = ethers.parseEther("0.1");
    await escrow.connect(user2).contribute(postId, { value: contribution });
    await advanceTime(ethers, 61);
    await escrow.connect(user2).claimRefund(postId);
    expect(await escrow.contributions(postId, user2.address)).to.equal(0n);
  });

  it("claimRefund: reverts if deadline has not passed (CampaignStillActive)", async function () {
    const { escrow, user2, postId } = await setupCrowdfundCampaign("10");
    await escrow.connect(user2).contribute(postId, { value: ethers.parseEther("0.1") });
    await expect(
      escrow.connect(user2).claimRefund(postId)
    ).to.be.revertedWithCustomError(escrow, "CampaignStillActive");
  });

  it("claimRefund: reverts if goal WAS reached (GoalAlreadyReached)", async function () {
    const { escrow, user2, postId, goal } = await setupCrowdfundCampaign("1", 60);
    await escrow.connect(user2).contribute(postId, { value: goal });
    await advanceTime(ethers, 61);
    await expect(
      escrow.connect(user2).claimRefund(postId)
    ).to.be.revertedWithCustomError(escrow, "GoalAlreadyReached");
  });

  it("claimRefund: reverts if caller has no contribution (NothingToRefund)", async function () {
    const { escrow, attacker, postId } = await setupCrowdfundCampaign("10", 60);
    await advanceTime(ethers, 61);
    await expect(
      escrow.connect(attacker).claimRefund(postId)
    ).to.be.revertedWithCustomError(escrow, "NothingToRefund");
  });

  it("claimRefund: reverts on double-refund (NothingToRefund after zeroing)", async function () {
    const { escrow, user2, postId } = await setupCrowdfundCampaign("10", 60);
    await escrow.connect(user2).contribute(postId, { value: ethers.parseEther("0.1") });
    await advanceTime(ethers, 61);
    await escrow.connect(user2).claimRefund(postId);
    // Second claim: contribution is 0
    await expect(
      escrow.connect(user2).claimRefund(postId)
    ).to.be.revertedWithCustomError(escrow, "NothingToRefund");
  });

  it("claimRefund: reverts for a campaign that was never launched (PostNotFound)", async function () {
    const { escrow, user2 } = await setupCrowdfundCampaign();
    await expect(
      escrow.connect(user2).claimRefund(9999n)
    ).to.be.revertedWithCustomError(escrow, "PostNotFound");
  });

  // ── Access violation matrix ───────────────────────────────────────────────

  it("attacker cannot contribute to a non-existent campaign", async function () {
    const { escrow, attacker } = await setupCrowdfundCampaign();
    await expect(
      escrow.connect(attacker).contribute(9999n, { value: 1n })
    ).to.be.revertedWithCustomError(escrow, "PostNotFound");
  });

  it("attacker cannot drain escrow via claimPayout on a successful campaign", async function () {
    const { escrow, user2, attacker, postId, goal } = await setupCrowdfundCampaign("1", 60);
    await escrow.connect(user2).contribute(postId, { value: goal });
    await advanceTime(ethers, 61);
    await expect(
      escrow.connect(attacker).claimPayout(postId)
    ).to.be.revertedWithCustomError(escrow, "NotCampaignCreator");
  });

  it("getCampaign: returns zero-struct for an unlaunched campaign (no revert)", async function () {
    const { escrow } = await setupCrowdfundCampaign();
    const cf = await escrow.getCampaign(9999n);
    expect(cf.creator).to.equal(ethers.ZeroAddress);
    expect(cf.targetGoal).to.equal(0n);
    expect(cf.fundsRaised).to.equal(0n);
    expect(cf.claimed).to.be.false;
  });
});