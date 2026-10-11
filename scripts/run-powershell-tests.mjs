import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

if (process.platform !== "win32") {
  console.log("Skipping Windows PowerShell setup tests on non-Windows host.");
  process.exit(0);
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const testPath = path.join(scriptDirectory, "setup-devspace.Tests.ps1");
const escapedTestPath = testPath.replaceAll("'", "''");
const command = [
  // This suite uses Pester 3 assertion/mocking syntax. Pin the built-in
  // Windows PowerShell version instead of silently selecting CI's Pester 5.
  "Import-Module Pester -RequiredVersion 3.4.0 -ErrorAction Stop",
  "$version = (Get-Module Pester).Version.Major",
  `if ($version -ge 5) { $result = Invoke-Pester -Path '${escapedTestPath}' -PassThru } else { $result = Invoke-Pester -Script '${escapedTestPath}' -PassThru }`,
  "if ($result.FailedCount -gt 0) { exit 1 }",
].join("; ");

const result = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
  { stdio: "inherit" },
);

if (result.error) {
  console.error(`Failed to launch PowerShell tests: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
