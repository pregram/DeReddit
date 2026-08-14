# DeReddit User Guide

This guide explains how to install, configure, deploy, and use DeReddit from an end-user perspective. You don't need developer knowledge to follow these steps.

---

## 1. Introduction and system requirements

DeReddit is a decentralized forum platform. Your wallet is your identity: you create posts, join forums, vote, tip, run polls, and launch crowdfund campaigns with it. Content bodies are stored on IPFS, while critical state lives on-chain.

### Minimum requirements

| Requirement | Notes |
|---|---|
| **Node.js** | Node.js 20 LTS or newer recommended |
| **npm** | Installed with Node.js |
| **Docker** | Required for the local PostgreSQL container used by the run scripts |
| **Kubo IPFS daemon** | `ipfs daemon` must be available locally, or configured through the IPFS API URL |
| **MetaMask** | Browser extension wallet application required for transaction signing |
| **Git** | For cloning the repository |

### Wallet and network

- Local Hardhat mode: connect MetaMask to the local RPC endpoint the run script prints or configures. Use a funded Hardhat test account as needed.
- Sepolia mode: connect MetaMask to Sepolia, use a funded Sepolia test wallet, and make sure the contract addresses and RPC URL are configured.

---

## 2. Installation and configuration

### Step 1: clone the repository

```bash
git clone <repository-url>
cd DeReddit
```

### Step 2: install dependencies

The repository uses npm workspaces. From the root directory:

```bash
npm install
```

If workspaces aren't configured, run:

```bash
npm --prefix backend install
npm --prefix frontend install
```

### Step 3: configure environment files

DeReddit uses environment-specific example files. For a local Hardhat stack:

```bash
cp .env.example .env
cp backend/.env.hardhat.example backend/.env
cp frontend/.env.hardhat.example frontend/.env
```

For a Sepolia deployment:

```bash
cp backend/.env.sepolia.example backend/.env
cp frontend/.env.sepolia.example frontend/.env
```

### Key backend variables

| Variable | Purpose |
|---|---|
| `RPC_URL` | Ethereum JSON-RPC endpoint used by the Event Indexer |
| `CORE_CONTRACT_ADDRESS` | Deployed `DeRedditCore` address |
| `ESCROW_CONTRACT_ADDRESS` | Deployed `DeRedditEscrow` address |
| `ORACLE_PRIVATE_KEY` | Private key of the Event Indexer oracle wallet that anchors Merkle roots |
| `DEPLOYMENT_BLOCK` | First block the Event Indexer should process |
| `IPFS_GATEWAY` | IPFS gateway used to fetch content |
| `INDEXER_BATCH_SIZE` | Number of blocks to fetch per `eth_getLogs` batch |
| `INDEXER_BATCH_DELAY_MS` | Delay between Event Indexer batches |
| `API_PORT` | Port for the API Server |

### Key Web Application variables

| Variable | Purpose |
|---|---|
| `VITE_RPC_URL` | Read-only chain RPC endpoint |
| `VITE_CORE_CONTRACT_ADDRESS` | Core contract address |
| `VITE_ESCROW_CONTRACT_ADDRESS` | Escrow contract address |
| `VITE_API_BASE_URL` | API Server base URL |
| `VITE_IPFS_API_URL` | IPFS API endpoint for uploads |
| `VITE_IPFS_GATEWAY_URL` | IPFS gateway URL for fetching content |

> **Note:** Deploying via `npx hardhat run scripts/deploy.ts --network <localhost|sepolia>` automatically writes the deployed Core/Escrow addresses into both `backend/.env` and `frontend/.env`. `scripts/deploy.ts` only needs the root `.env` file when deploying to the `sepolia` network.

---

## 3. Running and deploying the application

DeReddit provides a top-level dispatcher script:

```bash
./run.sh <mode>
```

Available modes:

| Mode | Description |
|---|---|
| `local-hardhat` | Fully local stack: throwaway local Hardhat chain, local-only PostgreSQL, local IPFS daemon, deploy, Event Indexer, API Server, and web application |
| `local-sepolia` | Local services pointed at real Sepolia contracts/data |
| `public-sepolia` | Same as `local-sepolia`, plus Cloudflare tunnels and auto-redeploy of the GitHub Pages web application |

For a first-time local demo, use:

```bash
chmod +x run.sh run-local-hardhat.sh run-local-sepolia.sh run-public-sepolia.sh
./run.sh local-hardhat
```

The script starts all required services in the background and writes logs under:

```text
logs/*.log
```

### Access the application

Open:

```text
http://localhost:5173
```

The API Server health endpoint is available at:

```text
GET <VITE_API_BASE_URL>/health
```

For example, if `API_PORT=4000` and the API runs locally:

```bash
curl http://localhost:4000/health
```

