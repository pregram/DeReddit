// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Test-only harness exposing DeRedditCore's internal _calculateFlagImpact so
// its uint64-overflow fix can be unit-tested directly against boundary
// values that aren't reachable through flagPost() (which requires the
// caller's real karma to already meet minKarmaToFlag, making the extreme
// minKarma values needed to exercise the old wraparound bug unfarmable in a
// test). Not deployed by scripts/deploy.ts or referenced by copy-abis.js.
import "../DeRedditCore.sol";

contract FlagImpactHarness is DeRedditCore {
    constructor() DeRedditCore(msg.sender) {}

    /// @notice Exposes DeRedditCore's internal _calculateFlagImpact for direct unit testing.
    /// @param karma Flagger's karma.
    /// @param minKarma Forum's minKarmaToFlag.
    /// @return Flag weight, 1-5.
    function calculateFlagImpact(uint64 karma, uint64 minKarma) external pure returns (uint8) {
        return _calculateFlagImpact(karma, minKarma);
    }
}
