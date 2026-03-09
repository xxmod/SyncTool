//go:build !windows

package client

import "errors"

func IsSpaceDown() (bool, error) {
	return false, errors.New("global keyboard detection is only implemented on windows")
}

func SimulateSpacePress() error {
	return errors.New("keyboard simulation is only implemented on windows")
}
