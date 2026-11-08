// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title RecordAnchor
/// @notice Publishes the Merkle root of a batch of VesTally seals. That's all it does.
/// @dev No storage, no owner, no upgrade, no funds. Anyone may call it: a root proves nothing on
///      its own, only together with a Merkle path to a leaf someone already holds. Arguments are
///      fixed-size hashes, so nobody can use this contract to put words, links or images on-chain.
contract RecordAnchor {
    /// @param submitter who paid for the commit (the VesTally relayer, or anyone else)
    /// @param root Merkle root of the batch (sorted-pair keccak256, OpenZeppelin MerkleProof compatible)
    /// @param count number of leaves in the batch
    /// @param manifestDigest keccak256 of every leaf in order, so the batch can be rebuilt independently
    event Anchored(address indexed submitter, bytes32 indexed root, uint256 count, bytes32 manifestDigest);

    error EmptyBatch();
    error ZeroRoot();

    function anchor(bytes32 root, uint256 count, bytes32 manifestDigest) external {
        if (root == bytes32(0)) revert ZeroRoot();
        if (count == 0) revert EmptyBatch();
        emit Anchored(msg.sender, root, count, manifestDigest);
    }
}
