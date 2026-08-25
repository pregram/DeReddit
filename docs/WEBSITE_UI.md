# DeReddit Website & UI Showcase

Because the self-hosted backend (API server and indexer) may not always be running for the GitHub Pages live link, this document provides a visual tour of the DeReddit application, its key interface components, and core user workflows.


includes interactions with DeReddit platform:

- website navigation
- content creation & interaction by connected users only.
- Content integrity verification
- user profile & notifications

**Note:**
Clicking the `$` button opens your pending transaction queue. Because blockchain writes take time to finalize, this runs in the background so you can keep reading posts or browsing forums while your transaction processes.

---

## Homepage

Displays popular forums/communities, click to explore their feeds.

**Features:**

- Connect a wallet button.
- dark/light mode toggle.
- [Create a forum](#create-a-forum)
- [Discover forums](#discover-forums).

![Homepage](./images/dashboard.png)

**Features** for a **connected user:**

- [Navigate to user profile](#user-profile--badges). The button with a user profile picture & username & karma displayed.
- Recommended Forums to join(user is not a member). Recommendation based on tag overlap with already joined forums.
- [Notifications](#notifications) includes recieved badges, tips.

![Homepage02](./images/Homepage02.png)

---

## Discover Forums

Displays all forums matching your query, click to explore their feeds.

**Search** for forums by:

- title
- category
- tags - displays a list of existing tags once typing & can select multiple at once see 2nd image below.

**Sort** by:

- engagement
- members
- Creation (newest first)

Initially 10 forums are displayed, once user scrolls past them the next forums are fetched dynamically.

![Discover01](./images/Discover01.png)

![Discover02](./images/Discover02.png)

---

## Forum Feed

**Features:**

- Forum details seen in image below 
- filter posts by type, title. Sort by closest poll/crowdfund deadline first or newest first.
- click on a post to explore [post feed](#post-feed)
- click on usernames & their profile picture to visit that [user's profile](#user-profile--badges)
- [Verify content integrity](#content-integrity-verification)
- [Join a forum](#join-a-forum)

![Forum feed](./images/Forum01.png)

![Forum feed](./images/Forum02.png)

---

## Post Feed

**Features:**

- tip post creator
- click on usernames & their profile picture to visit that [user's profile](#user-profile--badges)
- [Verify content integrity](#content-integrity-verification)

![Post feed](./images/Post01.png)
![Post feed](./images/Post02.png)

**connected user features:**

- can tip, flag, [verify](#content-integrity-verification) a comment
- view how much you've tipped a post
- view how much you've tipped a comment
- view which option you chose for a poll
- view which much you've contributed to a crowdfund

![comment feed](./images/Comments02.png)

---

## Create a Forum

![Create a Forum](./images/CreateForum.png)

---

## Join a Forum

![Join a Forum](./images/JoinForum.png)

---

## Create a Post

Create a post that can be either one of the following types:
- Standard - includes text, body, image.
- Poll - additionally includes poll options, deadline filled in the next step.
- Crowdfund - additionally includes deadline, target goal filled in the next step.
- TimeCapsule - additionally includes a reveal date. 


![Create a Post](./images/CreatePost01.png)

![Create a Poll](./images/CreatePost02.png)

For types that include a next step a pop up is displayed containing details to be filled:

![Create a Crowdfund](./images/CreateCrowdfund01.png)

![Create a Crowdfund](./images/CreateCrowdfund02.png)

---

## Create a Comment/Reply

You can create a comment under a post via `post comment` button.

or create a reply to a comment via `reply` button.

![Create a Comment](./images/CreateComment.png)


---

## Content integrity verification

Demonstrates client-side verification where forum/post/comment content are verified directly against the Merkle root anchored on the Sepolia testnet.

**Verification Outcomes:**
- Green: content was not modified by server.
- Yellow: blockchain's root matches yet the content sent by server doesn't match IPFS stored content(content displayed from IPFS).
- Red: blockchain's root doesn't match, server content cannot be trusted.

![Merkle Audit Modal](./images/audit-modal.png)

---

## User Profile & Badges 

**Features:**

- view badges a user recieved & tooltip upon hover
- view a user's karma(earned when others upvote your content, decreases upon downvote)
- click to visit forums user has joined
- click to visit posts/comments user has created
- click to visit contributions a user has made to crowdfunds

**connected user can:**

- register a username - 1st image below
- change avatar(profile picture) - last image below
- edit preferences - 2nd image below
- tip & view how much he tipped a user when visiting the other user's profile page - 3rd image below

![New User Profile](./images/NewUserProfile.png)

![User Profile](./images/Profile01.png)
![User Profile Tip](./images/Profile02.png)
![User Profile Contributions](./images/Profile03.png)


## Notifications

pop up upon reciving a tip, or a badge, can mark them as read, delete them via providing a signature that you're indeed the user who created them.

![Notifications](./images/Notifications.png)

![Notifications pop up](./images/Notifications02.png)

