package vulndb

import (
	"fmt"
	"strconv"
	"strings"
)

// semanticVersion implements the Go-compatible subset of SemVer required by
// OSV SEMVER events, including prereleases and pseudo-version prereleases.
type semanticVersion struct {
	major      uint64
	minor      uint64
	patch      uint64
	preRelease []string
}

func parseSemver(value string) (semanticVersion, error) {
	if strings.HasPrefix(value, "v") {
		value = value[1:]
	}
	if value == "" {
		return semanticVersion{}, fmt.Errorf("version is empty")
	}
	withoutBuild, build, hasBuild := strings.Cut(value, "+")
	if hasBuild {
		if build == "" || strings.Contains(build, "+") {
			return semanticVersion{}, fmt.Errorf("build metadata is invalid")
		}
		for _, identifier := range strings.Split(build, ".") {
			if !validIdentifier(identifier) {
				return semanticVersion{}, fmt.Errorf("build metadata is invalid")
			}
		}
	}
	core, prerelease, hasPreRelease := strings.Cut(withoutBuild, "-")
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return semanticVersion{}, fmt.Errorf("version core is incomplete")
	}
	parsed := semanticVersion{}
	values := []*uint64{&parsed.major, &parsed.minor, &parsed.patch}
	for index, part := range parts {
		if !decimalIdentifier(part) || (len(part) > 1 && part[0] == '0') {
			return semanticVersion{}, fmt.Errorf("version core is invalid")
		}
		number, err := strconv.ParseUint(part, 10, 64)
		if err != nil {
			return semanticVersion{}, fmt.Errorf("version core is invalid")
		}
		*values[index] = number
	}
	if hasPreRelease {
		if prerelease == "" {
			return semanticVersion{}, fmt.Errorf("prerelease is empty")
		}
		for _, identifier := range strings.Split(prerelease, ".") {
			if !validIdentifier(identifier) || (decimalIdentifier(identifier) && len(identifier) > 1 && identifier[0] == '0') {
				return semanticVersion{}, fmt.Errorf("prerelease is invalid")
			}
			parsed.preRelease = append(parsed.preRelease, identifier)
		}
	}
	return parsed, nil
}

func normalizeToolchainVersion(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(value, "go") {
		value = strings.TrimPrefix(value, "go")
	}
	if value == "" || strings.Contains(value, " ") {
		return "", false
	}
	base, suffix, hasSuffix := strings.Cut(value, "-")
	parts := strings.Split(base, ".")
	if len(parts) == 2 {
		for _, marker := range []string{"rc", "beta"} {
			if position := strings.Index(parts[1], marker); position > 0 {
				serial := parts[1][position+len(marker):]
				if !decimalIdentifier(serial) {
					return "", false
				}
				normalized := "v" + parts[0] + "." + parts[1][:position] + ".0-" + marker + "." + serial
				if _, err := parseSemver(normalized); err != nil {
					return "", false
				}
				return normalized, true
			}
		}
	}
	if len(parts) == 2 {
		base += ".0"
	}
	if len(parts) < 2 || len(parts) > 3 {
		return "", false
	}
	if hasSuffix {
		value = base + "-" + suffix
	} else {
		value = base
	}
	normalized := "v" + value
	if _, err := parseSemver(normalized); err != nil {
		return "", false
	}
	return normalized, true
}

func compareSemver(left, right semanticVersion) int {
	for _, pair := range [][2]uint64{{left.major, right.major}, {left.minor, right.minor}, {left.patch, right.patch}} {
		if pair[0] < pair[1] {
			return -1
		}
		if pair[0] > pair[1] {
			return 1
		}
	}
	if len(left.preRelease) == 0 && len(right.preRelease) == 0 {
		return 0
	}
	if len(left.preRelease) == 0 {
		return 1
	}
	if len(right.preRelease) == 0 {
		return -1
	}
	for index := 0; index < len(left.preRelease) && index < len(right.preRelease); index++ {
		leftPart, rightPart := left.preRelease[index], right.preRelease[index]
		if leftPart == rightPart {
			continue
		}
		leftNumeric, rightNumeric := decimalIdentifier(leftPart), decimalIdentifier(rightPart)
		switch {
		case leftNumeric && rightNumeric:
			leftNumber, _ := strconv.ParseUint(leftPart, 10, 64)
			rightNumber, _ := strconv.ParseUint(rightPart, 10, 64)
			if leftNumber < rightNumber {
				return -1
			}
			return 1
		case leftNumeric:
			return -1
		case rightNumeric:
			return 1
		case leftPart < rightPart:
			return -1
		default:
			return 1
		}
	}
	if len(left.preRelease) < len(right.preRelease) {
		return -1
	}
	if len(left.preRelease) > len(right.preRelease) {
		return 1
	}
	return 0
}

func decimalIdentifier(value string) bool {
	if value == "" {
		return false
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return false
		}
	}
	return true
}

func validIdentifier(value string) bool {
	if value == "" {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'A' || character > 'Z') && (character < 'a' || character > 'z') && character != '-' {
			return false
		}
	}
	return true
}
