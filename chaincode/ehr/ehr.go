package main

import (
	"encoding/json"
	"fmt"
	"log"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

// EHRContract stores only hash anchors and minimal metadata on-chain.
// Clinical payloads (encrypted, AES-256-GCM) live off-chain.
type EHRContract struct {
	contractapi.Contract
}

// Anchor is the on-chain record (target size well under 500 bytes).
type Anchor struct {
	ID           string `json:"id"`
	PatientRef   string `json:"patientRef"` // pseudonymous identifier
	HashSHA256   string `json:"hashSha256"` // hex digest of the ciphertext
	StorageURI   string `json:"storageUri"`
	ResourceType string `json:"resourceType"` // e.g. Observation, ImagingStudy
	Timestamp    string `json:"timestamp"`
	Signature    string `json:"signature"` // recording clinician signature (base64)
}

// CreateRecord writes a new anchor. Fails if the ID already exists.
func (c *EHRContract) CreateRecord(ctx contractapi.TransactionContextInterface,
	id, patientRef, hashSha256, storageURI, resourceType, timestamp, signature string) error {

	existing, err := ctx.GetStub().GetState(id)
	if err != nil {
		return fmt.Errorf("read failed: %v", err)
	}
	if existing != nil {
		return fmt.Errorf("record %s already exists", id)
	}
	a := Anchor{id, patientRef, hashSha256, storageURI, resourceType, timestamp, signature}
	b, err := json.Marshal(a)
	if err != nil {
		return err
	}
	return ctx.GetStub().PutState(id, b)
}

// ReadRecord returns the anchor for an ID (evaluate-only, no ordering).
func (c *EHRContract) ReadRecord(ctx contractapi.TransactionContextInterface, id string) (*Anchor, error) {
	b, err := ctx.GetStub().GetState(id)
	if err != nil {
		return nil, fmt.Errorf("read failed: %v", err)
	}
	if b == nil {
		return nil, fmt.Errorf("record %s not found", id)
	}
	var a Anchor
	if err := json.Unmarshal(b, &a); err != nil {
		return nil, err
	}
	return &a, nil
}

// CrossRef is written on the REQUESTING cluster after a bridge has fetched and verified an
// anchor that lives on another cluster. It is the audit trail of the cross-cluster read.
type CrossRef struct {
	ID             string `json:"id"`
	SourceCluster  string `json:"sourceCluster"`
	SourceRecordID string `json:"sourceRecordId"`
	SourceHash     string `json:"sourceHash"`
	VerifiedAt     string `json:"verifiedAt"`
	Requester      string `json:"requester"`
}

// CreateCrossRef records a verified cross-cluster access on the local ledger.
func (c *EHRContract) CreateCrossRef(ctx contractapi.TransactionContextInterface,
	id, sourceCluster, sourceRecordID, sourceHash, verifiedAt, requester string) error {
	existing, err := ctx.GetStub().GetState(id)
	if err != nil {
		return fmt.Errorf("read failed: %v", err)
	}
	if existing != nil {
		return fmt.Errorf("crossref %s already exists", id)
	}
	b, err := json.Marshal(CrossRef{id, sourceCluster, sourceRecordID, sourceHash, verifiedAt, requester})
	if err != nil {
		return err
	}
	return ctx.GetStub().PutState(id, b)
}

func main() {
	cc, err := contractapi.NewChaincode(&EHRContract{})
	if err != nil {
		log.Panicf("create chaincode: %v", err)
	}
	if err := cc.Start(); err != nil {
		log.Panicf("start chaincode: %v", err)
	}
}
