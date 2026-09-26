import assert from "node:assert/strict";
import { classifyProductionRuntimeControl, evaluateBashRuntimePolicy } from "./bash-runtime-policy.js";

const ctx = {
  originPids: [21784],
  cloudflaredPids: [36380],
  serviceNames: ["DevSpaceOrigin"],
  supervisorTaskNames: ["DevSpaceOriginSupervisor"],
};

assert.equal(evaluateBashRuntimePolicy("npm test", ctx).allowed, true);
assert.equal(evaluateBashRuntimePolicy("git status", ctx).allowed, true);

assert.equal(
  classifyProductionRuntimeControl(
    `powershell -ExecutionPolicy Bypass -File "E:\\Code\\devspace\\devspace-src\\.worktrees\\devspace-acbc94e5a7ecb1d1\\scripts\\setup-devspace.ps1"`,
    ctx,
  ) !== null,
  true,
);

assert.equal(
  classifyProductionRuntimeControl(
    `powershell -ExecutionPolicy Bypass -File E:\\Code\\devspace\\setup_devspace.ps1 -Stop`,
    ctx,
  ) !== null,
  true,
);

assert.equal(
  classifyProductionRuntimeControl(
    `powershell -ExecutionPolicy Bypass -File E:\\Code\\devspace\\setup_devspace.ps1`,
    ctx,
  ) !== null,
  true,
);

assert.equal(
  classifyProductionRuntimeControl("Stop-Process -Id 21784 -Force", ctx) !== null,
  true,
);
assert.equal(
  classifyProductionRuntimeControl("taskkill /F /PID 36380", ctx) !== null,
  true,
);
assert.equal(
  classifyProductionRuntimeControl("taskkill /IM cloudflared.exe /F", ctx) !== null,
  true,
);
assert.equal(
  classifyProductionRuntimeControl("Get-Process node | Stop-Process -Force", ctx) !== null,
  true,
);
assert.equal(
  classifyProductionRuntimeControl("sc.exe stop DevSpaceOrigin", ctx) !== null,
  true,
);
assert.equal(
  classifyProductionRuntimeControl("schtasks /Delete /TN DevSpaceOriginSupervisor /F", ctx) !== null,
  true,
);
assert.equal(
  classifyProductionRuntimeControl(
    "powershell -File E:\\Code\\devspace\\devspace-src\\scripts\\operator-stop-devspace.ps1",
    ctx,
  ) !== null,
  true,
);
assert.equal(
  classifyProductionRuntimeControl(
    "powershell -File E:\\Code\\devspace\\devspace-src\\scripts\\install-devspace-supervisor.ps1",
    ctx,
  ) !== null,
  true,
);
assert.equal(
  classifyProductionRuntimeControl(
    "powershell -File E:\\Code\\devspace\\devspace-src\\scripts\\devspace-supervisor.ps1",
    ctx,
  ) !== null,
  true,
);
assert.equal(
  classifyProductionRuntimeControl("Stop-ScheduledTask -TaskName DevSpaceOriginSupervisor", ctx) !== null,
  true,
);
assert.equal(
  classifyProductionRuntimeControl("Disable-ScheduledTask -TaskName DevSpaceOriginUser", ctx) !== null,
  true,
);

assert.equal(classifyProductionRuntimeControl("Stop-Process -Id 99999 -Force", ctx), null);
assert.equal(classifyProductionRuntimeControl("python -m pytest", ctx), null);

const denied = evaluateBashRuntimePolicy("Stop-Process -Id 21784", ctx);
assert.equal(denied.allowed, false);
assert.equal(denied.capability, "production_runtime_control");
