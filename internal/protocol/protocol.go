package protocol

import (
	"encoding/json"
	"fmt"
)

const (
	TypeHello   = "hello"
	TypeSpace   = "space"
	TypeTrigger = "trigger"
)

type Message struct {
	Type string `json:"type"`
	Name string `json:"name,omitempty"`
	From string `json:"from,omitempty"`
	At   int64  `json:"at,omitempty"`
}

func Encode(msg Message) ([]byte, error) {
	b, err := json.Marshal(msg)
	if err != nil {
		return nil, fmt.Errorf("marshal message: %w", err)
	}
	return b, nil
}

func Decode(line []byte) (Message, error) {
	var msg Message
	if err := json.Unmarshal(line, &msg); err != nil {
		return Message{}, fmt.Errorf("unmarshal message: %w", err)
	}
	return msg, nil
}
