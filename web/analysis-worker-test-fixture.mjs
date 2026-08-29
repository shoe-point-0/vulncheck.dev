export const capabilityReport = Object.freeze({
  schema_version: "v1",
  selected_profile: "baseline-worker",
  selected_fallback: "in-memory-blob-storage",
  features: Object.freeze([])
});

export function snapshot() {
  return Object.freeze({
    schema_version: "v1",
    assurance: "project-evidence",
    bundle_digest: `sha256:${"a".repeat(64)}`,
    build_profile: Object.freeze({ goos: "linux", goarch: "amd64" }),
    roots: Object.freeze(["example.com/project"]),
    package_inventory: Object.freeze([
      Object.freeze({
        path: "example.com/project/dep",
        module_path: "example.com/project",
        module_version: "devel",
        imports: Object.freeze([]),
        files: Object.freeze(["sources/dep.go"])
      }),
      Object.freeze({
        path: "example.com/project",
        module_path: "example.com/project",
        module_version: "devel",
        imports: Object.freeze(["example.com/project/dep"]),
        files: Object.freeze(["sources/main.go"])
      })
    ]),
    content: Object.freeze([Object.freeze({ path: "sources/main.go" })])
  });
}
