//go:build windows

package client

import (
	"fmt"
	"syscall"
	"unsafe"
)

const (
	vkSpace = 0x20

	keyeventfKeyUp = 0x0002
	inputKeyboard  = 1
)

type keyboardInput struct {
	wVk         uint16
	wScan       uint16
	dwFlags     uint32
	time        uint32
	dwExtraInfo uintptr
}

type input struct {
	typeID uint32
	ki     keyboardInput
	pad    uint64
}

var (
	user32            = syscall.NewLazyDLL("user32.dll")
	procGetAsyncState = user32.NewProc("GetAsyncKeyState")
	procSendInput     = user32.NewProc("SendInput")
)

func IsSpaceDown() (bool, error) {
	r1, _, e1 := procGetAsyncState.Call(uintptr(vkSpace))
	if r1 == 0 {
		if e1 != syscall.Errno(0) {
			return false, fmt.Errorf("GetAsyncKeyState failed: %w", e1)
		}
	}
	return (r1 & 0x8000) != 0, nil
}

func SimulateSpacePress() error {
	down := input{typeID: inputKeyboard, ki: keyboardInput{wVk: vkSpace}}
	up := input{typeID: inputKeyboard, ki: keyboardInput{wVk: vkSpace, dwFlags: keyeventfKeyUp}}
	inputs := []input{down, up}

	r1, _, e1 := procSendInput.Call(
		uintptr(len(inputs)),
		uintptr(unsafe.Pointer(&inputs[0])),
		unsafe.Sizeof(inputs[0]),
	)
	if r1 != uintptr(len(inputs)) {
		if e1 != syscall.Errno(0) {
			return fmt.Errorf("SendInput failed: %w", e1)
		}
		return fmt.Errorf("SendInput sent %d/%d events", r1, len(inputs))
	}
	return nil
}
