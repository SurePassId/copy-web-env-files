# Known defects: `copy-web-env-files`

Recorded: 2026-08-12 · Reviewed at commit `0420236` (`main`, after the node24 runtime bump)

These were found while bumping the action runtime from `node16` to `node24` ([PR #1](https://github.com/SurePassId/copy-web-env-files/pull/1)) and were deliberately left out of that change to keep it reviewable. None of them were introduced by it.

## Scope

Every finding is in [main.js](../main.js) or [action.yaml](../action.yaml). Line references are against commit `0420236`.

## Behavior contract

The intended behavior, stated up front because several findings below only make sense against it:

| Condition                                         | Expected outcome                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| `environment-files/<env>/` does not exist         | **Success.** Nothing to overlay. Log it and exit `0`.                         |
| A given source file is absent from that directory | **Success.** That file simply is not overlaid. Skip it.                       |
| A source file exists but the copy fails           | **Failure.** Permissions, file in use, unwritable or uncreatable destination. |
| A required input is missing                       | **Failure.**                                                                  |

A missing _source_ is a normal, expected state and must never fail the step. Every "fail the step" recommendation below applies only to the third and fourth rows.

## Executive summary

The action's entire job is to overlay environment-specific configuration onto a build before it is deployed. **It cannot currently report a failure to do that.** D1 and D2 together mean a copy that fails for any reason — a missing _destination_ directory, permissions, a file in use — logs `Copied ...` and exits green. D3 is a concrete case where that is happening silently today.

Everything else is secondary to fixing that.

---

## D1. High: copy failures are silently swallowed

`fs.copyFile(source, destination, callback)` invokes its callback with an `Error` as the first argument on failure. All three callbacks here declare **no parameters** and unconditionally log success:

[lines 16-18](../main.js#L16-L18), [lines 25-27](../main.js#L25-L27), [lines 34-36](../main.js#L34-L36)

```js
fs.copyFile(webConfigFile, `${destPath}/web.config`, () => {
  console.log(`Copied ${webConfigFile} to ${destPath}/web.config.`);
});
```

The `err` argument is discarded. A copy that fails with `ENOENT`, `EACCES`, or `EBUSY` produces a log line claiming it succeeded, and the step exits `0`.

**Impact:** the calling workflow deploys a build carrying the _wrong_ `web.config` — potentially another environment's connection strings and endpoints — and reports success. There is no signal anywhere in the run.

**Recommendation:** check the error and fail the step. This applies only once a source file has been confirmed to exist — an absent source is skipped before the copy is ever attempted, per the behavior contract. See the rewrite below.

---

## D2. High: the `try`/`catch` cannot catch any I/O error

[lines 5-45](../main.js#L5-L45) wrap the whole body, and [line 44](../main.js#L44) calls `core.setFailed(error.message)`.

The `try` block only covers the **synchronous scheduling** of the callbacks. By the time any callback runs, the `try` has already exited, so a throw inside one propagates as an uncaught exception rather than into `catch`. `core.setFailed` is effectively unreachable for the failures it was written to handle.

This is why D1 has no backstop.

**Recommendation:** convert to `node:fs/promises` with a single `async` entry point and one rejection handler. `try`/`catch` then covers what it appears to cover.

---

## D3. Medium: the `site.lic` destination assumes a `bin/` directory

[line 34](../main.js#L34) copies to `${destPath}/bin/site.lic`, but nothing creates `bin/` and nothing verifies it exists.

Against the current callers in `SurePassId/github-workflows`:

| Caller                        | `path` input                   | Has a `bin/` subdirectory?                                        |
| ----------------------------- | ------------------------------ | ----------------------------------------------------------------- |
| `build-dot-net-fwk.yaml`      | `/published`                   | Yes — MSBuild `_PackageTempDir` layout                            |
| `build-deploy-sandboxvm.yaml` | `${{ env.PUBLISH_DIR }}`       | Yes — framework-only since the `DOT_NET_TYPE` condition was added |
| `build-dot-net6.yaml`         | `${{ env.DOTNET_ROOT }}/myapp` | **No** — `dotnet publish` output is flat                          |
| `build-dot-net8.yaml`         | `${{ env.DOTNET_ROOT }}/myapp` | **No** — `dotnet publish` output is flat                          |

So for the two .NET Core build workflows, a `site.lic` in `environment-files/<env>/` fails to copy with `ENOENT` **every single time**, and D1 hides it.

Note which side is at fault: the **source** `site.lic` exists, and the **destination** directory does not. This is the third row of the behavior contract, not the second — the file was meant to be overlaid and was not.

**Recommendation:** `fs.mkdir(dirname, { recursive: true })` before each copy. That is correct for both layouts and removes the asymmetry.

---

## D4. Medium: the input defaults are unsafe

[action.yaml](../action.yaml):

```yaml
deployment-environment:
  required: true
  default: "prod"
path:
  required: true
  default: "/"
```

`required: true` on an action input is **advisory** — the runner does not enforce it and does not fail when the input is omitted. The `default` is what actually applies. So:

- omitting `deployment-environment` silently overlays **production** configuration;
- omitting `path` copies to the **filesystem root** of the current drive.

All four current callers pass both inputs, so neither default is exercised today. This is a trap for the next caller, not a live failure.

**Recommendation:** delete both `default:` lines, and read the inputs with `core.getInput(name, { required: true })`, which _does_ throw. The declared `required: true` then becomes true in practice.

---

## D5. Medium: path handling is string concatenation with an implicit working directory

[line 9](../main.js#L9) builds the source directory as a workspace-relative string:

```js
const envDir = `environment-files/${env}`;
```

This resolves against the process working directory, which the runner sets to `GITHUB_WORKSPACE`. Destinations, meanwhile, are built by concatenating an **absolute** `path` input with `/` separators. The two halves use different conventions, and neither goes through `path.join`.

It works on Windows because the API accepts forward slashes, but it makes `..` traversal in an input silently effective and makes the CWD dependency invisible to a reader.

**Recommendation:** use `path.join` throughout, and state the `GITHUB_WORKSPACE` assumption in [README.md](../README.md).

---

## D6. Low: `fs.exists` is deprecated and creates a check-then-copy gap

[lines 11](../main.js#L11), [14](../main.js#L14), [23](../main.js#L23), [32](../main.js#L32).

`fs.exists` has been deprecated since Node v1.0.0 in favour of `fs.access` / `fs.stat`. Its callback signature `(exists)` is the only one in the callback API with no error-first argument — which is precisely the design that invited D1.

It is still functional on Node 24, so this is not urgent, but it should not survive a runtime modernization.

**Recommendation:** replace with an `fs.access`-based helper. Keep the pre-check rather than letting the copy fail and inspecting `ENOENT` — an explicit existence test is what makes "no source file" a deliberate skip instead of a swallowed error, which is the distinction D1 got wrong.

---

## D7. Low: the "nothing to overlay" message is mislabelled and invisible

[line 40](../main.js#L40) emits `console.log('WARNING: ...')`. That is ordinary stdout — it does not surface in the run summary and is easy to miss in a long log.

The `WARNING:` prefix is also wrong. Per the behavior contract, an absent `environment-files/<env>/` is a normal state, not a problem, so this should not read as one — and it should not become a `core.warning()` annotation either, because that would put a yellow marker on every run of every repository that has no overlays.

**Recommendation:** `core.info()` with neutral wording, plus a closing summary line reporting how many files were overlaid. That gives the operator a positive signal of what happened without annotating a non-event. Reserve `core.warning()` for genuinely suspicious states if any are identified later.

---

## D8. Low: unused dependency

[line 2](../main.js#L2) requires `@actions/github`; it is never referenced. It is declared in [package.json](../package.json) and vendored into the committed `node_modules`.

The pinned dependencies (`@actions/core` `^1.9.1`, `@actions/github` `^5.0.3`) also predate 2023.

**Recommendation:** drop the `@actions/github` require and dependency, refresh `@actions/core`, and consider bundling with `@vercel/ncc` so a single `dist/index.js` is committed instead of the whole `node_modules` tree.

---

## Suggested rewrite

Addresses D1, D2, D3, D5, D6, D7, and D8 in one file.

```js
const core = require("@actions/core");
const fs = require("node:fs/promises");
const path = require("node:path");

const FILES_TO_COPY = [
  { source: "web.config", destination: "web.config" },
  {
    source: "ApplicationInsights.config",
    destination: "ApplicationInsights.config",
  },
  { source: "site.lic", destination: path.join("bin", "site.lic") },
];

async function pathExists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const environment = core.getInput("deployment-environment", {
    required: true,
  });
  const destinationRoot = core.getInput("path", { required: true });
  const sourceDir = path.join("environment-files", environment);

  if (!(await pathExists(sourceDir))) {
    core.info(
      `No environment files to overlay: "${sourceDir}" does not exist.`,
    );
    return;
  }

  let copiedCount = 0;

  for (const entry of FILES_TO_COPY) {
    const sourcePath = path.join(sourceDir, entry.source);

    // An absent source file is a normal state: nothing to overlay for it.
    if (!(await pathExists(sourcePath))) {
      continue;
    }

    const destinationPath = path.join(destinationRoot, entry.destination);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(sourcePath, destinationPath);
    core.info(`Copied ${sourcePath} to ${destinationPath}.`);
    copiedCount += 1;
  }

  core.info(`Overlaid ${copiedCount} file(s) from "${sourceDir}".`);
}

main().catch((err) => {
  core.setFailed(err.message);
});
```

The `for...of` loop copies sequentially. With three files that is irrelevant to runtime and keeps the failure attribution obvious.

Every early exit here is a **success** path: a missing source directory returns, and a missing source file continues. The only route to `setFailed` is a rejected `mkdir`, `copyFile`, or `getInput` — that is, something that was supposed to happen and could not.

Paired `action.yaml` change for D4:

```yaml
inputs:
  deployment-environment:
    description: "Environment to deploy."
    required: true
  path:
    description: "The publish path to copy the files to."
    required: true
```

---

## Suggested PR order

1. **D1, D2, D3, D5, D6, D7** — the rewrite above. One PR; they are the same edit and splitting them would mean landing a half-converted file.
2. **D4** — remove the input defaults. Separate, because it is the only change that can break a caller, and it wants its own rollout on `alpha` first.
3. **D8** — dependency cleanup and optional `ncc` bundling. Cosmetic; land last.

## Verification

This repository has no tests and no CI, which is why D1 and D3 have gone unnoticed. Before landing step 1, add a workflow that exercises the action against a fixture. One case per row of the behavior contract:

- **Full overlay** — `environment-files/test/` containing all three files; assert each landed at its expected destination, including `bin/site.lic` where no `bin/` existed beforehand. Exit `0`.
- **Missing environment directory** — point at an environment with no directory; assert an informational message, no annotation, and exit `0`.
- **Partial overlay** — a directory containing only `web.config`; assert it is copied, the other two are skipped without comment, and exit `0`.
- **Unwritable destination** — assert exit **non-zero** with the underlying error surfaced. This is the case that passes today and should not.

The third and fourth cases are the ones that pin the behavior contract in place; without them a future change can quietly reintroduce either failure mode.

Then confirm on `alpha` in `github-workflows` before `dev` and `sandbox` follow.
