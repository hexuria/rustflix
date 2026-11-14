// Command-line golden check of the iOS proxy's playlist rewriter against
// the Rust tests' fixtures (see Rustflix/StreamRewriteCheck.swift).
// Build and run: ./run.sh
import Foundation

let (failures, checks) = StreamRewriteCheck.run()
for f in failures { print("FAIL \(f)") }
print(failures.isEmpty ? "PASS \(checks) checks" : "FAIL \(failures.count) of \(checks) checks")
exit(failures.isEmpty ? 0 : 1)
