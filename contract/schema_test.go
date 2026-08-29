package contract

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestJSONSchemaMatchesRequiredReportVocabularies(t *testing.T) {
	contents, err := os.ReadFile("../schemas/analysis-report-v1.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	var schema map[string]any
	if err := json.Unmarshal(contents, &schema); err != nil {
		t.Fatalf("schema is invalid json: %v", err)
	}
	properties := schema["properties"].(map[string]any)
	assertEnum(t, properties["version"], []string{"affected", "not-affected", "unknown"})
	assertEnum(t, properties["reachability"], []string{"reachable", "no-static-path-found", "inconclusive"})
	assertEnum(t, properties["rules"], []string{"finding", "suppressed-finding", "no-finding", "not-analyzed"})
	definitions := schema["$defs"].(map[string]any)
	assertEnum(t, definitions["integrity"], []string{"verified", "unverified", "failed"})
	assertEnum(t, properties["freshness"], []string{"current", "stale", "unknown"})
}

func assertEnum(t *testing.T, raw any, want []string) {
	t.Helper()
	object := raw.(map[string]any)
	properties := object["properties"].(map[string]any)
	status := properties["status"].(map[string]any)
	rawEnum := status["enum"].([]any)
	got := make([]string, len(rawEnum))
	for index, value := range rawEnum {
		got[index] = value.(string)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("schema enum = %v, want %v", got, want)
	}
}