Your backend and web application environment files control the actual port and URL.

### Running against Sepolia

> **Important:** Unlike `local-hardhat` (which deploys fresh contracts automatically on every run), Sepolia modes **never** deploy contracts - they expect contracts to already be live.

Before running a Sepolia mode for the first time, perform a one-time manual contract deployment:

```bash
# 1. Load root environment variables (RPC URL & deployer private key)
set -a; source .env; set +a

# 2. Deploy contracts to Sepolia
npx hardhat run scripts/deploy.ts --network sepolia
```

This writes the newly deployed contract addresses directly into `backend/.env` and `frontend/.env`.

Then launch your desired Sepolia mode:

- For a Sepolia-backed local stack:

   ```bash
   ./run.sh local-sepolia
   ```

- For a publicly exposed Sepolia deployment:

   ```bash
   ./run.sh public-sepolia
   ```

Make sure you have:

- Funded Sepolia wallets
- A valid Sepolia RPC URL
- Deployed contract addresses in the environment files

---

## 4. User workflow and feature guide

![DeReddit Forum Dashboard](./images/dashboard.png)

### Identity and joining forums

1. **Connect a wallet application.** Click the wallet connection button in the web application shell and approve the MetaMask connection request.

2. **Register an identity.** Go to your profile setup, choose a username, and optionally upload/create a profile JSON stored on IPFS. Usernames are unique and can't be changed once registered.

3. **Browse or discover forums.** Use the Discover page to browse, search, and filter forums by category, single tags, or multi-tag AND filtering.

4. **Filter by tag.** Use the tag chip input to filter forums by multiple tags at once. This performs an exact-match, cross-forum AND filter.

5. **Join a forum.** Open a forum page and click Join. You need to join before you can create posts or vote/flag inside that forum.

### Creating and interacting with content

DeReddit supports four post types:

| Post type | Behavior |
|---|---|
| **Standard** | Normal title/body/media post |
| **Time Capsule** | Content stays locked until the configured `visibleAfter` timestamp |
| **Poll** | Author defines options and a deadline; users vote on-chain |
| **Crowdfund** | Author sets a funding goal and deadline; users contribute ETH |

#### Creating a post

1. Enter a forum and click Submit or New Post.
2. Choose a post type.
3. Fill in title, body, and any media/content.
4. Submit the transaction.

##### Poll posts

After the initial `createPost` transaction, the author has to complete a second step:

- Use the poll setup form to configure the number of options and the deadline.
- This calls `configurePoll` on-chain.
- Until configured, the poll post is excluded from the public forum feed but stays reachable by direct URL so the author can finish setup.

##### Crowdfund posts

Crowdfund posts also require a second setup step:

- Use the crowdfund setup form to set a target goal in wei and a deadline.
- This calls `DeRedditEscrow.launchCrowdfund`.
- Until launched, the crowdfund post is excluded from the public feed.

#### Voting

- Upvote or downvote posts and comments.
- You can't vote on your own content.
- Downvotes are subject to a karma floor: if a downvote would push the author's karma below zero, it's recorded as a swallowed downvote and doesn't reduce karma.

#### Flagging

- You can flag posts or comments if you're a forum member with enough karma relative to `minKarmaToFlag`.
- Flag impact is weighted from 1 to 5 based on your karma.
- Each wallet can flag a given post or comment only once.

#### Tipping

- Use the tip button on any post or comment to send ETH directly to its author.
- You can also send a direct tip to any address.
- All tips are native ETH transfers on-chain.

### Nested discussions

Comments thread up to three tiers: a top-level comment is tier 1, and replies can reach tier 2 or tier 3. Once a comment is at tier 3, its reply controls are disabled. Comment pagination is done by root thread, so a page boundary never splits a discussion branch.

### Verifying content (Merkle proofs)

DeReddit lets you verify that a post, comment, or forum's content matches a Merkle root anchored on-chain.

![Merkle Audit Modal](./images/audit-modal.png)

1. Open a post, comment, or forum page.
2. Click the Verify / Merkle Audit control.
3. The web application fetches the audit proof from the API Server:
   - `GET /api/audit/posts/:postId`
   - `GET /api/audit/comments/:commentId`
   - `GET /api/audit/forums/:forumKey`
4. The Merkle Audit Modal then:
   - Recomputes the leaf hash from the currently displayed content.
   - Walks the proof against the API-returned root.
   - Independently reads the on-chain anchored root from `DeRedditCore.verifiedDatabaseRoots`.
   - Fetches the content from IPFS and checks it against the API-returned content. If they differ, it fixes the page dynamically to match IPFS-returned content.
5. The modal shows pass or fail or corrected, along with the full proof path for inspection.

This is a trust-but-verify flow: you don't need to trust the API Server or its returned root, because the client checks the root directly against the chain.
