// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Criminal Investigation Chain Record Registry
/// @notice Solidity research contract for registering synthetic investigation-record metadata.
/// @dev The protected narrative stays in the browser. Only its SHA-256 hash is stored.
contract CrimeRecords {
    error OwnerOnly();
    error OfficerOnly();
    error EmptyValue();
    error DuplicateRecord(string recordId);
    error UnknownRecord(string recordId);

    struct Record {
        string recordId;
        string caseId;
        string recordType;
        string sensitivity;
        bytes32 contentHash;
        address filedBy;
        uint64 filedAt;
    }

    address public immutable owner;
    uint256 public totalRecords;
    mapping(address => bool) public officers;
    mapping(bytes32 => Record) private records;
    string[] private recordIds;

    event OfficerUpdated(address indexed account, bool authorized);
    event RecordFiled(
        bytes32 indexed recordKey,
        string recordId,
        string caseId,
        bytes32 indexed contentHash,
        address indexed filedBy
    );

    constructor() {
        owner = msg.sender;
        officers[msg.sender] = true;
        emit OfficerUpdated(msg.sender, true);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OwnerOnly();
        _;
    }

    modifier onlyOfficer() {
        if (!officers[msg.sender]) revert OfficerOnly();
        _;
    }

    function setOfficer(address account, bool authorized) external onlyOwner {
        if (account == address(0)) revert EmptyValue();
        officers[account] = authorized;
        emit OfficerUpdated(account, authorized);
    }

    function fileRecord(
        string calldata recordId,
        string calldata caseId,
        string calldata recordType,
        string calldata sensitivity,
        bytes32 contentHash
    ) external onlyOfficer {
        if (
            bytes(recordId).length == 0 ||
            bytes(caseId).length == 0 ||
            bytes(recordType).length == 0 ||
            bytes(sensitivity).length == 0 ||
            contentHash == bytes32(0)
        ) revert EmptyValue();

        bytes32 recordKey = keyFor(recordId);
        if (bytes(records[recordKey].recordId).length != 0) {
            revert DuplicateRecord(recordId);
        }

        records[recordKey] = Record({
            recordId: recordId,
            caseId: caseId,
            recordType: recordType,
            sensitivity: sensitivity,
            contentHash: contentHash,
            filedBy: msg.sender,
            filedAt: uint64(block.timestamp)
        });
        recordIds.push(recordId);
        totalRecords += 1;

        emit RecordFiled(recordKey, recordId, caseId, contentHash, msg.sender);
    }

    function getRecord(string calldata recordId) external view returns (Record memory) {
        Record memory item = records[keyFor(recordId)];
        if (bytes(item.recordId).length == 0) revert UnknownRecord(recordId);
        return item;
    }

    function getRecordIdAt(uint256 index) external view returns (string memory) {
        return recordIds[index];
    }

    function recordExists(string calldata recordId) external view returns (bool) {
        return bytes(records[keyFor(recordId)].recordId).length != 0;
    }

    function keyFor(string memory recordId) public pure returns (bytes32) {
        return keccak256(bytes(recordId));
    }
}
