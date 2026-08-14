// src/lib/postType.ts - Mirrors the PostType enum order in DeRedditTypes.sol
// and backend/src/abis.ts's POST_TYPE map. Kept as a plain object rather than
// a TS `enum` since enums aren't erasable syntax under this project's
// tsconfig (erasableSyntaxOnly).

export const POST_TYPE_ENUM = {
  Standard: 0,
  TimeCapsule: 1,
  Poll: 2,
  Crowdfund: 3,
} as const;

export type PostTypeKey = keyof typeof POST_TYPE_ENUM;