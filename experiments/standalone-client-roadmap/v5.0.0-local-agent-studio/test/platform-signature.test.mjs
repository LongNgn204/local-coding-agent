import assert from "node:assert/strict";
import test from "node:test";
import { PlatformSignatureVerifier, validateSignatureMetadata } from "../core/platform-signature.mjs";

const THUMBPRINT = "A1".repeat(20);

test("Windows verifier requires a valid publisher and thumbprint", async () => {
  const calls = [];
  const verifier = new PlatformSignatureVerifier({
    runner: async (request) => {
      calls.push(request);
      return {
        code: 0,
        stdout: JSON.stringify({
          Status: "Valid",
          Publisher: "Local Coding Agent",
          Subject: "CN=Local Coding Agent, O=Local Coding Agent",
          Thumbprint: THUMBPRINT
        }),
        stderr: ""
      };
    }
  });

  const result = await verifier.verify({
    file: "C:\\release\\Local Agent Studio.exe",
    platform: "win32",
    signature: { type: "authenticode", publisher: "local coding agent", thumbprints: [THUMBPRINT] }
  });

  assert.equal(result.verified, true);
  assert.equal(result.publisher, "Local Coding Agent");
  assert.equal(result.thumbprint, THUMBPRINT);
  assert.equal(calls[0].env.LCA_SIGNATURE_FILE, "C:\\release\\Local Agent Studio.exe");
  assert.equal(calls[0].args.includes("C:\\release\\Local Agent Studio.exe"), false);
});

test("Windows verifier rejects a publisher mismatch", async () => {
  const verifier = new PlatformSignatureVerifier({
    runner: async () => ({
      code: 0,
      stdout: JSON.stringify({ Status: "Valid", Publisher: "Different Publisher", Thumbprint: THUMBPRINT }),
      stderr: ""
    })
  });

  await assert.rejects(() => verifier.verify({
    file: "release.exe",
    platform: "win32",
    signature: { type: "authenticode", publisher: "Local Coding Agent", thumbprints: [] }
  }), /publisher does not match/);
});

test("macOS verifier requires the signed TeamIdentifier", async () => {
  let call = 0;
  const verifier = new PlatformSignatureVerifier({
    runner: async () => {
      call += 1;
      return call === 1
        ? { code: 0, stdout: "", stderr: "valid on disk" }
        : { code: 0, stdout: "", stderr: "Authority=Developer ID Application\nTeamIdentifier=AB12CD34EF\n" };
    }
  });

  const result = await verifier.verify({
    file: "/release/Local Agent Studio.app",
    platform: "darwin",
    signature: { type: "apple-codesign", teamId: "AB12CD34EF" }
  });

  assert.equal(result.verified, true);
  assert.equal(result.teamId, "AB12CD34EF");
  assert.equal(call, 2);
});

test("platform signature metadata is normalized and rejects unsafe policies", () => {
  assert.deepEqual(validateSignatureMetadata({
    type: "authenticode",
    publisher: " Local Coding Agent ",
    thumbprints: [`${THUMBPRINT.slice(0, 20)} ${THUMBPRINT.slice(20)}`]
  }, "win32"), {
    type: "authenticode",
    publisher: "Local Coding Agent",
    thumbprints: [THUMBPRINT]
  });
  assert.throws(() => validateSignatureMetadata({ type: "authenticode" }, "win32"), /requires publisher or thumbprint/);
  assert.throws(() => validateSignatureMetadata({ type: "apple-codesign", teamId: "short" }, "darwin"), /valid apple-codesign/);
});

test("verifier refuses an unconstrained Windows certificate policy", async () => {
  const verifier = new PlatformSignatureVerifier({
    runner: async () => {
      throw new Error("runner must not be called");
    }
  });
  await assert.rejects(() => verifier.verify({
    file: "release.exe",
    platform: "win32",
    signature: { type: "authenticode", publisher: "", thumbprints: [] }
  }), /requires publisher or thumbprint/);
});
