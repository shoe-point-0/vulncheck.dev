package vulndb

import "vulncheck.dev/contract"

func evaluateRanges(ranges []Range, version string) (contract.VersionStatus, *Diagnostic) {
	if _, err := parseSemver(version); err != nil {
		return contract.VersionUnknown, &Diagnostic{Code: "vulndb-version-invalid", Message: "evaluation version is not a supported Go semantic version"}
	}
	if len(ranges) == 0 {
		return contract.VersionUnknown, &Diagnostic{Code: "vulndb-range-missing", Message: "canonical vulnerability record has no supported version range"}
	}
	affected, unknown := false, false
	for _, eventRange := range ranges {
		status, diagnostic := evaluateRange(eventRange, version)
		if diagnostic != nil {
			unknown = true
			continue
		}
		if status == contract.VersionAffected {
			affected = true
		}
	}
	if unknown {
		return contract.VersionUnknown, &Diagnostic{Code: "vulndb-range-invalid", Message: "canonical vulnerability record has an unsupported version range"}
	}
	if affected {
		return contract.VersionAffected, nil
	}
	return contract.VersionNotAffected, nil
}

func evaluateRange(eventRange Range, version string) (contract.VersionStatus, *Diagnostic) {
	if eventRange.Type != "SEMVER" || len(eventRange.Events) == 0 {
		return contract.VersionUnknown, &Diagnostic{Code: "vulndb-range-invalid", Message: "canonical vulnerability range is unsupported"}
	}
	candidate, _ := parseSemver(version)
	affected, open := false, false
	var introduced semanticVersion
	introducedFromZero := false
	var previousEnd *semanticVersion
	for _, event := range eventRange.Events {
		count := nonEmpty(event.Introduced) + nonEmpty(event.Fixed) + nonEmpty(event.LastAffected)
		if count != 1 {
			return contract.VersionUnknown, &Diagnostic{Code: "vulndb-range-invalid", Message: "canonical vulnerability range event is malformed"}
		}
		switch {
		case event.Introduced != "":
			if open {
				return contract.VersionUnknown, &Diagnostic{Code: "vulndb-range-invalid", Message: "canonical vulnerability range has overlapping introduced events"}
			}
			open = true
			if event.Introduced == "0" {
				if previousEnd != nil {
					return contract.VersionUnknown, &Diagnostic{Code: "vulndb-range-invalid", Message: "canonical vulnerability range events are out of order"}
				}
				introducedFromZero = true
				continue
			}
			parsed, err := parseSemver(event.Introduced)
			if err != nil {
				return contract.VersionUnknown, &Diagnostic{Code: "vulndb-range-invalid", Message: "canonical vulnerability range has an invalid introduced version"}
			}
			if previousEnd != nil && compareSemver(parsed, *previousEnd) < 0 {
				return contract.VersionUnknown, &Diagnostic{Code: "vulndb-range-invalid", Message: "canonical vulnerability range events are out of order"}
			}
			introduced = parsed
			introducedFromZero = false
		case event.Fixed != "":
			if !open {
				return contract.VersionUnknown, &Diagnostic{Code: "vulndb-range-invalid", Message: "canonical vulnerability range has an unmatched fixed event"}
			}
			fixed, err := parseSemver(event.Fixed)
			if err != nil {
				return contract.VersionUnknown, &Diagnostic{Code: "vulndb-range-invalid", Message: "canonical vulnerability range has an invalid fixed version"}
			}
			if !introducedFromZero && compareSemver(fixed, introduced) < 0 {
				return contract.VersionUnknown, &Diagnostic{Code: "vulndb-range-invalid", Message: "canonical vulnerability range has a fixed version before its introduction"}
			}
			if (introducedFromZero || compareSemver(candidate, introduced) >= 0) && compareSemver(candidate, fixed) < 0 {
				affected = true
			}
			previousEnd = &fixed
			open = false
		case event.LastAffected != "":
			if !open {
				return contract.VersionUnknown, &Diagnostic{Code: "vulndb-range-invalid", Message: "canonical vulnerability range has an unmatched last affected event"}
			}
			lastAffected, err := parseSemver(event.LastAffected)
			if err != nil {
				return contract.VersionUnknown, &Diagnostic{Code: "vulndb-range-invalid", Message: "canonical vulnerability range has an invalid last affected version"}
			}
			if !introducedFromZero && compareSemver(lastAffected, introduced) < 0 {
				return contract.VersionUnknown, &Diagnostic{Code: "vulndb-range-invalid", Message: "canonical vulnerability range has a last-affected version before its introduction"}
			}
			if (introducedFromZero || compareSemver(candidate, introduced) >= 0) && compareSemver(candidate, lastAffected) <= 0 {
				affected = true
			}
			previousEnd = &lastAffected
			open = false
		}
	}
	if open && (introducedFromZero || compareSemver(candidate, introduced) >= 0) {
		return contract.VersionAffected, nil
	}
	if affected {
		return contract.VersionAffected, nil
	}
	return contract.VersionNotAffected, nil
}

func nonEmpty(value string) int {
	if value == "" {
		return 0
	}
	return 1
}
